import type { PDFDocumentProxy } from "pdfjs-dist";
import { assignText, type Box } from "./layout";
import { extractTextSpans } from "./text";
import { orderPageBlocks } from "./reading-order";
export interface CachedBlock {
  id: string;
  page: number;
  label: string;
  bounds: Box;
  text: string;
  image?: string;
  caption?: string;
}
export async function repairTextBlocks(
  pdf: PDFDocumentProxy,
  blocks: CachedBlock[],
) {
  const repaired: CachedBlock[] = [],
    unmatched = new Map<number, string>();
  const pages = [...new Set(blocks.map((b) => b.page))].sort((a, b) => a - b);
  for (const number of pages) {
    const page = await pdf.getPage(number),
      viewport = page.getViewport({ scale: 1 });
    const scale = Math.min(
      2,
      Math.sqrt(4_000_000 / (viewport.width * viewport.height)),
    );
    const original = blocks.filter((b) => b.page === number);
    const spans = await extractTextSpans(page, scale);
    // Scans are unchanged: do not erase existing text when extraction has no evidence.
    if (!spans.length) {
      repaired.push(...orderPageBlocks(original));
      continue;
    }
    const assigned = assignText(
      original.map((b) => ({ ...b, confidence: 1, order: 0 })),
      spans,
    );
    repaired.push(
      ...orderPageBlocks(
        original.map((b, i) => ({ ...b, text: assigned.texts[i] })),
      ),
    );
    if (assigned.unmatched) unmatched.set(number, assigned.unmatched);
    page.cleanup();
  }
  return { blocks: repaired, unmatched };
}
