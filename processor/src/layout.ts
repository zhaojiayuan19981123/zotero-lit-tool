import { orderPageBlocks } from "./reading-order";
export const labels = [
  "abstract",
  "algorithm",
  "aside_text",
  "chart",
  "content",
  "display_formula",
  "doc_title",
  "figure_title",
  "footer",
  "footer_image",
  "footnote",
  "formula_number",
  "header",
  "header_image",
  "image",
  "inline_formula",
  "number",
  "paragraph_title",
  "reference",
  "reference_content",
  "seal",
  "table",
  "text",
  "vertical_text",
  "vision_footnote",
] as const;
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Region {
  label: string;
  confidence: number;
  order: number;
  bounds: Box;
}
export interface TextSpan {
  text: string;
  bounds: Box;
}
export const isAsset = (label: string) =>
  ["chart", "image", "table", "display_formula", "inline_formula"].includes(
    label,
  );
export function intersection(a: Box, b: Box) {
  return (
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  );
}
// Match PaddleX postprocessing: confidence filtering and per-class/cross-class NMS.
export function decodeRegions(
  data: ArrayLike<number>,
  width: number,
  height: number,
): Region[] {
  const boxes: Region[] = [];
  for (let i = 0; i + 6 < data.length; i += 7) {
    const [cls, confidence, x1, y1, x2, y2, order] = Array.from(
      { length: 7 },
      (_, n) => Number(data[i + n]),
    );
    if (
      ![cls, confidence, x1, y1, x2, y2, order].every(Number.isFinite) ||
      confidence < 0.5 ||
      !labels[cls]
    )
      continue;
    const x = Math.max(0, Math.min(1, x1 / width));
    const y = Math.max(0, Math.min(1, y1 / height));
    const bounds = {
      x,
      y,
      width: Math.max(0, Math.min(1, x2 / width) - x),
      height: Math.max(0, Math.min(1, y2 / height) - y),
    };
    if (bounds.width <= 0 || bounds.height <= 0) continue;
    if (labels[cls] === "image" && bounds.width * bounds.height > 0.9) continue;
    boxes.push({ label: labels[cls], confidence, order, bounds });
  }
  const kept: Region[] = [];
  for (const b of boxes.sort((a, b) => b.confidence - a.confidence)) {
    if (
      kept.some((a) => {
        const shared = intersection(a.bounds, b.bounds);
        const union =
          a.bounds.width * a.bounds.height +
          b.bounds.width * b.bounds.height -
          shared;
        return shared / union > (a.label === b.label ? 0.6 : 0.98);
      })
    )
      continue;
    kept.push(b);
  }
  return kept.sort((a, b) => a.order - b.order);
}
// Each span belongs to at most one region. Unmatched spans are retained separately.
export function assignText(regions: Region[], spans: TextSpan[]) {
  const texts: TextSpan[][] = regions.map(() => []);
  const unmatched: TextSpan[] = [];
  for (const span of spans) {
    let best = -1,
      score = 0.2;
    regions.forEach((region, i) => {
      const overlap =
        intersection(region.bounds, span.bounds) /
        (span.bounds.width * span.bounds.height || 1);
      if (overlap > score) {
        score = overlap;
        best = i;
      }
    });
    if (best < 0) unmatched.push(span);
    else texts[best].push(span);
  }
  return {
    texts: texts.map((t, i) =>
      preformatted.has(regions[i].label) ? joinLines(t) : joinSpans(t),
    ),
    unmatched: joinSpans(unmatched),
  };
}
// Algorithms keep their lines and indentation; everything else reads as prose.
const preformatted = new Set(["algorithm"]);
const sameLine = (a: TextSpan, b: TextSpan) =>
  Math.abs(a.bounds.y - b.bounds.y) <
  Math.min(a.bounds.height, b.bounds.height) * 0.45;
// PDF content streams can list columns out of order. Sort only inside one detected region.
const readingSort = (spans: TextSpan[]) =>
  [...spans].sort((a, b) =>
    sameLine(a, b) ? a.bounds.x - b.bounds.x : a.bounds.y - b.bounds.y,
  );
