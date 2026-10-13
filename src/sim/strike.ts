import type { PegDef, StrikeSpec } from '../data/schema.ts';

export type StrikePrimitive =
  | { shape: 'line'; x: number; y: number; halfLength: number; halfWidth: number; angleDeg: number }
  | { shape: 'circle'; x: number; y: number; radius: number };

/** Both rendering and collision queries consume these same world-space shapes. */
export function buildStrikePrimitives(spec: StrikeSpec, x: number, y: number, aimDeg = 90): StrikePrimitive[] {
  if (spec.shape === 'circle') return [{ shape: 'circle', x, y, radius: spec.radius }];
  const angleDeg = (spec.angleDeg ?? 90) + aimDeg - 90;
  const radians = angleDeg * Math.PI / 180;
  const count = Math.max(1, Math.min(8, Math.floor(spec.repeat?.times ?? 1)));
  return Array.from({ length: count }, (_, i) => {
    const offset = (i - (count - 1) / 2) * (spec.repeat?.offset ?? 0);
    return { shape: 'line', x: x - Math.sin(radians) * offset, y: y + Math.cos(radians) * offset,
      halfLength: spec.radius, halfWidth: spec.halfWidth ?? .5, angleDeg };
  });
}

function intersects(shape: StrikePrimitive, peg: PegDef): boolean {
  const dx = peg.x - shape.x, dy = peg.y - shape.y;
  if (shape.shape === 'circle') return dx * dx + dy * dy <= (shape.radius + peg.r) ** 2 + 1e-10;
  const angle = shape.angleDeg * Math.PI / 180;
  const along = Math.abs(dx * Math.cos(angle) + dy * Math.sin(angle));
  const across = Math.abs(-dx * Math.sin(angle) + dy * Math.cos(angle));
  // Rounded rectangle/circle intersection, not an expanded bounding box at corners.
  return Math.max(0, along - shape.halfLength) ** 2 + Math.max(0, across - shape.halfWidth) ** 2 <= peg.r ** 2 + 1e-10;
}

export function pegsInStrike(spec: StrikeSpec, pegs: readonly PegDef[], x: number, y: number, aimDeg = 90): PegDef[] {
  const shapes = buildStrikePrimitives(spec, x, y, aimDeg);
  return pegs.filter((p) => spec.kinds.includes(p.kind) && shapes.some((shape) => intersects(shape, p)));
}
