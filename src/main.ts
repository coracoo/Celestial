import * as THREE from 'three';
import './styles.css';
import { audio } from './core/Audio.ts';
import { Engine } from './core/Engine.ts';
import { initPhysics } from './core/Physics.ts';
import { Rng } from './core/Rng.ts';
import { createBrowserReader, loadBundle } from './data/GameData.ts';
import type { GameDataBundle } from './data/schema.ts';
import { Profile } from './game/Profile.ts';
import { BattleScene } from './runtime/BattleScene.ts';
import { cardDescriptor } from './runtime/CardFactory.ts';
import { Showcase } from './runtime/Showcase.ts';
import type { BattleSnapshot } from './sim/types.ts';
import { on } from './ui/dom.ts';
import { Ui } from './ui/ui.ts';
import { StoryMode } from './story/StoryMode.ts';
import { PackOpening } from './ui/PackOpening.ts';
import { SkillPresentation } from './runtime/SkillPresentation.ts';

const rng = new Rng();

async function boot(): Promise<void> {
  const canvas = document.getElementById('stage') as HTMLCanvasElement;
  const uiRoot = document.getElementById('ui') as HTMLElement;
  const bootEl = document.getElementById('boot');

  // 物理初始化（解 WASM）和数据加载互不依赖，串行等于白等两倍时间：
  // 数据请求在等 WASM 编译，WASM 在等网络往返。合并成一个 Promise.all。
  const [, bundle]: [void, GameDataBundle] = await Promise.all([
    initPhysics(),
    loadBundle(createBrowserReader()),
  ]);

  const engine = new Engine(canvas);
  const profile = new Profile(['wusong', 'linchong', 'luzhishen']);
  const showcase = new Showcase(engine);

  let battle: BattleScene | null = null;
  let lastSnap: BattleSnapshot | null = null;
  // 战斗用的关卡由 profile 的战役进度决定（Ui.currentStage），
  // 不再单独维护一份 stageIndex——两份索引迟早对不上，玩家会打着一关的 Boss 看另一关的盘。
  let stageDef = bundle.stages[0]!;
  // 先声明后赋值：Ui 构造期间就会触发 onScreenChange，那时实例还没绑定
  let ui: Ui;
  let story: StoryMode;
  let pack: PackOpening;
  let storySession = false;
  let storyReadyFor: string | null = null;
  let skillPresentation: SkillPresentation;

  ui = new Ui(uiRoot, bundle, profile, {
    onStory: () => {
      storySession = true;
      storyReadyFor = null;
      showcase.hide();
      story.open();
    },
    onPull: () => doPull(),
    onDeploy: () => undefined,
    onStartBattle: () => startBattle(),
    onQuitBattle: () => goHome(),
    onSkill: (i) => {
      if (battle?.selectedSkill === i) battle.confirmSkill(i);
      else battle?.beginSkill(i);
    },
    onSkillBegin: (i) => battle?.beginSkill(i),
    onSkillConfirm: (i) => battle?.confirmSkill(i),
    onSkillCancel: () => battle?.cancelSkill(),
    onFlipper: (side, down) => battle?.pressFlipper(side, down),
    onLock: (id) => {
      const locked = battle?.toggleLock(id);
      if (locked !== undefined) toastHint(locked ? '已锁定连携：条件满足也不会自动触发' : '已解除锁定');
    },
    onFocusOpponent: (def, accent) => {
      showcase.showOpponent(def, new THREE.Color(accent).getHex());
    },
    onFocus: (id) => {
      const def = bundle.characters.find((c) => c.id === id);
      // id 为 null = 图鉴里一个已获得的武将都没有（`refreshCollection` 的兜底分支）。
      // 这时右侧摆全名册预览，别留一片黑。
      if (def) showcase.show(def, new THREE.Color(def.accent).getHex());
      else if (id === null) showcase.showRoster(bundle.characters);
    },
    onFlip: () => showcase.flip(),
    onRetry: () => {
      // 重打当前这一关。之前这里是 stageIndex+1，那是只有一关时的开发后门：
      // 12 关上线后再往前跳一关，玩家会发现「重试」把 Boss 也换掉了。
      startBattle();
    },
    onHome: () => goHome(),
    onScreenChange: () => {
      // 3D 卡牌要避开左右面板，切屏后重算一次安全取景区。
      // 无论 showcase 当前是否激活都要更新缓存：进图鉴时它还没激活，
      // 但随后点开武将就会用到这份安全区。
      if (!ui) return;
      showcase.setSafeRect(ui.safeRectFor3D());
      if (ui.screen === 'deploy' && storySession) {
        const selected = bundle.stages[ui.currentStageIndex()];
        if (selected && storyReadyFor !== selected.id) { story.playBefore(selected.id); return; }
      }
      // 图鉴进来时右侧由 `refreshCollection` 自己选好第一个已获得的武将，
      // 这里只兜底：**一个都还没有**的时候才摆全名册预览，免得右边空一大片。
      if (ui.screen === 'collection') {
        if (!showcase.isActive) {
          const owned = bundle.characters.filter((c) => profile.ownedCount(c.id) > 0);
          if (owned.length === 0) showcase.showRoster(bundle.characters);
        }
      } else {
        // 标题 / 出征 / 结算 / 战斗都收起展示台，否则上一屏的卡会浮在空背景上
        showcase.hide();
      }
    },
  });

  story = new StoryMode(uiRoot, bundle, profile, {
    onBattle: (id) => {
      if (!profile.selectStage(id, bundle.stages.map((s) => s.id))) return;
      storySession = true;
      storyReadyFor = id;
      ui.show('deploy');
    },
    onClose: () => goHome(),
  });
  pack = new PackOpening(uiRoot, {
    onTear: () => profile.pull(bundle.characters, bundle.gacha, rng),
    onReveal: (result) => {
      ui.show('collection');
      ui.focusCard(result.def.id);
      ui.toast(`${result.isNew ? '新伙伴' : '获得重复卡'} · ${result.def.name} · ${result.rarity}`);
      if (result.rarity === 'SSR' || result.rarity === 'UR') audio.link();
      else audio.slot('normal', 100);
    },
    onClose: () => undefined,
  });
  skillPresentation = new SkillPresentation(uiRoot);

  function toastHint(text: string): void {
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText =
      'position:absolute;left:50%;top:78px;transform:translateX(-50%);background:rgba(10,14,26,.9);border:1px solid rgba(150,180,240,.4);padding:8px 18px;font-size:12px;letter-spacing:.1em;border-radius:3px;z-index:60';
    uiRoot.append(el);
    window.setTimeout(() => el.remove(), 1900);
  }

  /* ------------------------------------------------------------ 抽卡 */

  function doPull(): void {
    audio.unlock();
    pack.open({ cost: bundle.gacha.costStones, stones: profile.stones });
  }

  /* ------------------------------------------------------------ 流程 */

  function goHome(): void {
    skillPresentation.hide();
    story.hide();
    storySession = false;
    storyReadyFor = null;
    battle?.dispose();
    battle = null;
    lastSnap = null;
    showcase.hide();
    ui.show('title');
  }

  function startBattle(): void {
    audio.unlock();
    const selected = bundle.stages[ui.currentStageIndex()] ?? bundle.stages[0]!;
    if (storySession && storyReadyFor !== selected.id) {
      story.playBefore(selected.id);
      return;
    }
    battle?.dispose();
    const team = profile.team
      .map((id) => bundle.characters.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => !!c);
    if (team.length === 0) {
      ui.show('deploy');
      return;
    }
    stageDef = bundle.stages[ui.currentStageIndex()] ?? bundle.stages[0]!;
    showcase.hide();

    battle = new BattleScene(engine, stageDef, team, bundle.links, {
      onSkillAim: (preview, index, slowRemaining) => ui.setSkillAim(preview, index, slowRemaining),
      onSkillEffect: (character) => skillPresentation.show(character),
      onHud: (s, control) => {
        lastSnap = s;
        ui.updateHud(s, control);
      },
      onFloat: (x, y, text, color, scale) => ui.float(x, y, text, color, scale),
      onFlash: (color, duration) => ui.flash(color, duration),
      onAim: (_angle, power, charging) => ui.setAim(power, charging),
      onFinish: (phase, snap) => {
        const cleared = phase === 'victory';
        profile.recordRun(cleared, snap.totalDamage);
        const reward = cleared ? stageDef.rules.reward : null;
        if (reward) profile.grant(reward);
        // 通关要记进战役进度，否则下一关永远不解锁
        if (cleared) profile.recordClear(stageDef.id);
        audio.setEnabled(false);
        window.setTimeout(() => audio.setEnabled(true), 400);
        ui.showResult(phase, snap, reward);
        if (cleared && storySession) story.playAfter(stageDef.id, () => undefined);
      },
    });

    ui.mountBattle(team, bundle.links.filter((l) => l.members.every((m) => team.some((c) => c.id === m))), stageDef.rules.balls);
  }

  /* ------------------------------------------------------------ 输入 */

  let pointerDown = false;
  let skillBoardPointer: number | null = null;
  const skillKeys = new Set<string>();

  on(window, 'pointerdown', (e) => {
    if (!e.isPrimary) return;
    if (e.button === 2 && ui.inBattle) {
      battle?.cancelSkill();
      battle?.cancelCharging();
      return;
    }
    if (e.button !== 0) return;
    audio.unlock();
    const t = e.target as HTMLElement;
    if (t.closest('button, details, .hud-left, .hud-right, .boss-bar, .btn, .skill, .link-chip, .dash-btn, .modal, .tile, .stage-card, .card-modal')) return;
    if (ui.inBattle && battle?.isAimingSkill) {
      battle.setPointer(e.clientX, e.clientY);
      skillBoardPointer = e.pointerId;
      return;
    }
    pointerDown = true;
    if (ui.inBattle) {
      battle?.setPointer(e.clientX, e.clientY);
      battle?.setCharging(true);
    }
  });

  on(window, 'resize', () => {
    showcase.setSafeRect(ui.safeRectFor3D());
  });

  on(window, 'pointerup', (e) => {
    if (!e.isPrimary) return;
    pointerDown = false;
    if (skillBoardPointer === e.pointerId) {
      skillBoardPointer = null;
      if (ui.inBattle && battle?.isAimingSkill) {
        battle.setPointer(e.clientX, e.clientY);
        battle.confirmSkill();
      }
      return;
    }
    if (ui.inBattle) battle?.setCharging(false);
  });
  on(window, 'pointercancel', () => {
    pointerDown = false;
    skillBoardPointer = null;
    battle?.cancelSkill();
    battle?.cancelCharging();
  });
  window.addEventListener('blur', () => {
    pointerDown = false;
    skillBoardPointer = null;
    skillKeys.clear();
    battle?.cancelSkill();
    battle?.cancelCharging();
  });
  on(window, 'contextmenu', (e) => { if (ui.inBattle) e.preventDefault(); });

  on(window, 'pointermove', (e) => {
    if (!e.isPrimary) return;
    if (ui.inBattle) {
      if (document.elementFromPoint(e.clientX, e.clientY)?.closest('button, details, .hud-left, .hud-right, .boss-bar, .modal')) return;
      battle?.setPointer(e.clientX, e.clientY);
    } else if (showcase.isActive) {
      // 指针映射和悬停判定都在 Showcase 内部按**卡面**的屏幕矩形做：
      // 用整屏归一化的话，鼠标还离卡半米就已经把卡推到底了。
      showcase.setPointer(e.clientX, e.clientY);
    }
  });

  // 指针离开窗口：动态光源停在原地会一直亮着，回来时突兀
  on(window, 'pointerleave', () => showcase.setHover(false));

  on(window, 'click', (e) => {
    if (pointerDown) return;
    const t = e.target as HTMLElement;
    // .tile / .stage-card / .card-modal 必须排掉：点瓦片选武将、点关卡卡进盘、点按钮开弹窗，
    // 都不该顺带把 3D 卡翻到背面去。
    // 还要排掉 button 本身：图鉴台的「翻 面」是 class="stage-btn"（不在下面的类名表里），
    // 它自己有 data-act="flip"。不排的话点一次会翻两次——面板翻一次、这里再翻一次，
    // 两次互相抵消，按钮看起来就是坏的。
    if (t.closest('button, .btn, .skill, .link-chip, .dash-btn, .modal, .sheet, .hud, .tile, .stage-card, .card-modal')) return;
    if (showcase.isActive) showcase.flip();
  });

  on(window, 'keydown', (e) => {
    audio.unlock();
    if (!ui.inBattle || !battle) return;
    const control = (e.target as HTMLElement).closest?.('button, summary, input, textarea, select');
    if (control && control.getClientRects().length && e.code !== 'Escape' &&
      (control.matches('input, textarea, select') || e.code === 'Space' || e.code === 'Enter')) return;
    if (e.code === 'ArrowLeft') {
      battle.nudgeAim(-2.4);
      e.preventDefault();
    } else if (e.code === 'ArrowRight') {
      battle.nudgeAim(2.4);
      e.preventDefault();
    } else if (e.code === 'Space') {
      battle.setCharging(true);
      e.preventDefault();
    } else if (/^Digit[123]$/.test(e.code)) {
      if (!e.repeat) {
        skillKeys.add(e.code);
        const slot = battle.activeSkillSlot(Number(e.code.slice(-1)) - 1);
        if (slot >= 0) battle.beginSkill(slot);
      }
      e.preventDefault();
    }
    else if (e.code === 'Enter' && battle.isAimingSkill) battle.confirmSkill();
    /*
     * Z / X = 底部左右翻板。**按住不放**板就停在弹起位（和真弹球一样），
     * 所以这里走的是 keydown + keyup 两条线，不是「按一下触发一次」。
     *
     * 旧的 Q 键「聚气冲击」在这次改造里删掉了：它和翻板抢同一个定位
     * （「给球一次额外的力」），两件事只能留一个，而能瞄准、能预判的那个
     * 才是弹珠游戏的操作。聚气本身没消失，改成了能量满自动放的组合技。
     */
    else if (e.code === 'KeyZ' || e.code === 'KeyX') {
      battle.pressFlipper(e.code === 'KeyZ' ? 'left' : 'right', true);
      e.preventDefault();
    }
    else if (e.code === 'Escape') {
      if (!battle.cancelSkill()) goHome();
      skillBoardPointer = null;
      skillKeys.clear();
    }
  });

  on(window, 'keyup', (e) => {
    if (/^Digit[123]$/.test(e.code) && skillKeys.delete(e.code)) {
      // 必须和 keydown 走同一个映射：按下时算出的槽位和松开时重算的必须一致，
      // 否则会出现「按 1 瞄准了武松、松手却确认了林冲」。
      if (ui.inBattle) {
        const slot = battle?.activeSkillSlot(Number(e.code.slice(-1)) - 1) ?? -1;
        if (slot >= 0) battle?.confirmSkill(slot);
      }
      e.preventDefault();
    }
    if (e.code === 'Space' && ui.inBattle) {
      battle?.setCharging(false);
      e.preventDefault();
    }
    if (e.code === 'KeyZ' || e.code === 'KeyX') {
      battle?.pressFlipper(e.code === 'KeyZ' ? 'left' : 'right', false);
      e.preventDefault();
    }
  });

  /* ------------------------------------------------------------ 循环 */

  engine.onFixed((dt) => {
    battle?.fixedStep(dt);
  });

  engine.onFrame((dt, time) => {
    if (battle && ui.inBattle) {
      battle.frame(dt, time);
    } else {
      showcase.update(dt, time);
      if (lastSnap && ui.screen === 'result') {
        // 结算时保留盘面作为背景，不再推进物理
        void lastSnap;
      }
    }
  });

  engine.start();
  if (bootEl) {
    bootEl.classList.add('gone');
    window.setTimeout(() => bootEl.remove(), 600);
  }

  // 供自动化验收使用的调试入口
  (window as unknown as Record<string, unknown>).__celestial = {
    engine,
    profile,
    ui,
    showcase,
    get battle() {
      return battle;
    },
    startBattle,
    goHome,
    doPull,
    snapshot: () => lastSnap,
    cardSchemas: bundle.characters.map((c) => cardDescriptor(c)),
    bundle,
    THREE,
  };
}

