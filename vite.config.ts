import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { defineConfig, type Plugin } from 'vite';

/** 找 python。Windows 上 `python` 常是 Microsoft Store 的占位符，真身可能只在
 *  py 启动器里，所以按这个顺序试；都找不到就退回 'python'，让 spawn 报错、
 *  由 rebuild 端点把错误原样报回工作台，而不是在这里静默失败。 */
const PYTHON = (() => {
  for (const c of ['python', 'py', 'python3']) {
    try {
      // spawnSync 才拿得到 exit status；spawn 是异步的，status 恒为 null。
      const probe = spawnSync(c, ['-c', 'pass'], { stdio: 'ignore', windowsHide: true });
      if (!probe.error && probe.status === 0) return c;
    } catch { /* 试下一个 */ }
  }
  return 'python';
})();

/** 抠图工作台只认这三个文件名。写盘目标固定是 cards/<id>/<name>，
 *  不给客户端任何拼路径的自由——否则一次手滑就是覆盖整张 source PNG 或跑出目录。 */
const CUTOUT_WRITABLE = new Set(['source.png', 'matte.png', 'placement.json']);
const CUTOUT_BODY_LIMIT = 96 * 1024 * 1024;

/** dev server 上的「一键写回」：POST /__cutout/write/<id>/<name>，body 是原始字节。
 *
 *  为什么需要它：工作台的导出按钮只会触发浏览器下载，落到「下载」目录里，
 *  文件名还带 <id>- 前缀，要人工改名再搬进 cards/<id>/——正是最容易被忘掉的一步，
 *  而忘了的后果是「我明明存了怎么没生效」。
 *
 *  边界（都写死在这里，不接受客户端参数）：
 *  - apply:'serve'：build 产物里没有这个插件，打包后访问不到任何写盘能力
 *  - server.host 绑 127.0.0.1，不对外暴露
 *  - id 必须是 public/data/characters/<id>.json 里真实存在的角色，
 *    顺带把 ../ 和大小写以外的字符挡掉
 *  - name 必须在 CUTOUT_WRITABLE 白名单里
 *  - 落位是 path.join(root, 'cards', id, name)，join 会吃掉分隔符，穿不出去
 *  - 任何一项不满足都回 404，客户端据此退回浏览器下载，不会静默写错地方
 */