function joinSpans(spans: TextSpan[]) {
  return readingSort(spans)
    .map((s) => s.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
function joinLines(spans: TextSpan[]) {
  if (!spans.length) return "";
  const lines: TextSpan[][] = [];
  for (const span of readingSort(spans)) {
    const line = lines.at(-1);
    if (line && sameLine(line[0], span)) line.push(span);
    else lines.push([span]);
  }
  // Horizontal gaps become spaces at the region's median character width.
  const widths = spans
    .map((s) => s.bounds.width / Math.max(1, s.text.trim().length))
    .sort((a, b) => a - b);
  const char = widths[Math.floor(widths.length / 2)] || 1;
  const spaces = (gap: number, least: number) =>
    " ".repeat(
      gap <= char * 0.15
        ? 0
        : Math.min(40, Math.max(least, Math.round(gap / char))),
    );
  const left = Math.min(...spans.map((s) => s.bounds.x));
  return lines
    .map((line) => {
      let text = spaces(line[0].bounds.x - left, 0),
        end = line[0].bounds.x;
      line.forEach((span, i) => {
        if (i) text += spaces(span.bounds.x - end, 1);
        text += span.text.replace(/\s+/g, " ").trim();
        end = Math.max(end, span.bounds.x + span.bounds.width);
      });
      return text.trimEnd();
    })
    .join("\n");
}

export interface ReadingRegion extends Region {
  text: string;
  members?: number[];
  caption?: string;
}
const mainCaption = /^(?:figure|fig\.?|table)\s*\d+[\s:.]/i;
function union(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x)),
    y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
    height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
  };
}
// Inline symbols remain in their paragraph. Group panels only when a nearby
// numbered caption provides evidence that they belong to one figure.
export function readingRegions(
  raw: Region[],
  spans: TextSpan[],
): ReadingRegion[] {
  const regions = raw.filter((r) => r.label !== "inline_formula");
  const assigned = assignText(regions, spans);
  const entries: ReadingRegion[] = regions.map((r, i) => ({
    ...r,
    text: assigned.texts[i],
  }));
  const captions = entries.filter(
    (r) => r.label === "figure_title" && mainCaption.test(r.text),
  );
  const groups = new Map<ReadingRegion, ReadingRegion[]>();
  for (const asset of entries.filter((r) =>
    ["chart", "image", "table"].includes(r.label),
  )) {
    const b = asset.bounds;
    const eligible = captions
      .filter((c) => {
        if ((asset.label === "table") !== /^table/i.test(c.text)) return false;
        const cb = c.bounds;
        const gap =
          asset.label === "table"
            ? Math.min(
                Math.abs(cb.y - b.y - b.height),
                Math.abs(b.y - cb.y - cb.height),
              )
            : cb.y - b.y - b.height;
        const center = b.x + b.width / 2;
        if (
          gap < -0.01 ||
          gap > 0.12 ||
          center < cb.x - Math.min(0.12, cb.width / 4) ||
          center > cb.x + cb.width + Math.min(0.12, cb.width / 4)
        )
          return false;
        // Do not combine across intervening prose or another numbered caption.
        return !entries.some(
          (r) =>
            r !== asset &&
            r !== c &&
            (r.label === "text" ||
              r.label === "paragraph_title" ||
              mainCaption.test(r.text)) &&
            r.bounds.y > b.y + b.height &&
            r.bounds.y + r.bounds.height < cb.y &&
            center >= r.bounds.x &&
            center <= r.bounds.x + r.bounds.width,
        );
      })
      .sort(
        (a, z) =>
          Math.abs(a.bounds.y - b.y - b.height) -
          Math.abs(z.bounds.y - b.y - b.height),
      );
    const caption = eligible[0];
    if (caption) groups.set(caption, [...(groups.get(caption) ?? []), asset]);
  }
  const consumed = new Set<ReadingRegion>();
  const merged: ReadingRegion[] = [];
  for (const [caption, assets] of groups) {
    let bounds = union([caption.bounds, ...assets.map((a) => a.bounds)]);
    const parts = entries.filter(
      (r) =>
        r.label === "figure_title" &&
        !mainCaption.test(r.text) &&
        intersection(r.bounds, bounds) / (r.bounds.width * r.bounds.height) >
          0.8,
    );
    const members = [...assets, ...parts, caption];
    bounds = union(members.map((r) => r.bounds));
    members.forEach((r) => consumed.add(r));
    const text = assignText([{ ...assets[0], bounds }], spans).texts[0];
    merged.push({
      ...assets[0],
      bounds,
      text,
      caption: caption.text,
      order: Math.min(...members.map((r) => r.order)),
      confidence: Math.min(...assets.map((r) => r.confidence)),
      members: members.map((r) => r.order),
    });
  }
  return orderPageBlocks(
    [...entries.filter((r) => !consumed.has(r)), ...merged].sort(
      (a, b) => a.order - b.order,
    ),
  );
}