boot().catch((err) => {
  console.error(err);
  const bootEl = document.getElementById('boot');
  if (!bootEl) return;
  // 启动失败页是**唯一**一次能对玩家解释发生了什么的机会。
  // 只印 `String(err)` 等于把 `TypeError: Failed to fetch` 丢给人看：
  // 哪个文件、服务起没起、该不该刷新，一概不知道。实机撞过一次，
  // 屏幕上就这一行红字，别的什么都没有。
  const msg = err instanceof Error ? err.message : String(err);
  bootEl.innerHTML = `<div style="max-width:660px;padding:26px 30px;color:#ff8ea3;font-size:13px;line-height:1.9">
    <b style="font-size:19px;letter-spacing:.06em">启动失败</b><br>
    <span style="display:inline-block;margin:10px 0 14px;padding:8px 12px;border:1px solid rgba(255,110,140,.35);
      border-radius:3px;background:rgba(255,110,140,.08);font-family:ui-monospace,Menlo,Consolas,monospace;
      font-size:12px;word-break:break-all">${msg}</span><br>
    <span style="color:#c9b6bd">这通常是开发服务器没在跑，或者刚好在它重启的间隙里打开了页面。<br>
    先在项目目录执行 <code style="color:#ffd24a">npm run dev</code>，等它打印出地址，再刷新这一页。</span>
    <br><button data-act="boot-retry" style="margin-top:16px;padding:8px 20px;cursor:pointer;
      background:rgba(255,140,160,.12);border:1px solid rgba(255,140,160,.5);color:#ffc2cd;border-radius:3px;
      font:inherit;font-size:13px;letter-spacing:.08em">重新加载</button>
  </div>`;
  bootEl.querySelector('[data-act="boot-retry"]')?.addEventListener('click', () => window.location.reload());
});