function cutoutWriteBack(root: string): Plugin {
  return {
    name: 'cutout-write-back',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        let pathname: string;
        try {
          pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
        } catch {
          res.statusCode = 404;
          res.end();
          return;
        }

        const known = (id: string) =>
          /^[a-z0-9_-]+$/.test(id) &&
          fs.existsSync(path.join(root, 'public', 'data', 'characters', `${id}.json`));

        /* --- 读：/cards/<id>/<这三个文件> 自己接管，不用 vite 的静态服务 ---
         *
         * 为什么要插这一刀：静态服务是用流（createReadStream）发文件的。浏览器
         * 中途被关掉是常事（关标签、崩溃、探针 kill），客户端一断，流的 fd 就
         * 留在服务端不释放，于是这个文件被永久占住——工作台上「恢复默认源图」
         * 和「删掉这个文件就回到默认」就都成了空话。
         *
         * 整读进内存再 res.end(buf)，fd 在函数返回时就关了，不存在半途泄漏。
         * 这三个文件正是工作台会反复读的那几个，其余一律交给静态服务。
         */
        const read = /^\/cards\/([^/]+)\/([^/]+)$/.exec(pathname);
        if (read && req.method === 'GET') {
          const [, id, name] = read;
          if (!CUTOUT_WRITABLE.has(name)) return next();
          const file = known(id) ? path.join(root, 'cards', id, name) : '';
          if (!file || !fs.existsSync(file)) {
            /* 必须在这里自己回 404，不能 next() 放行。
             * 放行之后落进 vite 的 SPA 兜底：它对任何路径都回 200 + index.html。
             * 客户端于是拿到一段 HTML，fetchImage() 里的 createImageBitmap 抛
             * InvalidStateError —— 「这张卡没有 matte.png」是绝大多数卡的常态，
             * 所以这等于让读回蒙版这条路径在大多数卡上直接炸掉。
             * 源图那条路是靠调用点的 try/catch 侥幸没炸，但那不是设计。 */
            res.statusCode = 404;
            // 必须给 Content-Length: 0。不给的话 Node 走的是 chunked 结束，
            // Chrome 把这个 404 记成 Network.loadingFailed（net::ERR_*）而不是
            // 一次正常的 404 —— 于是「可选文件不存在」在探针里长成了网络故障。
            res.setHeader('Content-Length', '0');
            res.end();
            return undefined;
          }
          const buf = fs.readFileSync(file);
          res.statusCode = 200;
          res.setHeader('Content-Type', name.endsWith('.json') ? 'application/json' : 'image/png');
          res.setHeader('Content-Length', String(buf.length));
          res.setHeader('Cache-Control', 'no-store');
          res.end(buf);
          return undefined;
        }

        const m = /^\/__cutout\/write\/([^/]+)\/([^/]+)$/.exec(pathname);
        if (!m) return next();

        const fail = (why: string) => {
          res.statusCode = 404;
          res.end(JSON.stringify({ ok: false, error: why }));
        };

        if (req.method !== 'POST') return fail('only POST');
        const [, id, name] = m;
        if (!/^[a-z0-9_-]+$/.test(id)) return fail('bad id');
        if (!CUTOUT_WRITABLE.has(name)) return fail('bad name');
        if (!known(id)) return fail('unknown character');

        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => {
          size += c.length;
          if (size > CUTOUT_BODY_LIMIT) {
            fail('too large');
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        req.on('end', () => {
          if (res.writableEnded) return;
          const target = path.join(root, 'cards', id, name);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, Buffer.concat(chunks));
          server.config.logger.info(`  \x1b[36m➜\x1b[0m  ${name}  ←  ${id}  (${size} bytes)`);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, path: `cards/${id}/${name}`, bytes: size }));
        });
        req.on('error', () => fail('read error'));
        return undefined;
      });

      /* --- 恢复默认：DELETE /__cutout/source/<id> 删掉 cards/<id>/source.png ---
       *
       * 为什么不让用户自己去资源管理器删：这个文件可能被浏览器或本进程短暂持有，
       * 手删经常撞上「文件正在使用中」。而且删这件事本身是工作台的一部分操作，
       * 和「存为」成对放在同一个面板里才说得通。删不掉就如实回报，别假装成功。
       */
      server.middlewares.use((req, res, next) => {
        let pathname: string;
        try {
          pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
        } catch {
          return next();
        }
        const m = /^\/__cutout\/source\/([^/]+)$/.exec(pathname);
        if (!m) return next();

        const [, id] = m;
        const bad = (why: string) => {
          res.statusCode = 404;
          res.end(JSON.stringify({ ok: false, error: why }));
        };
        if (req.method !== 'DELETE') return bad('only DELETE');
        if (!/^[a-z0-9_-]+$/.test(id)) return bad('bad id');
        if (!fs.existsSync(path.join(root, 'public', 'data', 'characters', `${id}.json`)))
          return bad('unknown character');

        // ?what 决定删哪些，互斥，绝不连坐：
        //   缺省      → 只删 source.png（恢复默认源图）
        //   placement → 只删 placement.json（恢复默认落位）
        //   both      → 两个都删
        // 「恢复默认落位」这个按钮尤其不能碰 source.png：用户可能刚存了一张自己抠好的全身图，
        // 点一下落位却把图删了，那就是不可逆的数据损失。placement.json 本身更阴险——
        // 它只改一个 scale 数，管线就读着把角色缩到 70% 缩回卡面中央，四面都不出血，
        // 而画面上看不出「为什么」。所以用户得自己有一条路把它删掉。
        const what = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('what') ?? 'source';
        const dir = path.join(root, 'cards', id);
        const targets = what === 'both'
          ? [
            { file: path.join(dir, 'source.png'), label: 'source.png' },
            { file: path.join(dir, 'placement.json'), label: 'placement.json' },
          ]
          : what === 'placement'
            ? [{ file: path.join(dir, 'placement.json'), label: 'placement.json' }]
            : [{ file: path.join(dir, 'source.png'), label: 'source.png' }];

        const removed: string[] = [];
        for (const t of targets) {
          if (!fs.existsSync(t.file)) continue;
          try {
            fs.unlinkSync(t.file);
            removed.push(t.label);
          } catch (e) {
            res.statusCode = 409;
            res.end(JSON.stringify({ ok: false, error: `删不掉 ${t.label}，可能正被占用：${(e as Error).message}` }));
            return undefined;
          }
        }
        if (removed.length) {
          server.config.logger.info(`  \x1b[33m➜\x1b[0m  ${removed.join(' + ')}  ✕  ${id}`);
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, removed: removed.length > 0, files: removed }));
        return undefined;
      });
    /* --- 重新生成：POST /__cutout/rebuild/<id> ---
       *
       * 为什么必须有这一步：source.png 是**原料**，游戏吃的是
       * public/art/{layers,cards,thumbs,portraits}/ 下的产物，中间隔着
       * scripts/prepare_cards.py。以前只有「存」没有「生成」，于是工作台里
       * 是新图、游戏里是老图，还要人自己记得跑命令、记得硬刷新。
       * 「存 = 生效」才配叫一键。
       *
       * 只跑选中那几张（--ids），不碰其他 35 张；串行执行并回传 stderr 的
       * 最后几行——脚本失败时那句 RuntimeError 才是有用的信息。
       */
      server.middlewares.use((req, res, next) => {
        let pathname: string;
        try {
          pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
        } catch {
          return next();
        }
        const m = /^\/__cutout\/rebuild\/([^/]+)$/.exec(pathname);
        if (!m) return next();

        const [, id] = m;
        // 一律 404：另外两条路由（write / source）也是 404，
        // 同一个插件里两种状态码，客户端就没法用「非 2xx 即失败」统一处理。
        const bad = (why: string, code = 404) => {
          res.statusCode = code;
          res.end(JSON.stringify({ ok: false, error: why }));
        };
        if (req.method !== 'POST') return bad('only POST');
        if (!/^[a-z0-9_-]+$/.test(id)) return bad('bad id');
        if (!fs.existsSync(path.join(root, 'public', 'data', 'characters', `${id}.json`)))
          return bad('unknown character');

        const log = server.config.logger;
        log.info(`  \x1b[36m➜\x1b[0m  重新生成 ${id} …`);
        const child = spawn(
          process.execPath === '' ? 'python' : PYTHON,
          ['-X', 'utf8', path.join(root, 'scripts', 'prepare_cards.py'), '--ids', id],
          { cwd: root, windowsHide: true },
        );
        let out = '';
        child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
        child.on('error', (e) => {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, error: `起不来 python：${e.message}` }));
        });
        child.on('close', (code) => {
          const lines = out.trim().split(/\r?\n/).filter(Boolean);
          const tail = lines.slice(-6);
          if (code === 0) {
            log.info(`  \x1b[32m✓\x1b[0m  ${id} 四套资源已更新`);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, id, log: tail }));
          } else {
            log.error(`  \x1b[31m✗\x1b[0m  ${id} 失败（exit ${code}）`);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: `prepare_cards 退出码 ${code}`, log: tail }));
          }
        });
        return undefined;
      });
    },
  };
}

