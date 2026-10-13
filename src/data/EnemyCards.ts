import catalog from '../../public/data/opponents.json' with { type: 'json' };
import type { Wuxing } from './schema.ts';

export interface OpponentLayers { subject: string; background: string; frame: string }
export interface EnemyCardDef {
  id: string;
  name: string;
  wuxing: Wuxing;
  art: string;
  portrait: string;
  layers: OpponentLayers;
  weapon: string;
  description: string;
}

export function opponentLayers(id: string): OpponentLayers {
  const root = `art/opponents/${id}`;
  const element = catalog.minions.find((entry) => entry.id === id)?.wuxing ?? 'boss';
  return { subject: `${root}/subject.webp`, background: `art/opponents/shared/${element}-background.webp`,
    frame: `art/opponents/shared/${element}-frame.webp` };
}

export const ENEMY_CARD_LIST: EnemyCardDef[] = catalog.minions.map((entry) => {
  const layers = opponentLayers(entry.id);
  return { ...entry, wuxing: entry.wuxing as Wuxing, layers, portrait: `art/opponents/${entry.id}/portrait.webp`,
    art: `art/opponents/${entry.id}/card.webp` };
});

export const ENEMIES_BY_ELEMENT = Object.fromEntries(
  (['metal', 'wood', 'water', 'fire', 'earth'] as const).map((wuxing) =>
    [wuxing, ENEMY_CARD_LIST.filter((def) => def.wuxing === wuxing)]),
) as Record<Wuxing, EnemyCardDef[]>;

/** The five established identities remain the introductory defaults. */
export const ENEMY_CARDS = Object.fromEntries(Object.entries(ENEMIES_BY_ELEMENT)
  .map(([wuxing, cards]) => [wuxing, cards[0]!])) as Record<Wuxing, EnemyCardDef>;

export function enemyCardFor(wuxing?: Wuxing, enemyId?: string): EnemyCardDef {
  const element = ENEMIES_BY_ELEMENT[wuxing as Wuxing] ? wuxing! : 'metal';
  return ENEMIES_BY_ELEMENT[element].find((def) => def.id === enemyId) ?? ENEMY_CARDS[element];
}

/** Recovery retains this identity; chapter one keeps the five familiar portraits. */
export function enemyCardForStage(wuxing: Wuxing, stageId: string, ordinal: number): EnemyCardDef {
  const group = ENEMIES_BY_ELEMENT[wuxing] ?? ENEMIES_BY_ELEMENT.metal;
  const chapter = Math.max(1, Number(stageId.match(/(\d+)$/)?.[1]) || 1);
  return group[(chapter - 1 + Math.max(0, Math.floor(ordinal))) % group.length]!;
}
