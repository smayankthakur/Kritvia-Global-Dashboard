/** A small deterministic force layout (no dependencies): repulsion between all nodes,
 * springs along links, gentle pull to the centre. Positions are in [-1, 1]-ish units. */
export interface LayoutNode {
  id: string;
  weight?: number;
}
export interface LayoutLink {
  source: string;
  target: string;
}
export type Positions = Record<string, { x: number; y: number }>;

function seeded(i: number): number {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export function forceLayout(nodes: LayoutNode[], links: LayoutLink[], iterations = 300, pinned?: string): Positions {
  const n = nodes.length;
  const pos = nodes.map((nd, i) => {
    if (nd.id === pinned) return { x: 0, y: 0 };
    const a = (i / Math.max(n, 1)) * Math.PI * 2;
    const r = 0.3 + 0.7 * seeded(i);
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  });
  const idx = new Map(nodes.map((nd, i) => [nd.id, i]));
  const springs = links
    .map((l) => [idx.get(l.source), idx.get(l.target)] as const)
    .filter((p): p is readonly [number, number] => p[0] !== undefined && p[1] !== undefined && p[0] !== p[1]);
  const k = 1.4 / Math.sqrt(Math.max(n, 1));
  for (let it = 0; it < iterations; it++) {
    const t = 0.1 * (1 - it / iterations) + 0.005;
    const disp = pos.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i]!.x - pos[j]!.x;
        let dy = pos[i]!.y - pos[j]!.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1e-6) {
          dx = seeded(i + j) - 0.5;
          dy = seeded(i * j + 1) - 0.5;
          d2 = 1e-4;
        }
        const f = (k * k) / d2;
        disp[i]!.x += dx * f;
        disp[i]!.y += dy * f;
        disp[j]!.x -= dx * f;
        disp[j]!.y -= dy * f;
      }
    }
    for (const [a, b] of springs) {
      const dx = pos[a]!.x - pos[b]!.x;
      const dy = pos[a]!.y - pos[b]!.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1e-3;
      const f = (d * d) / k / d;
      disp[a]!.x -= dx * f;
      disp[a]!.y -= dy * f;
      disp[b]!.x += dx * f;
      disp[b]!.y += dy * f;
    }
    for (let i = 0; i < n; i++) {
      if (nodes[i]!.id === pinned) continue;
      disp[i]!.x -= pos[i]!.x * 0.6;
      disp[i]!.y -= pos[i]!.y * 0.6;
      const len = Math.sqrt(disp[i]!.x ** 2 + disp[i]!.y ** 2) || 1;
      const step = Math.min(len, t);
      pos[i]!.x += (disp[i]!.x / len) * step;
      pos[i]!.y += (disp[i]!.y / len) * step;
    }
  }
  const out: Positions = {};
  nodes.forEach((nd, i) => (out[nd.id] = pos[i]!));
  return out;
}
