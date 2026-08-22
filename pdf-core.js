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

  function getPageBox(page) {
    if (!page || typeof page.getCropBox !== "function") {
      throw new TypeError("A PDF page is required.");
    }
    const box = page.getCropBox();
    const width = Math.abs(box.width);
    const height = Math.abs(box.height);
    return {
      x: box.width < 0 ? box.x + box.width : box.x,
      y: box.height < 0 ? box.y + box.height : box.y,
      width,
      height
    };
  }

  // ページの見た目の大きさ。90度と270度では縦横が入れ替わる。
  function getDisplaySize(width, height, rotation) {
    const angle = normalizeAngle(rotation);
    return angle === 90 || angle === 270
      ? { width: height, height: width }
      : { width, height };
  }

  // 画面座標（左上原点・下向きY）からPDFのページ座標（左下原点・上向きY）へ。
  // 座標はクロップボックスの左下を原点とした相対値で扱う。
  function toUserPoint(displayX, displayY, width, height, rotation) {
    const angle = normalizeAngle(rotation);
    if (angle === 90) {
      return { x: displayY, y: displayX };
    }
    if (angle === 180) {
      return { x: width - displayX, y: displayY };
    }
    if (angle === 270) {
      return { x: width - displayY, y: height - displayX };
    }
    return { x: displayX, y: height - displayY };
  }

  // toUserPoint の逆変換。
  function toDisplayPoint(userX, userY, width, height, rotation) {
    const angle = normalizeAngle(rotation);
    if (angle === 90) {
      return { x: userY, y: userX };
    }
    if (angle === 180) {
      return { x: width - userX, y: userY };
    }
    if (angle === 270) {
      return { x: height - userY, y: width - userX };
    }
    return { x: userX, y: height - userY };
  }

  // 注釈テキストは「作成時のページ角度」を向きとして持つ。ページ座標での
  // 左上位置と大きさから、pdf-lib の drawImage が必要とする左下位置を求める。
  function getTextPlacement(annotation, boxWidth, boxHeight) {
    const rotate = normalizeAngle(annotation.rotation);
    const radians = (rotate * Math.PI) / 180;
    return {
      x: annotation.x + boxHeight * Math.sin(radians),
      y: annotation.y - boxHeight * Math.cos(radians),
      width: boxWidth,
      height: boxHeight,
      rotate
    };
  }

  function hexToRgb(color) {
    const match = /^#?([0-9a-f]{6})$/i.exec(String(color || "").trim());
    const value = match ? parseInt(match[1], 16) : 0;
    return {
      red: ((value >> 16) & 255) / 255,
      green: ((value >> 8) & 255) / 255,
      blue: (value & 255) / 255
    };
  }

  // 画面で作った注釈をPDFページへ描き込む。テキストは呼び出し側が画像に
  // したものを受け取る（標準フォントでは日本語を埋め込めないため）。
  function applyPageAnnotations(page, drawItems, offset) {
    if (!page || !Array.isArray(drawItems)) {
      throw new TypeError("A PDF page and draw items are required.");
    }
    const originX = offset && Number.isFinite(offset.x) ? offset.x : 0;
    const originY = offset && Number.isFinite(offset.y) ? offset.y : 0;
    const { rgb, degrees, LineCapStyle } = root.PDFLib;

    drawItems.forEach((drawItem) => {
      if (!drawItem) {
        return;
      }
      if (drawItem.type === "stroke") {
        const points = Array.isArray(drawItem.points) ? drawItem.points : [];
        if (points.length === 0) {
          return;
        }
        const { red, green, blue } = hexToRgb(drawItem.color);
        const color = rgb(red, green, blue);
        const thickness = Math.max(0.2, Number(drawItem.thickness) || 1);
        if (points.length === 1) {
          page.drawCircle({
            x: points[0].x + originX,
            y: points[0].y + originY,
            size: thickness / 2,
            color,
            borderWidth: 0
          });
          return;
        }
        for (let index = 1; index < points.length; index += 1) {
          page.drawLine({
            start: {
              x: points[index - 1].x + originX,
              y: points[index - 1].y + originY
            },
            end: { x: points[index].x + originX, y: points[index].y + originY },
            thickness,
            color,
            lineCap: LineCapStyle.Round
          });
        }
        return;
      }
      if (drawItem.type === "image" && drawItem.image) {
        page.drawImage(drawItem.image, {
          x: drawItem.x + originX,
          y: drawItem.y + originY,
          width: drawItem.width,
          height: drawItem.height,
          rotate: degrees(normalizeAngle(drawItem.rotate))
        });
      }
    });
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
    getPageBox,
    getDisplaySize,
    toUserPoint,
    toDisplayPoint,
    getTextPlacement,
    hexToRgb,
    applyPageAnnotations,
    formatBytes
  };

  root.PdfRotateCore = api;
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
