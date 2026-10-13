export interface TrajectoryInput {
  x: number; y: number; vx: number; vy: number; gravity: number; radius: number;
  restitution: number; damping: number; ax?: number;
  pegs: readonly { x: number; y: number; r: number }[];
  walls: readonly { x: number; y: number; w: number; h: number; rotDeg: number }[];
  stops?: readonly { x: number; y: number; w: number; h: number }[];
}
export interface TrajectoryResult { points: { x: number; y: number }[]; bounces: number }

/** A short deterministic aiming guide. The live Rapier world remains authoritative. */
export function predictTrajectory(input: TrajectoryInput): TrajectoryResult {
  const dt = 1 / 120;
  let { x, y, vx, vy } = input;
  const points = [{ x, y }];
  let bounces = 0;
  const walls = input.walls.map((wall) => ({ ...wall,
    cos: Math.cos(wall.rotDeg * Math.PI / 180), sin: Math.sin(wall.rotDeg * Math.PI / 180) }));
  const reflect = (nx: number, ny: number): void => {
    const toward = vx * nx + vy * ny;
    if (toward >= 0) return;
    vx -= (1 + input.restitution) * toward * nx;
    vy -= (1 + input.restitution) * toward * ny;
    bounces++;
  };
  for (let step = 0; step < 180; step++) {
    vx = (vx + (input.ax ?? 0) * dt) / (1 + input.damping * dt);
    vy = (vy + input.gravity * dt) / (1 + input.damping * dt);
    x += vx * dt;
    y += vy * dt;
    const before = bounces;
    for (const peg of input.pegs) {
      const dx = x - peg.x;
      const dy = y - peg.y;
      const distance = Math.hypot(dx, dy);
      const radius = input.radius + peg.r;
      if (distance >= radius) continue;
      const nx = distance > 0.0001 ? dx / distance : 0;
      const ny = distance > 0.0001 ? dy / distance : 1;
      x = peg.x + nx * (radius + 0.002);
      y = peg.y + ny * (radius + 0.002);
      reflect(nx, ny);
    }
    for (const wall of walls) {
      const dx = x - wall.x;
      const dy = y - wall.y;
      let lx = dx * wall.cos + dy * wall.sin;
      let ly = -dx * wall.sin + dy * wall.cos;
      const cx = Math.max(-wall.w, Math.min(wall.w, lx));
      const cy = Math.max(-wall.h, Math.min(wall.h, ly));
      const distance = Math.hypot(lx - cx, ly - cy);
      if (distance >= input.radius) continue;
      let nx: number;
      let ny: number;
      if (distance > 0.0001) {
        nx = (lx - cx) / distance; ny = (ly - cy) / distance;
        lx = cx + nx * (input.radius + 0.002); ly = cy + ny * (input.radius + 0.002);
      } else if (wall.w - Math.abs(lx) < wall.h - Math.abs(ly)) {
        nx = lx >= 0 ? 1 : -1; ny = 0; lx = nx * (wall.w + input.radius + 0.002);
      } else {
        nx = 0; ny = ly >= 0 ? 1 : -1; ly = ny * (wall.h + input.radius + 0.002);
      }
      x = wall.x + lx * wall.cos - ly * wall.sin;
      y = wall.y + lx * wall.sin + ly * wall.cos;
      reflect(nx * wall.cos - ny * wall.sin, nx * wall.sin + ny * wall.cos);
    }
    if (step % 3 === 0 || bounces !== before) points.push({ x, y });
    const settled = input.stops?.some((s) => Math.abs(x - s.x) < s.w / 2 && Math.abs(y - s.y) < s.h / 2);
    if (settled || bounces >= 6) break;
  }
  points.push({ x, y });
  return { points, bounces };
}
