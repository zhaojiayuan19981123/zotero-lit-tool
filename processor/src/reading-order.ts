import type { Box } from "./layout";

// Keep the model's order between columns; impose top-to-bottom constraints only
// where blocks share a horizontal reading lane. A spanning heading links both lanes.
export function orderPageBlocks<T extends { bounds: Box }>(blocks: T[]): T[] {
  const after = blocks.map(() => [] as number[]),
    incoming = blocks.map(() => 0);
  for (let i = 0; i < blocks.length; i++)
    for (let j = 0; j < blocks.length; j++) {
      if (i === j) continue;
      const a = blocks[i].bounds,
        b = blocks[j].bounds;
      const shared = Math.max(
        0,
        Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
      );
      if (shared / Math.min(a.width, b.width) >= 0.6 && a.y + a.height <= b.y) {
        after[i].push(j);
        incoming[j]++;
      }
    }
  const result: T[] = [],
    used = new Set<number>();
  while (result.length < blocks.length) {
    const index = blocks.findIndex((_, i) => !used.has(i) && incoming[i] === 0);
    // Invalid/overlapping geometry must never drop a block.
    if (index < 0) return blocks;
    used.add(index);
    result.push(blocks[index]);
    for (const next of after[index]) incoming[next]--;
  }
  return result;
}
