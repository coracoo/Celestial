import catalog from '../../public/data/opponents.json' with { type: 'json' };
import { opponentLayers, type OpponentLayers } from './EnemyCards.ts';

export interface BossCardDef {
  id: string;
  name: string;
  title: string;
  stageId: string;
  weapon: string;
  description: string;
  portrait: string;
  art: string;
  layers: OpponentLayers;
}

export const BOSS_CARD_LIST: BossCardDef[] = catalog.bosses.map((entry) => {
  const layers = opponentLayers(entry.id);
  return { ...entry, layers, portrait: `art/opponents/${entry.id}/portrait.webp`, art: `art/opponents/${entry.id}/card.webp` };
});

export function bossCardFor(id: string): BossCardDef | undefined {
  return BOSS_CARD_LIST.find((def) => def.id === id);
}
