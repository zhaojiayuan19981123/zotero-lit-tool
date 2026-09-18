(() => {
  'use strict';

  function normalizeRotation(degrees) {
    const numeric = Number(degrees) || 0;
    return ((numeric % 360) + 360) % 360;
  }

  function rotationSwapsDimensions(degrees) {
    const normalized = normalizeRotation(degrees);
    return normalized === 90 || normalized === 270;
  }

  function getDisplaySize(size, extraRotation = 0) {
    const width = Number(size?.w) || 0;
    const height = Number(size?.h) || 0;
    return rotationSwapsDimensions(extraRotation) ? { w: height, h: width } : { w: width, h: height };
  }

  function toDisplayRect(rect, size, extraRotation = 0) {
    const [x1, y1, x2, y2] = rect;
    const width = Number(size?.w) || 0;
    const height = Number(size?.h) || 0;
    switch (normalizeRotation(extraRotation)) {
      case 90: return { x1: height - y2, y1: x1, x2: height - y1, y2: x2 };
      case 180: return { x1: width - x2, y1: height - y2, x2: width - x1, y2: height - y1 };
      case 270: return { x1: y1, y1: width - x2, x2: y2, y2: width - x1 };
      default: return { x1, y1, x2, y2 };
    }
  }

  function toCanonicalRect(rect, size, extraRotation = 0) {
    const { x1, y1, x2, y2 } = rect;
    const width = Number(size?.w) || 0;
    const height = Number(size?.h) || 0;
    switch (normalizeRotation(extraRotation)) {
      case 90: return { x1: y1, y1: height - x2, x2: y2, y2: height - x1 };
      case 180: return { x1: width - x2, y1: height - y2, x2: width - x1, y2: height - y1 };
      case 270: return { x1: width - y2, y1: x1, x2: width - y1, y2: x2 };
      default: return { x1, y1, x2, y2 };
    }
  }

  function joinSelectionText(previous, next) {
    const left = String(previous || '').replace(/\s+/g, ' ').trim();
    const right = String(next || '').replace(/\s+/g, ' ').trim();
    if (!left) return right;
    if (!right) return left;
    // English fragments need a separator even when the earlier fragment ends in punctuation.
    // A trailing hyphen is deliberately kept for PDF line-break hyphenation.
    const bothContainLatinOrDigits = /[A-Za-z0-9]/.test(left) && /[A-Za-z0-9]/.test(right);
    return bothContainLatinOrDigits && !/[-‐‑]$/.test(left) ? `${left} ${right}` : `${left}${right}`;
  }

  function selectionKey(selection) {
    if (!selection) return '';
    const rects = (selection.rects || []).map((rect) => [rect.x1, rect.y1, rect.x2, rect.y2]
      .map((value) => Number(value || 0).toFixed(2)).join(',')).join(';');
    return `${selection.pageNum || ''}|${String(selection.text || '').trim()}|${rects}`;
  }

  function multiplyTransforms(left, right) {
    return [
      left[0] * right[0] + left[2] * right[1],
      left[1] * right[0] + left[3] * right[1],
      left[0] * right[2] + left[2] * right[3],
      left[1] * right[2] + left[3] * right[3],
      left[0] * right[4] + left[2] * right[5] + left[4],
      left[1] * right[4] + left[3] * right[5] + left[5],
    ];
  }

  window.PdfReaderUtils = Object.freeze({
    normalizeRotation,
    rotationSwapsDimensions,
    getDisplaySize,
    toDisplayRect,
    toCanonicalRect,
    joinSelectionText,
    selectionKey,
    multiplyTransforms,
  });
})();