/** 构建前真的把 dist/ 清空。
 *
 *  为什么要自己来：build.emptyOutDir 在这台机器上不起作用——实测从 public/ 删掉
 * 一个文件再构建，它仍然躺在 dist/ 里。Windows 上 unlink 会返回成功而文件名赖着
 * 不走，vite 清目录时被挂起的句柄一挡就静悄悄地跳过了。
 *
 *  后果不是「多占点磁盘」：public/art/layers 里删掉 subject.png（角色合并成一张
 *  纹理之后就不再发布它）之后，dist/ 里那 36 份陈旧副本会一直在部署包里，
 *  88MB 的死文件，而且没有任何地方会提醒你。
 *
 *  轮询重试是为了对付「删除挂起」：第一次删不掉，等句柄释放后再删。
 */
function cleanOutDir(root: string): Plugin {
  const dist = path.join(root, 'dist');
  return {
    name: 'clean-dist',
    apply: 'build',
    buildStart() {
      if (!fs.existsSync(dist)) return;
      const leftovers: string[] = [];
      for (let attempt = 0; attempt < 12; attempt++) {
        leftovers.length = 0;
        // 逐个删而不是一次性 rmSync(dist)：整目录删失败时不会告诉你到底哪个文件卡住。
        const walk = (dir: string): void => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.isFile()) leftovers.push(p);
          }
        };
        walk(dist);
        if (!leftovers.length) return;
        for (const f of leftovers) {
          try { fs.unlinkSync(f); } catch { /* 占用中，留到下一轮 */ }
        }
        try {
          if (!fs.readdirSync(dist).length) fs.rmdirSync(dist);
          return;
        } catch { /* 还有东西没删干净 */ }
        sleepSync(250);
      }
      if (leftovers.length) {
        throw new Error(
          `dist/ 清不掉，还有 ${leftovers.length} 个文件被占用`
          + `（第一个：${leftovers[0]}）。关掉正在读它的进程再构建，`
          + '否则删掉的资产会一直留在部署包里。');
      }
    },
  };
}

/** 同步睡一下。buildStart 是同步钩子，用不了 setTimeout 的异步版。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export default defineConfig({
  base: './',
  plugins: [cleanOutDir(process.cwd()), cutoutWriteBack(process.cwd())],
  server: {
    host: '127.0.0.1',
    port: 5173,
    // 不排除的话 dev server 会在整个项目根上建监听，而项目根里有近 1.5GB
    // 的生成物：cards/ 890MB（RuiC 每卡工作区）、立绘/ 236MB（源 PNG）、
    // dist/ 254MB（build 产物）、.git/ 168MB。实测后果是每生成一张卡、
    // 每跑一次 npm run build，正在调试的页面就整页 reload 一次。
    // vite 默认只排除 node_modules 和 .git，其余必须自己列。
    watch: {
      ignored: ['**/cards/**', '**/立绘/**', '**/dist/**', '**/.git/**', '**/shots/**'],
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    chunkSizeWarningLimit: 4096,
    // 历次构建的带哈希产物必须清掉：不清的话 dist/assets 会越堆越多，
    // 打包产物几百 MB，而线上真正用到的只有 index.html 里引用的那一个。
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Three.js 和 Rapier（WASM 以 base64 内联，本身就有 2MB）各占一大块，
        // 和业务代码挤在同一个 4MB chunk 里：既超了 Vite 的告警线，
        // 也让首屏必须等整包下载+解析完才能开始。拆开后它们是并行请求，
        // 且各自可长期缓存——业务代码改动不必让玩家重下这两个大块。
        manualChunks: {
          three: ['three'],
          rapier: ['@dimforge/rapier2d-compat'],
        },
      },
    },
  },
});
