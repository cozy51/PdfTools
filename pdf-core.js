(function initPdfRotateCore(root) {
  "use strict";

  function normalizeAngle(angle) {
    const normalized = Number(angle) % 360;
    return normalized < 0 ? normalized + 360 : normalized;
  }

  function rotatePages(pdfDocument, pageIndexes, delta) {
    if (!pdfDocument || !Array.isArray(pageIndexes)) {
      throw new TypeError("PDF document and page indexes are required.");
    }

    const pages = pdfDocument.getPages();
    pageIndexes.forEach((pageIndex) => {
      const page = pages[pageIndex];
      if (!page) {
        throw new RangeError(`Page index out of range: ${pageIndex}`);
      }
      const nextAngle = normalizeAngle(page.getRotation().angle + delta);
      page.setRotation(root.PDFLib.degrees(nextAngle));
    });
  }

  function resetRotations(pdfDocument, originalRotations) {
    const pages = pdfDocument.getPages();
    if (!Array.isArray(originalRotations) || originalRotations.length !== pages.length) {
      throw new RangeError("Original rotations do not match the PDF page count.");
    }

    pages.forEach((page, index) => {
      page.setRotation(root.PDFLib.degrees(normalizeAngle(originalRotations[index])));
    });
  }

  function getPageState(page, index) {
    const rotation = normalizeAngle(page.getRotation().angle);
    const width = page.getWidth();
    const height = page.getHeight();
    const quarterTurn = rotation === 90 || rotation === 270;

    return {
      index,
      number: index + 1,
      rotation,
      width,
      height,
      displayWidth: quarterTurn ? height : width,
      displayHeight: quarterTurn ? width : height
    };
  }

  function createOutputName(fileName) {
    const rawName = typeof fileName === "string" ? fileName.trim() : "";
    const baseName = rawName.replace(/\.pdf$/i, "") || "document";
    return `${baseName}_rotated.pdf`;
  }

  function createEditedOutputName(fileName) {
    const rawName = typeof fileName === "string" ? fileName.trim() : "";
    const baseName = rawName.replace(/\.pdf$/i, "") || "document";
    return `${baseName}_edited.pdf`;
  }

  function createMergedOutputName(fileName) {
    const rawName = typeof fileName === "string" ? fileName.trim() : "";
    const baseName = rawName.replace(/\.pdf$/i, "") || "document";
    return `${baseName}_merged.pdf`;
  }

  async function mergePdfPages(items) {
    if (!Array.isArray(items)) {
      throw new TypeError("PDF items are required.");
    }
    const orderedPages = [];
    for (const item of items) {
      if (!item || !item.pdfDocument || !Array.isArray(item.pages)) {
        throw new TypeError("Each PDF item must include a document and pages.");
      }
      const sourceIndexes = item.pages.map((page) =>
        typeof page === "number" ? page : page.sourceIndex
      );
      if (sourceIndexes.length === 0) {
        continue;
      }
      sourceIndexes.forEach((sourceIndex) => {
        orderedPages.push({ pdfDocument: item.pdfDocument, sourceIndex });
      });
    }
    return mergeOrderedPdfPages(orderedPages);
  }

  async function mergeOrderedPdfPages(orderedPages) {
    if (!Array.isArray(orderedPages)) {
      throw new TypeError("Ordered PDF pages are required.");
    }
    const output = await root.PDFLib.PDFDocument.create();
    let position = 0;
    while (position < orderedPages.length) {
      const first = orderedPages[position];
      if (!first || !first.pdfDocument || !Number.isInteger(first.sourceIndex)) {
        throw new TypeError("Each ordered page must include a document and source index.");
      }
      const sourceIndexes = [first.sourceIndex];
      let next = position + 1;
      while (
        next < orderedPages.length &&
        orderedPages[next].pdfDocument === first.pdfDocument
      ) {
        sourceIndexes.push(orderedPages[next].sourceIndex);
        next += 1;
      }
      const copiedPages = await output.copyPages(first.pdfDocument, sourceIndexes);
      copiedPages.forEach((page) => output.addPage(page));
      position = next;
    }
    return output;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) {
      return "";
    }
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  const api = {
    normalizeAngle,
    rotatePages,
    resetRotations,
    getPageState,
    createOutputName,
    createEditedOutputName,
    createMergedOutputName,
    mergePdfPages,
    mergeOrderedPdfPages,
    formatBytes
  };

  root.PdfRotateCore = api;
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
