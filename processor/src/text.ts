import { pdfFontAscent } from "../../../packages/reader-core/src/pdf-text";
import type { PDFPageProxy } from "pdfjs-dist";
import type { TextSpan } from "./layout";

export async function extractTextSpans(
  page: PDFPageProxy,
  scale = 1,
): Promise<TextSpan[]> {
  const { Util } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const viewport = page.getViewport({ scale });
  const width = Math.ceil(viewport.width),
    height = Math.ceil(viewport.height);
  const content = await page.getTextContent();
  return content.items.flatMap((item) => {
    if (!("str" in item) || !item.str.trim()) return [];
    const transform = Util.transform(viewport.transform, item.transform);
    const h = Math.hypot(transform[2], transform[3]);
    const ascent = pdfFontAscent(content.styles[item.fontName]);
    return [
      {
        text: item.str,
        bounds: {
          x: transform[4] / width,
          y: (transform[5] - h * ascent) / height,
          width: Math.abs(item.width * scale) / width,
          height: h / height,
        },
      },
    ];
  });
}
