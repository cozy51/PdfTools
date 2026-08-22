/*
 * ページを大きく開いて編集するモード。
 *
 * 注釈（テキスト・線）はPDFのページ座標で保持する。画面はページを回転して
 * 表示できるため、画面座標のまま持つと回転で位置がずれてしまう。ページ座標へ
 * 変換して持てば、回転しても保存しても内容と同じ位置に残る。
 */

const core = globalThis.PdfRotateCore;

const ANNOTATION_FONT =
  '"Segoe UI", "Yu Gothic UI", "Meiryo", "Hiragino Sans", "Noto Sans JP", sans-serif';
const TEXT_LINE_HEIGHT = 1.35;
const TEXT_PADDING_RATIO = 0.2;
// テキストは画像として書き込む。標準の埋め込みフォントでは日本語を扱えないため。
const TEXT_IMAGE_SCALE = 4;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const HISTORY_LIMIT = 60;

let measureContext = null;

function getMeasureContext() {
  if (!measureContext) {
    measureContext = document.createElement("canvas").getContext("2d");
  }
  return measureContext;
}

function createId() {
  return `annotation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function isMarkerTool(tool) {
  return tool === "marker" || tool === "marker-line";
}

function isStraightTool(tool) {
  return tool === "line" || tool === "marker-line";
}

export function layoutText(annotation) {
  const fontSize = Math.max(4, Number(annotation.fontSize) || 16);
  const context = getMeasureContext();
  context.font = `${fontSize}px ${ANNOTATION_FONT}`;
  const lines = String(annotation.text ?? "").split("\n");
  const lineHeight = fontSize * TEXT_LINE_HEIGHT;
  const padding = fontSize * TEXT_PADDING_RATIO;
  const textWidth = lines.reduce(
    (widest, line) => Math.max(widest, context.measureText(line).width),
    0
  );
  return {
    lines,
    fontSize,
    lineHeight,
    padding,
    width: Math.max(fontSize * 0.6, textWidth) + padding * 2,
    height: lineHeight * lines.length + padding * 2
  };
}

function paintText(context, annotation, layout) {
  context.font = `${layout.fontSize}px ${ANNOTATION_FONT}`;
  context.textBaseline = "top";
  context.textAlign = "left";
  context.fillStyle = annotation.color;
  layout.lines.forEach((line, index) => {
    context.fillText(line, layout.padding, layout.padding + index * layout.lineHeight);
  });
}

function toDisplayPoints(points, box, rotation) {
  return points.map((point) =>
    core.toDisplayPoint(point.x, point.y, box.width, box.height, rotation)
  );
}

function outlineStroke(context, points, thickness) {
  context.save();
  context.strokeStyle = "rgba(86, 84, 214, 0.9)";
  context.lineWidth = thickness + 4;
  context.setLineDash([6, 4]);
  traceStroke(context, points);
  context.stroke();
  context.restore();
}

function traceStroke(context, points) {
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1) {
    context.lineTo(points[index].x, points[index].y);
  }
}

// プレビュー用のキャンバスと、サムネイルの両方から使う描画処理。
export function drawAnnotations(context, annotations, box, rotation, options = {}) {
  const items = options.previewItem
    ? [...annotations, options.previewItem]
    : annotations;
  context.save();
  context.lineJoin = "round";
  context.lineCap = "round";

  items.forEach((annotation) => {
    if (annotation.id && annotation.id === options.hiddenId) {
      return;
    }
    const selected = Boolean(annotation.id) && annotation.id === options.selectedId;

    if (annotation.type === "text") {
      const layout = layoutText(annotation);
      const anchor = core.toDisplayPoint(
        annotation.x,
        annotation.y,
        box.width,
        box.height,
        rotation
      );
      context.save();
      context.translate(anchor.x, anchor.y);
      context.rotate(toRadians(rotation - annotation.rotation));
      paintText(context, annotation, layout);
      if (selected) {
        context.strokeStyle = "rgba(86, 84, 214, 0.9)";
        context.lineWidth = 1.5;
        context.setLineDash([6, 4]);
        context.strokeRect(0, 0, layout.width, layout.height);
      }
      context.restore();
      return;
    }

    const points = toDisplayPoints(annotation.points || [], box, rotation);
    if (points.length === 0) {
      return;
    }
    const thickness = Math.max(0.2, Number(annotation.thickness) || 1);
    if (selected) {
      outlineStroke(context, points, thickness);
    }
    const appearance = core.getStrokeAppearance(annotation.variant);
    context.save();
    context.globalAlpha = appearance.opacity;
    if (appearance.marker) {
      // 下の文字が黒いまま残るように重ねる。サムネイルのようにページの上へ
      // 直接描く場合に効き、書き込み用の透明なキャンバスでは通常の重ねになる。
      context.globalCompositeOperation = "multiply";
    }
    context.strokeStyle = annotation.color;
    context.fillStyle = annotation.color;
    context.lineWidth = thickness;
    context.lineCap = appearance.marker ? "butt" : "round";
    if (points.length === 1) {
      context.beginPath();
      context.arc(points[0].x, points[0].y, thickness / 2, 0, Math.PI * 2);
      context.fill();
    } else {
      traceStroke(context, points);
      context.stroke();
    }
    context.restore();
  });

  context.restore();
}

// 保存時に使う。テキスト1件を透過PNGへ描き出す。
export function renderTextImage(annotation) {
  const layout = layoutText(annotation);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(layout.width * TEXT_IMAGE_SCALE));
  canvas.height = Math.max(1, Math.ceil(layout.height * TEXT_IMAGE_SCALE));
  const context = canvas.getContext("2d");
  context.scale(TEXT_IMAGE_SCALE, TEXT_IMAGE_SCALE);
  paintText(context, annotation, layout);
  return {
    dataUrl: canvas.toDataURL("image/png"),
    width: canvas.width / TEXT_IMAGE_SCALE,
    height: canvas.height / TEXT_IMAGE_SCALE
  };
}

export function createAnnotationStore() {
  const pages = new Map();

  return {
    get(pageKey) {
      return pages.get(pageKey) || [];
    },
    set(pageKey, annotations) {
      if (annotations.length === 0) {
        pages.delete(pageKey);
      } else {
        pages.set(pageKey, annotations);
      }
    },
    has(pageKey) {
      return (pages.get(pageKey) || []).length > 0;
    },
    count(pageKey) {
      return (pages.get(pageKey) || []).length;
    },
    total() {
      let total = 0;
      pages.forEach((list) => {
        total += list.length;
      });
      return total;
    },
    removeItem(itemId) {
      const prefix = `${itemId}:`;
      Array.from(pages.keys()).forEach((pageKey) => {
        if (pageKey.startsWith(prefix)) {
          pages.delete(pageKey);
        }
      });
    },
    clear() {
      pages.clear();
    }
  };
}

export function createPageEditor(options) {
  const { store, getDescriptors, getPageContext, setStatus, onAnnotationsChanged } =
    options;

  const dom = {
    root: document.querySelector("#page-editor"),
    title: document.querySelector("#page-editor-title"),
    subtitle: document.querySelector("#page-editor-subtitle"),
    close: document.querySelector("#page-editor-close"),
    modeToggle: document.querySelector("#page-editor-mode"),
    toolbar: document.querySelector("#page-editor-toolbar"),
    toolButtons: Array.from(document.querySelectorAll("[data-tool]")),
    color: document.querySelector("#annotation-color"),
    thickness: document.querySelector("#annotation-thickness"),
    thicknessLabel: document.querySelector("#annotation-thickness-label"),
    thicknessValue: document.querySelector("#annotation-thickness-value"),
    fontSize: document.querySelector("#annotation-font-size"),
    fontSizeValue: document.querySelector("#annotation-font-size-value"),
    undo: document.querySelector("#annotation-undo"),
    removeSelected: document.querySelector("#annotation-delete"),
    clear: document.querySelector("#annotation-clear"),
    zoomOut: document.querySelector("#page-zoom-out"),
    zoomIn: document.querySelector("#page-zoom-in"),
    zoomFit: document.querySelector("#page-zoom-fit"),
    zoomValue: document.querySelector("#page-zoom-value"),
    stage: document.querySelector("#page-editor-stage"),
    surface: document.querySelector("#page-editor-surface"),
    pageCanvas: document.querySelector("#page-editor-canvas"),
    overlay: document.querySelector("#annotation-canvas"),
    textInput: document.querySelector("#annotation-text-input"),
    hint: document.querySelector("#page-editor-hint"),
    previous: document.querySelector("#page-editor-previous"),
    next: document.querySelector("#page-editor-next"),
    done: document.querySelector("#page-editor-done")
  };

  const editor = {
    open: false,
    mode: "view",
    tool: "pen",
    // ペンと蛍光ペンは用途が違うため、色と太さをそれぞれ覚えておく。
    penColor: "#e0245e",
    penThickness: 3,
    markerColor: "#ffe14d",
    markerThickness: 16,
    fontSize: 18,
    pageKey: "",
    descriptor: null,
    pdfPage: null,
    box: { x: 0, y: 0, width: 0, height: 0 },
    rotation: 0,
    zoom: 1,
    fitZoom: true,
    baseScale: 1,
    viewScale: 1,
    viewWidth: 0,
    viewHeight: 0,
    renderToken: 0,
    renderTask: null,
    drawing: null,
    dragging: null,
    panning: null,
    editing: null,
    selectedId: null,
    history: []
  };

  function activeVariant() {
    return isMarkerTool(editor.tool) ? "marker" : "pen";
  }

  function activeColor() {
    return isMarkerTool(editor.tool) ? editor.markerColor : editor.penColor;
  }

  function activeThickness() {
    return isMarkerTool(editor.tool) ? editor.markerThickness : editor.penThickness;
  }

  function displaySize() {
    return core.getDisplaySize(editor.box.width, editor.box.height, editor.rotation);
  }

  // CSSピクセルとページ座標の比率。ページを描画したときに決まる値を持っておく。
  // 表示中の要素の大きさから計算すると、拡大時に自分自身を参照してしまう。
  function currentScale() {
    return editor.viewScale;
  }

  function annotations() {
    return store.get(editor.pageKey);
  }

  function setAnnotations(list) {
    store.set(editor.pageKey, list);
    onAnnotationsChanged(editor.pageKey);
  }

  function pushHistory() {
    editor.history.push(annotations().map((item) => structuredClone(item)));
    if (editor.history.length > HISTORY_LIMIT) {
      editor.history.shift();
    }
  }

  function addAnnotation(annotation) {
    pushHistory();
    setAnnotations([...annotations(), annotation]);
  }

  function replaceAnnotation(id, next) {
    setAnnotations(annotations().map((item) => (item.id === id ? next : item)));
  }

  function drawOverlay() {
    const size = displaySize();
    const context = dom.overlay.getContext("2d");
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    const scale = currentScale();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, dom.overlay.width, dom.overlay.height);
    if (size.width === 0 || scale === 0) {
      return;
    }
    context.setTransform(ratio * scale, 0, 0, ratio * scale, 0, 0);
    drawAnnotations(context, annotations(), editor.box, editor.rotation, {
      selectedId: editor.mode === "edit" ? editor.selectedId : null,
      hiddenId: editor.editing?.id || null,
      previewItem: editor.drawing
    });
  }

  function resizeOverlay() {
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    dom.overlay.width = Math.max(1, Math.round(editor.viewWidth * ratio));
    dom.overlay.height = Math.max(1, Math.round(editor.viewHeight * ratio));
    dom.overlay.style.width = `${editor.viewWidth}px`;
    dom.overlay.style.height = `${editor.viewHeight}px`;
  }

  function computeBaseScale() {
    const size = displaySize();
    const available = dom.stage.getBoundingClientRect();
    // 枠の内側の余白ぶんを引く。ぴったりに合わせるとスクロールバーが
    // 出たり消えたりするため、少しだけ余らせておく。
    const width = Math.max(160, available.width - 32);
    const height = Math.max(160, available.height - 32);
    if (size.width === 0 || size.height === 0) {
      return 1;
    }
    return Math.min(width / size.width, height / size.height);
  }

  function updateZoomLabel() {
    // 実際の表示倍率を出す。全体表示は用紙の大きさによって倍率が変わる。
    dom.zoomValue.textContent = `${Math.round(editor.baseScale * editor.zoom * 100)}%`;
  }

  async function renderPage() {
    if (!editor.descriptor) {
      return;
    }
    const token = (editor.renderToken += 1);
    if (editor.renderTask) {
      try {
        editor.renderTask.cancel();
      } catch {
        // 直前の描画がすでに終わっている場合は何もしなくてよい。
      }
      editor.renderTask = null;
    }

    editor.baseScale = computeBaseScale();
    if (editor.fitZoom) {
      editor.zoom = 1;
    }
    const scale = editor.baseScale * editor.zoom;
    const viewport = editor.pdfPage.getViewport({ scale, rotation: editor.rotation });
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    const size = displaySize();
    editor.viewWidth = Math.max(1, Math.floor(viewport.width));
    editor.viewHeight = Math.max(1, Math.floor(viewport.height));
    editor.viewScale = size.width > 0 ? editor.viewWidth / size.width : scale;

    dom.pageCanvas.width = Math.max(1, Math.floor(viewport.width * ratio));
    dom.pageCanvas.height = Math.max(1, Math.floor(viewport.height * ratio));
    dom.pageCanvas.style.width = `${editor.viewWidth}px`;
    dom.pageCanvas.style.height = `${editor.viewHeight}px`;
    dom.surface.style.width = `${editor.viewWidth}px`;
    dom.surface.style.height = `${editor.viewHeight}px`;
    resizeOverlay();
    drawOverlay();
    updateZoomLabel();

    const context = dom.pageCanvas.getContext("2d", { alpha: false });
    try {
      const task = editor.pdfPage.render({
        canvasContext: context,
        viewport,
        transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0]
      });
      editor.renderTask = task;
      await task.promise;
    } catch (error) {
      if (!error || error.name !== "RenderingCancelledException") {
        console.error(error);
      }
      return;
    } finally {
      if (editor.renderToken === token) {
        editor.renderTask = null;
      }
    }

    if (editor.renderToken === token) {
      resizeOverlay();
      drawOverlay();
      positionTextInput();
    }
  }

  function updateToolbar() {
    const editing = editor.mode === "edit";
    dom.toolbar.hidden = !editing;
    dom.root.classList.toggle("editing", editing);
    dom.modeToggle.textContent = editing ? "閲覧モードに戻す" : "編集モードにする";
    dom.modeToggle.setAttribute("aria-pressed", String(editing));
    dom.toolButtons.forEach((button) => {
      const active = button.dataset.tool === editor.tool;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    dom.overlay.classList.toggle("interactive", editing);
    dom.overlay.dataset.tool = editing ? editor.tool : "";
    syncToolSettings();
    dom.undo.disabled = editor.history.length === 0;
    dom.removeSelected.disabled = !editor.selectedId;
    dom.clear.disabled = annotations().length === 0;
    dom.hint.textContent = editing ? toolHint() : viewHint();
  }

  // 色と太さは道具ごとに覚えているので、選び直すたびに表示を合わせる。
  function syncToolSettings() {
    const marker = isMarkerTool(editor.tool);
    const thickness = activeThickness();
    dom.color.value = activeColor();
    dom.thicknessLabel.textContent = marker ? "蛍光ペンの太さ" : "ペンの太さ";
    dom.thickness.min = marker ? "6" : "1";
    dom.thickness.max = marker ? "48" : "16";
    dom.thickness.value = String(thickness);
    dom.thicknessValue.textContent = String(thickness);
  }

  function viewHint() {
    const count = annotations().length;
    return count > 0
      ? `このページには${count}件の書き込みがあります。「編集モードにする」で追加や修正ができます。`
      : "「編集モードにする」を押すと、テキストの挿入と線の描画ができます。";
  }

  function toolHint() {
    if (editor.tool === "text") {
      return "ページ上をクリックすると文字を入力できます。Escで取り消し、Ctrl+Enterまたは枠の外をクリックで確定します。";
    }
    if (editor.tool === "pen") {
      return "ドラッグすると、なぞった通りに線を描きます。";
    }
    if (editor.tool === "marker") {
      return "ドラッグすると、なぞった部分を半透明の色で塗ります。下の文字は消えません。";
    }
    if (isStraightTool(editor.tool)) {
      const name = editor.tool === "marker-line" ? "半透明の直線" : "直線";
      return `ドラッグした始点と終点を結ぶ${name}を描きます。ほぼ水平・垂直なら、始点をそのままに水平・垂直へ揃えます。`;
    }
    return "書き込みをクリックで選択し、ドラッグで移動できます。文字はダブルクリックで編集、Deleteキーで削除します。";
  }

  function updateNavigation() {
    const descriptors = getDescriptors();
    const index = descriptors.findIndex(
      (descriptor) => descriptor.key === editor.pageKey
    );
    dom.previous.disabled = index <= 0;
    dom.next.disabled = index < 0 || index >= descriptors.length - 1;
    if (index >= 0) {
      dom.title.textContent = `${index + 1} / ${descriptors.length} ページ`;
      const { item, pageModel } = descriptors[index];
      dom.subtitle.textContent = `${item.file.name} ・ 元の${pageModel.sourceIndex + 1}ページ目`;
    }
  }

  function setTool(tool) {
    editor.tool = tool;
    if (tool !== "select") {
      editor.selectedId = null;
    }
    commitTextEditing();
    updateToolbar();
    drawOverlay();
  }

  function setMode(mode) {
    editor.mode = mode;
    if (mode === "view") {
      commitTextEditing();
      editor.selectedId = null;
    }
    updateToolbar();
    // ツールバーの表示でページを置ける高さが変わるため、倍率を計算し直す。
    void renderPage();
  }

  function pointerPosition(event) {
    const rect = dom.overlay.getBoundingClientRect();
    const scale = currentScale();
    return {
      x: (event.clientX - rect.left) / scale,
      y: (event.clientY - rect.top) / scale
    };
  }

  function toUser(point) {
    return core.toUserPoint(
      point.x,
      point.y,
      editor.box.width,
      editor.box.height,
      editor.rotation
    );
  }

  function distanceToSegment(point, start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) {
      return Math.hypot(point.x - start.x, point.y - start.y);
    }
    const t = Math.max(
      0,
      Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared)
    );
    return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
  }

  function hitTest(point) {
    const list = annotations();
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const annotation = list[index];
      if (annotation.type === "text") {
        const layout = layoutText(annotation);
        const anchor = core.toDisplayPoint(
          annotation.x,
          annotation.y,
          editor.box.width,
          editor.box.height,
          editor.rotation
        );
        const angle = toRadians(editor.rotation - annotation.rotation);
        const dx = point.x - anchor.x;
        const dy = point.y - anchor.y;
        const localX = dx * Math.cos(angle) + dy * Math.sin(angle);
        const localY = -dx * Math.sin(angle) + dy * Math.cos(angle);
        if (
          localX >= 0 &&
          localX <= layout.width &&
          localY >= 0 &&
          localY <= layout.height
        ) {
          return annotation;
        }
        continue;
      }
      const points = toDisplayPoints(annotation.points || [], editor.box, editor.rotation);
      const tolerance = Math.max((Number(annotation.thickness) || 1) / 2 + 4, 7);
      if (points.length === 1) {
        if (Math.hypot(point.x - points[0].x, point.y - points[0].y) <= tolerance) {
          return annotation;
        }
        continue;
      }
      for (let step = 1; step < points.length; step += 1) {
        if (distanceToSegment(point, points[step - 1], points[step]) <= tolerance) {
          return annotation;
        }
      }
    }
    return null;
  }

  function positionTextInput() {
    const editing = editor.editing;
    if (!editing) {
      return;
    }
    const scale = currentScale();
    const anchor = core.toDisplayPoint(
      editing.x,
      editing.y,
      editor.box.width,
      editor.box.height,
      editor.rotation
    );
    const layout = layoutText({
      text: dom.textInput.value || " ",
      fontSize: editing.fontSize
    });
    dom.textInput.style.left = `${anchor.x * scale}px`;
    dom.textInput.style.top = `${anchor.y * scale}px`;
    dom.textInput.style.transform = `rotate(${editor.rotation - editing.rotation}deg)`;
    dom.textInput.style.font = `${editing.fontSize * scale}px/${TEXT_LINE_HEIGHT} ${ANNOTATION_FONT}`;
    dom.textInput.style.padding = `${layout.padding * scale}px`;
    dom.textInput.style.color = editing.color;
    dom.textInput.style.width = `${Math.max(28, layout.width * scale)}px`;
    dom.textInput.style.height = `${Math.max(20, layout.height * scale)}px`;
  }

  function startTextEditing(userPoint, existing) {
    commitTextEditing();
    editor.editing = existing
      ? { ...existing, isNew: false }
      : {
          id: createId(),
          type: "text",
          x: userPoint.x,
          y: userPoint.y,
          rotation: editor.rotation,
          text: "",
          fontSize: editor.fontSize,
          color: editor.penColor,
          isNew: true
        };
    dom.textInput.value = editor.editing.text;
    dom.textInput.hidden = false;
    positionTextInput();
    drawOverlay();
    dom.textInput.focus();
    dom.textInput.setSelectionRange(
      dom.textInput.value.length,
      dom.textInput.value.length
    );
  }

  function cancelTextEditing() {
    editor.editing = null;
    dom.textInput.hidden = true;
    dom.textInput.value = "";
    drawOverlay();
    updateToolbar();
  }

  function commitTextEditing() {
    const editing = editor.editing;
    if (!editing) {
      return;
    }
    const text = dom.textInput.value.replace(/\s+$/u, "");
    editor.editing = null;
    dom.textInput.hidden = true;
    dom.textInput.value = "";

    if (text.length === 0) {
      if (!editing.isNew) {
        pushHistory();
        setAnnotations(annotations().filter((item) => item.id !== editing.id));
        setStatus("テキストを削除しました。");
      }
    } else if (editing.isNew) {
      const { isNew, ...annotation } = editing;
      addAnnotation({ ...annotation, text });
      setStatus("テキストを挿入しました。");
    } else if (text !== editing.text) {
      pushHistory();
      const { isNew, ...annotation } = editing;
      replaceAnnotation(editing.id, { ...annotation, text });
      setStatus("テキストを更新しました。");
    }
    drawOverlay();
    updateToolbar();
  }

  function removeSelected() {
    if (!editor.selectedId) {
      return;
    }
    pushHistory();
    setAnnotations(annotations().filter((item) => item.id !== editor.selectedId));
    editor.selectedId = null;
    drawOverlay();
    updateToolbar();
    setStatus("書き込みを削除しました。");
  }

  function undo() {
    if (editor.history.length === 0) {
      return;
    }
    setAnnotations(editor.history.pop());
    editor.selectedId = null;
    drawOverlay();
    updateToolbar();
    setStatus("直前の書き込み操作を取り消しました。");
  }

  function clearAll() {
    if (annotations().length === 0) {
      return;
    }
    pushHistory();
    setAnnotations([]);
    editor.selectedId = null;
    drawOverlay();
    updateToolbar();
    setStatus("このページの書き込みをすべて消去しました。");
  }

  function onPointerDown(event) {
    if (editor.mode !== "edit" || event.button !== 0) {
      return;
    }
    const point = pointerPosition(event);
    if (editor.tool === "text") {
      startTextEditing(toUser(point), null);
      return;
    }

    commitTextEditing();
    if (editor.tool === "select") {
      const hit = hitTest(point);
      editor.selectedId = hit ? hit.id : null;
      if (hit) {
        editor.dragging = {
          id: hit.id,
          origin: structuredClone(hit),
          start: point,
          moved: false
        };
        dom.overlay.setPointerCapture(event.pointerId);
      }
      drawOverlay();
      updateToolbar();
      return;
    }

    if (editor.tool !== "pen" && editor.tool !== "marker" && !isStraightTool(editor.tool)) {
      return;
    }
    const userPoint = toUser(point);
    editor.drawing = {
      type: "stroke",
      variant: activeVariant(),
      points: [userPoint, userPoint],
      color: activeColor(),
      thickness: activeThickness(),
      straight: isStraightTool(editor.tool)
    };
    dom.overlay.setPointerCapture(event.pointerId);
    drawOverlay();
  }

  function onPointerMove(event) {
    if (editor.dragging) {
      const point = pointerPosition(event);
      const from = toUser(editor.dragging.start);
      const to = toUser(point);
      const deltaX = to.x - from.x;
      const deltaY = to.y - from.y;
      if (Math.abs(deltaX) > 0.01 || Math.abs(deltaY) > 0.01) {
        if (!editor.dragging.moved) {
          editor.dragging.moved = true;
          pushHistory();
        }
        const origin = editor.dragging.origin;
        const moved =
          origin.type === "text"
            ? { ...origin, x: origin.x + deltaX, y: origin.y + deltaY }
            : {
                ...origin,
                points: origin.points.map((item) => ({
                  x: item.x + deltaX,
                  y: item.y + deltaY
                }))
              };
        replaceAnnotation(origin.id, moved);
        drawOverlay();
      }
      return;
    }

    if (!editor.drawing) {
      return;
    }
    const userPoint = toUser(pointerPosition(event));
    if (editor.drawing.straight) {
      // ページの回転は90度単位なので、ページ座標で水平・垂直に直せば
      // 画面で見ても水平・垂直になる。
      editor.drawing.points[1] = core.snapStraightLine(
        editor.drawing.points[0],
        userPoint
      );
    } else {
      const last = editor.drawing.points[editor.drawing.points.length - 1];
      if (Math.hypot(userPoint.x - last.x, userPoint.y - last.y) >= 0.75) {
        editor.drawing.points.push(userPoint);
      }
    }
    drawOverlay();
  }

  function onPointerUp(event) {
    if (dom.overlay.hasPointerCapture?.(event.pointerId)) {
      dom.overlay.releasePointerCapture(event.pointerId);
    }
    if (editor.dragging) {
      if (editor.dragging.moved) {
        setStatus("書き込みを移動しました。");
      }
      editor.dragging = null;
      updateToolbar();
      return;
    }
    if (!editor.drawing) {
      return;
    }
    const drawing = editor.drawing;
    editor.drawing = null;
    const points = drawing.straight ? drawing.points.slice(0, 2) : drawing.points;
    const start = points[0];
    const end = points[points.length - 1];
    const isDot = points.length === 2 && Math.hypot(end.x - start.x, end.y - start.y) < 1;
    addAnnotation({
      id: createId(),
      type: "stroke",
      variant: drawing.variant,
      points: isDot ? [start] : points,
      color: drawing.color,
      thickness: drawing.thickness
    });
    drawOverlay();
    updateToolbar();
    const name = drawing.variant === "marker" ? "蛍光ペン" : "ペン";
    setStatus(
      drawing.straight
        ? `${name}で直線を描画しました。`
        : `${name}で線を描画しました。`
    );
  }

  // 拡大しているときにスクロールバーまでカーソルを運ばずに済むよう、
  // 右ドラッグで表示位置そのものを動かせるようにする。左ボタンは描画に
  // 使うため、ここでは使わない。
  function onStagePointerDown(event) {
    if (event.button !== 2 || editor.panning) {
      return;
    }
    event.preventDefault();
    editor.panning = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      scrollLeft: dom.stage.scrollLeft,
      scrollTop: dom.stage.scrollTop
    };
    // 取り込んでおくと、書き込み用のキャンバスの上を通っても移動が続き、
    // 枠の外へはみ出しても離した時点で必ず終わる。
    dom.stage.setPointerCapture(event.pointerId);
    dom.stage.classList.add("panning");
  }

  function onStagePointerMove(event) {
    const panning = editor.panning;
    if (!panning || event.pointerId !== panning.pointerId) {
      return;
    }
    event.preventDefault();
    dom.stage.scrollLeft = panning.scrollLeft - (event.clientX - panning.clientX);
    dom.stage.scrollTop = panning.scrollTop - (event.clientY - panning.clientY);
  }

  function endPanning(event) {
    const panning = editor.panning;
    if (!panning || (event && event.pointerId !== panning.pointerId)) {
      return;
    }
    if (event && dom.stage.hasPointerCapture?.(event.pointerId)) {
      dom.stage.releasePointerCapture(event.pointerId);
    }
    editor.panning = null;
    dom.stage.classList.remove("panning");
  }

  function onDoubleClick(event) {
    if (editor.mode !== "edit" || editor.tool !== "select") {
      return;
    }
    const hit = hitTest(pointerPosition(event));
    if (hit?.type === "text") {
      event.preventDefault();
      startTextEditing(null, hit);
    }
  }

  async function show(descriptor) {
    editor.descriptor = descriptor;
    editor.pageKey = descriptor.key;
    editor.selectedId = null;
    editor.drawing = null;
    editor.dragging = null;
    editor.history = [];
    endPanning();
    cancelTextEditing();

    const context = await getPageContext(descriptor);
    editor.pdfPage = context.pdfPage;
    editor.rotation = context.rotation;
    editor.box = context.box;
    updateNavigation();
    updateToolbar();
    await renderPage();
  }

  async function openPage(descriptor) {
    if (!descriptor) {
      return;
    }
    const wasOpen = editor.open;
    editor.open = true;
    dom.root.hidden = false;
    document.documentElement.classList.add("page-editor-open");
    try {
      await show(descriptor);
    } catch (error) {
      console.error(error);
      setStatus("このページを開けませんでした。", "error");
      close();
      return;
    }
    if (!wasOpen) {
      dom.modeToggle.focus();
    }
  }

  function close() {
    if (!editor.open) {
      return;
    }
    commitTextEditing();
    if (editor.renderTask) {
      try {
        editor.renderTask.cancel();
      } catch {
        // 描画が終わっていれば取り消す必要はない。
      }
      editor.renderTask = null;
    }
    endPanning();
    editor.open = false;
    editor.descriptor = null;
    editor.pdfPage = null;
    dom.root.hidden = true;
    document.documentElement.classList.remove("page-editor-open");
  }

  function step(direction) {
    const descriptors = getDescriptors();
    const index = descriptors.findIndex(
      (descriptor) => descriptor.key === editor.pageKey
    );
    const next = descriptors[index + direction];
    if (next) {
      void openPage(next);
    }
  }

  function clampZoom(zoom) {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  }

  function currentZoom() {
    return editor.fitZoom ? 1 : editor.zoom;
  }

  function setZoom(zoom) {
    editor.fitZoom = false;
    editor.zoom = clampZoom(zoom);
    void renderPage();
  }

  function zoomStep(factor) {
    setZoom(currentZoom() * factor);
  }

  // 指した位置を動かさずに拡大縮小する。画面の中央を基準にすると、
  // 見ていた場所が枠の外へ逃げてしまう。
  function zoomAtPoint(zoom, clientX, clientY) {
    const before = dom.surface.getBoundingClientRect();
    const ratioX = before.width > 0 ? (clientX - before.left) / before.width : 0.5;
    const ratioY = before.height > 0 ? (clientY - before.top) / before.height : 0.5;

    editor.fitZoom = false;
    editor.zoom = clampZoom(zoom);
    const rendering = renderPage();

    // renderPage はページの内容を描く前に大きさを決めるため、この時点で
    // 新しい配置が分かる。同じ割合の位置がカーソルの下へ来るよう寄せる。
    const after = dom.surface.getBoundingClientRect();
    dom.stage.scrollLeft += after.left + after.width * ratioX - clientX;
    dom.stage.scrollTop += after.top + after.height * ratioY - clientY;
    return rendering;
  }

  // ホイールの刻みは環境によって単位が違うため、画素数へそろえてから使う。
  function wheelDelta(event) {
    if (event.deltaMode === 1) {
      return event.deltaY * 16;
    }
    if (event.deltaMode === 2) {
      return event.deltaY * 400;
    }
    return event.deltaY;
  }

  function onStageWheel(event) {
    // Windowsとの合わせでCtrl、macOSではCommandでも同じ操作にする。
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    // 止めないとブラウザー自身の拡大縮小が働いてしまう。
    event.preventDefault();
    const factor = Math.exp(-wheelDelta(event) * 0.0015);
    void zoomAtPoint(currentZoom() * factor, event.clientX, event.clientY);
  }

  dom.close.addEventListener("click", close);
  dom.done.addEventListener("click", close);
  dom.modeToggle.addEventListener("click", () => {
    setMode(editor.mode === "edit" ? "view" : "edit");
  });
  dom.toolButtons.forEach((button) => {
    button.addEventListener("click", () => setTool(button.dataset.tool));
  });
  dom.color.addEventListener("input", () => {
    if (isMarkerTool(editor.tool)) {
      editor.markerColor = dom.color.value;
    } else {
      editor.penColor = dom.color.value;
    }
  });
  dom.thickness.addEventListener("input", () => {
    const value = Number(dom.thickness.value);
    if (isMarkerTool(editor.tool)) {
      editor.markerThickness = value;
    } else {
      editor.penThickness = value;
    }
    dom.thicknessValue.textContent = String(value);
  });
  dom.fontSize.addEventListener("input", () => {
    editor.fontSize = Number(dom.fontSize.value);
    dom.fontSizeValue.textContent = dom.fontSize.value;
    if (editor.editing) {
      editor.editing.fontSize = editor.fontSize;
      positionTextInput();
    }
  });
  dom.undo.addEventListener("click", undo);
  dom.removeSelected.addEventListener("click", removeSelected);
  dom.clear.addEventListener("click", clearAll);
  dom.zoomIn.addEventListener("click", () => zoomStep(1.25));
  dom.zoomOut.addEventListener("click", () => zoomStep(1 / 1.25));
  dom.zoomFit.addEventListener("click", () => {
    editor.fitZoom = true;
    void renderPage();
  });
  dom.previous.addEventListener("click", () => step(-1));
  dom.next.addEventListener("click", () => step(1));

  // 既定の動作でフォーカスが移ると、テキスト入力欄を出した直後に blur が起きて
  // 入力欄が閉じてしまう。編集中はページ上の押下だけ既定の動作を止める。
  dom.overlay.addEventListener("mousedown", (event) => {
    if (editor.mode === "edit") {
      event.preventDefault();
    }
  });
  dom.overlay.addEventListener("pointerdown", onPointerDown);
  dom.overlay.addEventListener("pointermove", onPointerMove);
  dom.overlay.addEventListener("pointerup", onPointerUp);
  dom.overlay.addEventListener("pointercancel", onPointerUp);
  dom.overlay.addEventListener("dblclick", onDoubleClick);

  // 既定の拡大縮小を止めるため、受け流さない指定で登録する。
  dom.stage.addEventListener("wheel", onStageWheel, { passive: false });
  dom.stage.addEventListener("pointerdown", onStagePointerDown);
  dom.stage.addEventListener("pointermove", onStagePointerMove);
  dom.stage.addEventListener("pointerup", endPanning);
  dom.stage.addEventListener("pointercancel", endPanning);
  // 右ドラッグを移動に使うため、この中では右クリックのメニューを出さない。
  dom.stage.addEventListener("contextmenu", (event) => event.preventDefault());

  dom.textInput.addEventListener("input", positionTextInput);
  dom.textInput.addEventListener("blur", commitTextEditing);
  dom.textInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      // ここで止めないと、画面全体のEscape処理が編集モードごと閉じてしまう。
      event.stopPropagation();
      cancelTextEditing();
      return;
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      commitTextEditing();
    }
  });

  dom.root.addEventListener("pointerdown", (event) => {
    if (event.target === dom.root && event.button === 0) {
      close();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (!editor.open) {
      return;
    }
    if (event.key === "Escape") {
      if (editor.editing) {
        return;
      }
      event.preventDefault();
      close();
      return;
    }
    if (event.target === dom.textInput) {
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && editor.selectedId) {
      event.preventDefault();
      removeSelected();
    }
  });

  let resizeTimer = 0;
  globalThis.addEventListener("resize", () => {
    if (!editor.open) {
      return;
    }
    globalThis.clearTimeout(resizeTimer);
    resizeTimer = globalThis.setTimeout(() => {
      if (editor.open) {
        void renderPage();
      }
    }, 150);
  });

  return {
    openPage,
    close,
    isOpen: () => editor.open,
    refresh: () => {
      if (!editor.open) {
        return;
      }
      const stillListed = getDescriptors().some(
        (descriptor) => descriptor.key === editor.pageKey
      );
      if (!stillListed) {
        close();
        return;
      }
      updateNavigation();
      updateToolbar();
    }
  };
}
