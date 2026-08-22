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

  // 蛍光ペンは半透明で重ねる。乗算で重ねるため、下の文字は黒いまま残る。
  const MARKER_OPACITY = 0.4;
  // 直線がこの角度以内なら、水平または垂直として引き直す。
  const STRAIGHT_SNAP_DEGREES = 7;

  function getStrokeAppearance(variant) {
    const marker = variant === "marker";
    return { marker, opacity: marker ? MARKER_OPACITY : 1 };
  }

  // 手で引いた直線を水平・垂直へ補正する。始点は動かさず、終点だけを
  // その軸へ下ろす。斜めに引きたいときまで巻き込まないよう、許容角は狭くとる。
  function snapStraightLine(start, end, toleranceDegrees) {
    const tolerance = Number.isFinite(toleranceDegrees)
      ? toleranceDegrees
      : STRAIGHT_SNAP_DEGREES;
    const deltaX = end.x - start.x;
    const deltaY = end.y - start.y;
    if (deltaX === 0 && deltaY === 0) {
      return { x: end.x, y: end.y };
    }
    const angle =
      (Math.atan2(Math.abs(deltaY), Math.abs(deltaX)) * 180) / Math.PI;
    if (angle <= tolerance) {
      return { x: end.x, y: start.y };
    }
    if (angle >= 90 - tolerance) {
      return { x: start.x, y: end.y };
    }
    return { x: end.x, y: end.y };
  }

  // 引き出し矢印は、テキストの枠を基準にした「局所座標」で持つ。原点は枠の
  // 左上、X軸は文字の並ぶ向き、Y軸はその下向き。こうしておけば、テキストを
  // 動かしても回転させても、矢印は枠に付いたまま一緒に動く。
  function toPagePoint(annotation, localX, localY) {
    const radians = (normalizeAngle(annotation.rotation) * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return {
      x: annotation.x + localX * cos + localY * sin,
      y: annotation.y + localX * sin - localY * cos
    };
  }

  // 矢印の根本を枠線の上に置く。枠の中心から先端へ向かう線が、枠のどの辺と
  // 交わるかを求める。先端が枠の中にあるときは、引きようがないので null。
  function getArrowAnchor(boxWidth, boxHeight, tipX, tipY) {
    const centerX = boxWidth / 2;
    const centerY = boxHeight / 2;
    const deltaX = tipX - centerX;
    const deltaY = tipY - centerY;
    if (deltaX === 0 && deltaY === 0) {
      return null;
    }
    const scaleX = deltaX === 0 ? Infinity : centerX / Math.abs(deltaX);
    const scaleY = deltaY === 0 ? Infinity : centerY / Math.abs(deltaY);
    const scale = Math.min(scaleX, scaleY);
    if (scale >= 1) {
      return null;
    }
    return { x: centerX + deltaX * scale, y: centerY + deltaY * scale };
  }

  function getCalloutLineWidth(fontSize) {
    return Math.max(1.2, (Number(fontSize) || 16) * 0.09);
  }

  // 矢印の形。線と矢じりを、すべて局所座標で返す。
  function getArrowGeometry(arrow, boxWidth, boxHeight, fontSize) {
    if (!arrow || !Number.isFinite(arrow.x) || !Number.isFinite(arrow.y)) {
      return null;
    }
    const tail = getArrowAnchor(boxWidth, boxHeight, arrow.x, arrow.y);
    if (!tail) {
      return null;
    }
    const deltaX = arrow.x - tail.x;
    const deltaY = arrow.y - tail.y;
    const length = Math.hypot(deltaX, deltaY);
    if (length < 2) {
      return null;
    }
    const unitX = deltaX / length;
    const unitY = deltaY / length;
    const size = Math.max(4, Number(fontSize) || 16);
    const headLength = Math.min(Math.max(8, size * 0.8), length);
    const headWidth = headLength * 0.8;
    const baseX = arrow.x - unitX * headLength;
    const baseY = arrow.y - unitY * headLength;
    // 線は矢じりの根元で止める。先まで引くと矢じりの内側で線が透けて見える。
    return {
      tail,
      tip: { x: arrow.x, y: arrow.y },
      lineEnd: { x: baseX, y: baseY },
      head: [
        { x: arrow.x, y: arrow.y },
        { x: baseX - unitY * (headWidth / 2), y: baseY + unitX * (headWidth / 2) },
        { x: baseX + unitY * (headWidth / 2), y: baseY - unitX * (headWidth / 2) }
      ],
      thickness: getCalloutLineWidth(size)
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
    const {
      rgb,
      degrees,
      BlendMode,
      LineCapStyle,
      LineJoinStyle,
      pushGraphicsState,
      popGraphicsState,
      setLineCap,
      setLineJoin
    } = root.PDFLib;

    // 書き込みは元のページ内容と同じ内容ストリームへ続けて置かれるため、
    // 指定しない項目は元の内容が残した状態を引き継いでしまう。
    // drawSvgPath は線のつなぎ方を指定せず、線端も既定値のときは省くので、
    // 囲いの中で両方を決めておく。つなぎ方を丸めないと、折れ線の角が
    // とげのように飛び出す。
    page.pushOperators(
      pushGraphicsState(),
      setLineJoin(LineJoinStyle.Round),
      setLineCap(LineCapStyle.Butt)
    );

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
        const { marker, opacity } = getStrokeAppearance(drawItem.variant);
        const blendMode = marker ? BlendMode.Multiply : BlendMode.Normal;
        if (points.length === 1) {
          page.drawCircle({
            x: points[0].x + originX,
            y: points[0].y + originY,
            size: thickness / 2,
            color,
            opacity,
            blendMode,
            borderWidth: 0
          });
          return;
        }
        // 区間ごとに分けて描くと、半透明の蛍光ペンでは継ぎ目が二重になって
        // そこだけ濃くなる。ひと続きのパスとして一度で描く。
        // drawSvgPath はY軸を反転させて描くため、Y座標の符号を入れ替える。
        const path = points
          .map((point, index) => {
            const x = roundCoordinate(point.x + originX);
            const y = roundCoordinate(-(point.y + originY));
            return `${index === 0 ? "M" : "L"} ${x} ${y}`;
          })
          .join(" ");
        page.drawSvgPath(path, {
          x: 0,
          y: 0,
          borderColor: color,
          borderWidth: thickness,
          borderOpacity: opacity,
          // 蛍光ペンは平らな線端にする。丸めると、なぞった範囲より半幅ぶん
          // はみ出して塗られてしまう。
          borderLineCap: marker ? LineCapStyle.Butt : LineCapStyle.Round,
          blendMode
        });
        return;
      }
      if (drawItem.type === "polygon") {
        const points = Array.isArray(drawItem.points) ? drawItem.points : [];
        if (points.length < 3) {
          return;
        }
        const { red, green, blue } = hexToRgb(drawItem.color);
        const path = `${points
          .map((point, index) => {
            const x = roundCoordinate(point.x + originX);
            const y = roundCoordinate(-(point.y + originY));
            return `${index === 0 ? "M" : "L"} ${x} ${y}`;
          })
          .join(" ")} Z`;
        // color を渡すと塗りだけになる。borderColor を省くと既定の黒枠が付く。
        page.drawSvgPath(path, { x: 0, y: 0, color: rgb(red, green, blue) });
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

    page.pushOperators(popGraphicsState());
  }

  function roundCoordinate(value) {
    return Math.round(value * 100) / 100;
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
    toPagePoint,
    getArrowAnchor,
    getArrowGeometry,
    getCalloutLineWidth,
    getStrokeAppearance,
    snapStraightLine,
    hexToRgb,
    applyPageAnnotations,
    formatBytes
  };

  root.PdfRotateCore = api;
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
