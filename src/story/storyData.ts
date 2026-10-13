/**
 * 剧情对白的推进器，以及剧情数据相关的类型转发。
 *
 * 章节内容本身**不在这里**——它走 `public/data/story.json`，由 `loadBundle` 读进
 * `GameDataBundle.story`。原因见 schema.ts 里 `StoryChapter` 的注释：整份章节表写死在
 * TS 里会让「加一关只加数据」这条硬约束失效，而且新关会静默地没有剧情入口。
 *
 * 所以这个文件现在只剩两件事：把类型转发出去，以及 `DialogueRun` 这个状态机。
 */
import type { StoryChapter, StoryLine } from '../data/schema.ts';

export type { StoryChapter, StoryLine };

/** One dialogue session owns one continuation; cancellation never starts a battle. */
export class DialogueRun {
  index = 0;
  private finished = false;
  readonly lines: readonly StoryLine[];
  private readonly onDone: () => void;
  constructor(lines: readonly StoryLine[], onDone: () => void) { this.lines = lines; this.onDone = onDone; }
  get current(): StoryLine | undefined { return this.lines[this.index]; }
  advance(): void {
    if (this.finished) return;
    this.index++;
    if (this.index >= this.lines.length) this.skip();
  }
  skip(): void {
    if (this.finished) return;
    this.finished = true;
    this.onDone();
  }
  cancel(): void { this.finished = true; }
}
