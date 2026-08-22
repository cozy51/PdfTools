import {
  getDocument as loadPreviewDocument,
  GlobalWorkerOptions,
  VerbosityLevel
} from "./vendor/pdf.min.mjs";
import {
  createAnnotationStore,
  createPageEditor,
  drawAnnotations,
  renderTextImage
} from "./page-editor.js";

GlobalWorkerOptions.workerSrc = new URL(
  "./vendor/pdf.worker.min.mjs",
  import.meta.url
).href;

const core = globalThis.PdfRotateCore;
document.documentElement.classList.add("editor-tab");
const elements = {
  dropZone: document.querySelector("#drop-zone"),
  fileInput: document.querySelector("#file-input"),
  chooseButton: document.querySelector("#choose-button"),
  editor: document.querySelector("#editor"),
  addFilesButton: document.querySelector("#add-files-button"),
  fileList: document.querySelector("#file-list"),
  pageCount: document.querySelector("#page-count"),
  selectedCount: document.querySelector("#selected-count"),
  selectAllButton: document.querySelector("#select-all-button"),
  clearSelectionButton: document.querySelector("#clear-selection-button"),
  undoDeleteButton: document.querySelector("#undo-delete-button"),
  deleteSelectedButton: document.querySelector("#delete-selected-button"),
  pageGrid: document.querySelector("#page-grid"),
  saveButton: document.querySelector("#save-button"),
  saveLabel: document.querySelector("#save-label"),
  status: document.querySelector("#status"),
  appVersion: document.querySelector("#app-version")
};

const APP_VERSION = "1.9.1";
elements.appVersion.textContent = `v${APP_VERSION}`;

const state = {
  items: [],
  pageOrder: [],
  selectedPages: new Set(),
  lastDeletion: null,
  nextItemId: 1,
  busy: false,
  observer: null,
  renderTasks: new Map(),
  draggedItemId: null,
  draggedPageKey: null,
  annotations: createAnnotationStore(),
  thumbnailRefreshTimers: new Map()
};

let pageEditor = null;

let externalFileDragDepth = 0;

function isInternalReorderDrag() {
  return Boolean(state.draggedItemId || state.draggedPageKey);
}

function getDraggedFiles(dataTransfer) {
  if (!dataTransfer) {
    return [];
  }
  if (dataTransfer.files?.length > 0) {
    return Array.from(dataTransfer.files);
  }
  return Array.from(dataTransfer.items || [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter(Boolean);
}

function resetExternalFileDrag() {
  externalFileDragDepth = 0;
  elements.dropZone.classList.remove("dragging");
  document.documentElement.classList.remove("file-dragging");
}

function pageKey(itemId, sourceIndex) {
  return `${itemId}:${sourceIndex}`;
}

// 書き込みの位置はページ座標で持つ。原点と大きさは pdf.js が描画に使う
// ビューボックス（クロップボックス）に合わせる必要があるため、そこから取る。
function cachePageBox(item, sourceIndex, previewPage) {
  const cached = item.pageBoxes.get(sourceIndex);
  if (cached) {
    return cached;
  }
  const [x0, y0, x1, y1] = previewPage.view;
  const box = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  item.pageBoxes.set(sourceIndex, box);
  return box;
}

async function resolvePageBox(item, sourceIndex) {
  const cached = item.pageBoxes.get(sourceIndex);
  if (cached) {
    return cached;
  }
  const previewPage = await item.previewDocument.getPage(sourceIndex + 1);
  return cachePageBox(item, sourceIndex, previewPage);
}

function getPageDescriptors() {
  const itemMap = new Map(
    state.items.map((item, fileIndex) => [item.id, { item, fileIndex }])
  );
  const descriptors = [];
  state.pageOrder.forEach((pageModel) => {
    const source = itemMap.get(pageModel.itemId);
    if (!source) {
      return;
    }
    descriptors.push({
      item: source.item,
      fileIndex: source.fileIndex,
      pageModel,
      globalIndex: descriptors.length,
      key: pageKey(pageModel.itemId, pageModel.sourceIndex)
    });
  });
  return descriptors;
}

function regroupPagesByFileOrder() {
  const pagesByItem = new Map(state.items.map((item) => [item.id, []]));
  state.pageOrder.forEach((pageModel) => {
    pagesByItem.get(pageModel.itemId)?.push(pageModel);
  });
  state.pageOrder = state.items.flatMap((item) => pagesByItem.get(item.id) || []);
}

function setStatus(message, type = "") {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", type === "error");
}

function updateActionStates() {
  const pageTotal = getPageDescriptors().length;
  elements.chooseButton.disabled = state.busy;
  elements.addFilesButton.disabled = state.busy;
  elements.saveButton.disabled = state.busy || pageTotal === 0;
  elements.pageGrid.querySelectorAll(".page-rotate, .page-select, .page-edit").forEach((button) => {
    button.disabled = state.busy;
  });
  elements.fileList.querySelectorAll(".file-action").forEach((button) => {
    const unavailable = button.dataset.boundary === "true";
    button.disabled = state.busy || unavailable;
  });
  elements.fileList.querySelectorAll(".file-row").forEach((row) => {
    row.draggable = !state.busy;
  });
  updateSelectionToolbar();
}

function setBusy(busy) {
  state.busy = busy;
  updateActionStates();
}

function openFilePicker() {
  if (!state.busy) {
    elements.fileInput.click();
  }
}

function cancelRenderWork() {
  if (state.observer) {
    state.observer.disconnect();
    state.observer = null;
  }
  state.renderTasks.forEach((task) => {
    try {
      task.cancel();
    } catch {
      // Completed render tasks do not need cancellation.
    }
  });
  state.renderTasks.clear();
}

function createFileAction(action, label, boundary = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `file-action ${action}`;
  button.dataset.fileAction = action;
  button.dataset.boundary = String(boundary);
  button.setAttribute("aria-label", label);
  button.title = label;

  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  const paths = {
    up: "M12 3 4.5 10.5H9V21h6V10.5h4.5L12 3Z",
    down: "M12 21 4.5 13.5H9V3h6v10.5h4.5L12 21Z",
    remove: "m6.4 4.9-1.5 1.5 5.6 5.6-5.6 5.6 1.5 1.5 5.6-5.6 5.6 5.6 1.5-1.5-5.6-5.6 5.6-5.6-1.5-1.5-5.6 5.6-5.6-5.6Z"
  };
  path.setAttribute("d", paths[action]);
  icon.append(path);
  button.append(icon);
  button.disabled = state.busy || boundary;
  return button;
}

function createFileRow(item, index) {
  const row = document.createElement("div");
  row.className = "file-row";
  row.dataset.itemId = item.id;
  row.draggable = !state.busy;
  row.title = "ドラッグして結合順を変更";

  const order = document.createElement("span");
  order.className = "file-order";
  order.textContent = String(index + 1);

  const info = document.createElement("div");
  info.className = "file-info";
  const name = document.createElement("strong");
  name.textContent = item.file.name;
  name.title = item.file.name;
  const meta = document.createElement("span");
  const activePageCount = state.pageOrder.filter(
    (pageModel) => pageModel.itemId === item.id
  ).length;
  const pageText = activePageCount === item.originalPageCount
    ? `${activePageCount}ページ`
    : `${activePageCount}/${item.originalPageCount}ページ`;
  meta.textContent = `${pageText} ・ ${core.formatBytes(item.file.size)}`;
  info.append(name, meta);

  const actions = document.createElement("div");
  actions.className = "file-actions";
  actions.append(
    createFileAction("up", `${item.file.name}を上へ移動`, index === 0),
    createFileAction(
      "down",
      `${item.file.name}を下へ移動`,
      index === state.items.length - 1
    ),
    createFileAction("remove", `${item.file.name}を一覧から削除`)
  );

  row.append(order, info, actions);
  return row;
}

function renderFileList() {
  const fragment = document.createDocumentFragment();
  state.items.forEach((item, index) => {
    fragment.append(createFileRow(item, index));
  });
  elements.fileList.replaceChildren(fragment);
  document.title = state.items.length > 0
    ? `PDF Tools - ${state.items.length}ファイル`
    : "PDF Tools";
  elements.saveLabel.textContent = state.items.length > 1
    ? `${state.items.length}個のPDFを結合して保存`
    : "編集後のPDFを保存";
}

function createPageCard(descriptor) {
  const { item, fileIndex, pageModel, globalIndex, key } = descriptor;
  const page = item.pdfDocument.getPage(pageModel.sourceIndex);
  const pageState = core.getPageState(page, pageModel.sourceIndex);
  const card = document.createElement("article");
  card.className = "page-card";
  card.classList.toggle("selected", state.selectedPages.has(key));
  card.dataset.pageKey = key;
  card.dataset.itemId = item.id;
  card.dataset.sourceIndex = String(pageModel.sourceIndex);
  card.title = `${item.file.name} - 元の${pageModel.sourceIndex + 1}ページ目`;

  const preview = document.createElement("div");
  preview.className = "preview-surface";
  preview.setAttribute("role", "button");
  preview.setAttribute("tabindex", "0");
  preview.setAttribute(
    "aria-label",
    `${globalIndex + 1}ページ目を選択または選択解除`
  );

  const select = document.createElement("button");
  select.type = "button";
  select.className = "page-select";
  select.setAttribute("aria-pressed", String(state.selectedPages.has(key)));
  select.setAttribute("aria-label", `${globalIndex + 1}ページ目を選択`);
  select.textContent = "✓";

  const dragHandle = document.createElement("button");
  dragHandle.type = "button";
  dragHandle.className = "page-drag-handle";
  dragHandle.draggable = true;
  dragHandle.setAttribute(
    "aria-label",
    `${globalIndex + 1}ページ目をドラッグして並べ替え`
  );
  dragHandle.title = "ドラッグしてページ順を変更";
  const grip = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  grip.setAttribute("viewBox", "0 0 24 24");
  grip.setAttribute("aria-hidden", "true");
  const gripPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  gripPath.setAttribute(
    "d",
    "M8 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm6 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm6 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM8 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm6 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm6 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM8 19a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm6 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm6 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z"
  );
  grip.append(gripPath);
  dragHandle.append(grip);

  const placeholder = document.createElement("span");
  placeholder.className = "preview-placeholder";
  placeholder.textContent = "プレビューを準備中";

  const angle = document.createElement("span");
  angle.className = "page-angle";
  angle.hidden = pageState.rotation === 0;
  angle.textContent = `${pageState.rotation}°`;

  const mark = document.createElement("span");
  mark.className = "page-mark";
  mark.textContent = "書き込みあり";
  mark.hidden = !state.annotations.has(key);

  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "page-edit";
  edit.setAttribute("aria-label", `${globalIndex + 1}ページ目を開いて編集`);
  edit.title = "ページを開く（ダブルクリックでも開けます）";
  edit.textContent = "開いて編集";
  edit.disabled = state.busy;

  preview.append(select, dragHandle, placeholder, angle, mark, edit);

  const controls = document.createElement("div");
  controls.className = "page-controls";
  const left = document.createElement("button");
  left.type = "button";
  left.className = "page-rotate";
  left.dataset.rotate = "-90";
  left.setAttribute("aria-label", `${globalIndex + 1}ページ目を左へ90度回転`);
  left.title = "左へ90°";
  left.textContent = "↶";

  const label = document.createElement("span");
  label.className = "page-number";
  const number = document.createTextNode(String(globalIndex + 1));
  const source = document.createElement("small");
  source.textContent = `PDF ${fileIndex + 1} ・ 元${pageModel.sourceIndex + 1}`;
  label.append(number, source);

  const right = document.createElement("button");
  right.type = "button";
  right.className = "page-rotate";
  right.dataset.rotate = "90";
  right.setAttribute("aria-label", `${globalIndex + 1}ページ目を右へ90度回転`);
  right.title = "右へ90°";
  right.textContent = "↷";

  controls.append(left, label, right);
  card.append(preview, controls);
  return card;
}

function updatePageAngle(card, rotation) {
  const angle = card.querySelector(".page-angle");
  angle.textContent = `${rotation}°`;
  angle.hidden = rotation === 0;
}

async function renderThumbnail(descriptor, card) {
  if (!card.isConnected) {
    return;
  }

  const { item, pageModel, key } = descriptor;
  const previousTask = state.renderTasks.get(key);
  if (previousTask) {
    try {
      previousTask.cancel();
    } catch {
      // The previous render may have already completed.
    }
  }

  const preview = card.querySelector(".preview-surface");
  const angle = card.querySelector(".page-angle");
  const select = card.querySelector(".page-select");
  const dragHandle = card.querySelector(".page-drag-handle");
  const mark = card.querySelector(".page-mark");
  const edit = card.querySelector(".page-edit");
  const token = `${Date.now()}-${Math.random()}`;
  let activeTask = null;
  card.dataset.renderToken = token;

  try {
    const sourcePage = await item.previewDocument.getPage(pageModel.sourceIndex + 1);
    if (card.dataset.renderToken !== token || !card.isConnected) {
      return;
    }

    const pageState = core.getPageState(
      item.pdfDocument.getPage(pageModel.sourceIndex),
      pageModel.sourceIndex
    );
    const unitViewport = sourcePage.getViewport({
      scale: 1,
      rotation: pageState.rotation
    });
    const availableWidth = Math.max(120, preview.clientWidth - 12);
    const availableHeight = Math.max(160, preview.clientHeight - 12);
    const scale = Math.min(
      availableWidth / unitViewport.width,
      availableHeight / unitViewport.height
    );
    const viewport = sourcePage.getViewport({
      scale,
      rotation: pageState.rotation
    });
    const outputScale = Math.min(globalThis.devicePixelRatio || 1, 2);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
    canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    const context = canvas.getContext("2d", { alpha: false });
    activeTask = sourcePage.render({
      canvasContext: context,
      viewport,
      transform: outputScale === 1
        ? null
        : [outputScale, 0, 0, outputScale, 0, 0]
    });
    state.renderTasks.set(key, activeTask);
    await activeTask.promise;

    // 書き込みはPDFに保存されるまで別レイヤーで持つため、サムネイルにも
    // 同じ変換で重ねて描く。
    const annotations = state.annotations.get(key);
    if (annotations.length > 0) {
      const box = cachePageBox(item, pageModel.sourceIndex, sourcePage);
      const displaySize = core.getDisplaySize(
        box.width,
        box.height,
        pageState.rotation
      );
      const layerScale = displaySize.width > 0
        ? viewport.width / displaySize.width
        : scale;
      context.setTransform(
        outputScale * layerScale,
        0,
        0,
        outputScale * layerScale,
        0,
        0
      );
      drawAnnotations(context, annotations, box, pageState.rotation);
      context.setTransform(1, 0, 0, 1, 0, 0);
    }
    if (mark) {
      mark.hidden = annotations.length === 0;
    }

    if (card.dataset.renderToken === token && card.isConnected) {
      preview.replaceChildren(canvas, select, dragHandle, angle, mark, edit);
      updatePageAngle(card, pageState.rotation);
    }
  } catch (error) {
    if (error && error.name === "RenderingCancelledException") {
      return;
    }
    console.error(error);
    if (card.dataset.renderToken === token && card.isConnected) {
      const message = document.createElement("span");
      message.className = "preview-error";
      message.textContent = "このページのプレビューを表示できませんでした";
      preview.replaceChildren(message, select, dragHandle, angle, mark, edit);
    }
  } finally {
    if (activeTask && state.renderTasks.get(key) === activeTask) {
      state.renderTasks.delete(key);
    }
  }
}

// 書き込みのたびに再描画すると重いので、少し待ってからまとめて更新する。
function scheduleThumbnailRefresh(key) {
  const timers = state.thumbnailRefreshTimers;
  globalThis.clearTimeout(timers.get(key));
  timers.set(
    key,
    globalThis.setTimeout(() => {
      timers.delete(key);
      const card = elements.pageGrid.querySelector(`[data-page-key="${key}"]`);
      const descriptor = getPageDescriptors().find((page) => page.key === key);
      if (!card || !descriptor) {
        return;
      }
      const mark = card.querySelector(".page-mark");
      if (mark) {
        mark.hidden = !state.annotations.has(key);
      }
      void renderThumbnail(descriptor, card);
    }, 400)
  );
}

function updateSelectionToolbar() {
  const descriptors = getPageDescriptors();
  const validKeys = new Set(descriptors.map((descriptor) => descriptor.key));
  state.selectedPages.forEach((key) => {
    if (!validKeys.has(key)) {
      state.selectedPages.delete(key);
    }
  });

  const selected = state.selectedPages.size;
  elements.selectedCount.textContent = selected === 0
    ? "選択なし"
    : `${selected}ページ選択中`;
  elements.selectAllButton.disabled =
    state.busy || descriptors.length === 0 || selected === descriptors.length;
  elements.clearSelectionButton.disabled = state.busy || selected === 0;
  elements.deleteSelectedButton.disabled = state.busy || selected === 0;
  elements.undoDeleteButton.hidden = !state.lastDeletion;
  elements.undoDeleteButton.disabled = state.busy;
}

function renderPageCards() {
  cancelRenderWork();
  const descriptors = getPageDescriptors();
  elements.pageCount.textContent = `${descriptors.length}ページ`;

  if (descriptors.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-pages";
    empty.textContent = "ページがありません。「削除を戻す」またはPDFを追加してください。";
    elements.pageGrid.replaceChildren(empty);
    updateActionStates();
    return;
  }

  const fragment = document.createDocumentFragment();
  descriptors.forEach((descriptor) => {
    fragment.append(createPageCard(descriptor));
  });
  elements.pageGrid.replaceChildren(fragment);

  state.observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) {
          return;
        }
        const card = entry.target;
        state.observer.unobserve(card);
        const descriptor = descriptors.find((page) => page.key === card.dataset.pageKey);
        if (descriptor) {
          renderThumbnail(descriptor, card);
        }
      });
    },
    {
      root: null,
      rootMargin: "600px 0px",
      threshold: 0.01
    }
  );

  elements.pageGrid.querySelectorAll(".page-card").forEach((card) => {
    state.observer.observe(card);
  });
  updateActionStates();
}

function renderWorkspace() {
  const hasFiles = state.items.length > 0;
  elements.dropZone.hidden = hasFiles;
  elements.editor.hidden = !hasFiles;
  if (!hasFiles) {
    cancelRenderWork();
    document.title = "PDF 回転・削除・結合・書き込み";
    elements.fileList.replaceChildren();
    elements.pageGrid.replaceChildren();
    elements.pageCount.textContent = "";
    state.selectedPages.clear();
    updateActionStates();
    return;
  }
  renderFileList();
  renderPageCards();
  pageEditor?.refresh();
}

async function parsePdfFile(file) {
  const sourceBytes = new Uint8Array(await file.arrayBuffer());
  const [pdfDocument, previewDocument] = await Promise.all([
    globalThis.PDFLib.PDFDocument.load(sourceBytes.slice(), {
      updateMetadata: false
    }),
    loadPreviewDocument({
      data: sourceBytes,
      useWasm: false,
      isEvalSupported: false,
      verbosity: VerbosityLevel.ERRORS
    }).promise
  ]);
  const pageCount = pdfDocument.getPageCount();
  if (pageCount === 0) {
    await previewDocument.destroy();
    throw new Error("ページがありません。");
  }

  return {
    id: `pdf-${state.nextItemId++}`,
    file,
    pdfDocument,
    previewDocument,
    originalPageCount: pageCount,
    pageBoxes: new Map(),
    pages: Array.from({ length: pageCount }, (_, sourceIndex) => ({ sourceIndex }))
  };
}

async function loadFiles(fileList) {
  if (state.busy) {
    return;
  }
  const requested = Array.from(fileList || []);
  const files = requested.filter((file) =>
    /\.pdf$/i.test(file.name) || file.type === "application/pdf"
  );
  if (files.length === 0) {
    setStatus("PDFファイルを選択してください。", "error");
    return;
  }

  setBusy(true);
  const added = [];
  const failed = [];
  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      setStatus(`${index + 1}/${files.length}個目のPDFを読み込んでいます…`);
      try {
        const item = await parsePdfFile(file);
        state.items.push(item);
        state.pageOrder.push(
          ...item.pages.map((pageModel) => ({
            itemId: item.id,
            sourceIndex: pageModel.sourceIndex
          }))
        );
        added.push(item);
      } catch (error) {
        console.error(error);
        failed.push(file.name);
      }
    }

    renderWorkspace();
    if (added.length > 0) {
      const ignored = requested.length - files.length + failed.length;
      setStatus(
        ignored > 0
          ? `${added.length}個のPDFを追加しました。${ignored}個は読み込めませんでした。`
          : `${added.length}個のPDFを追加しました。結合順とページを編集できます。`,
        ignored > 0 ? "error" : ""
      );
    } else {
      setStatus("PDFを読み込めませんでした。パスワード保護も確認してください。", "error");
    }
  } finally {
    elements.fileInput.value = "";
    setBusy(false);
  }
}

function moveFile(itemId, direction) {
  const index = state.items.findIndex((item) => item.id === itemId);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= state.items.length) {
    return;
  }
  [state.items[index], state.items[nextIndex]] = [
    state.items[nextIndex],
    state.items[index]
  ];
  regroupPagesByFileOrder();
  renderWorkspace();
  setStatus(`PDFの結合順を変更しました。`);
}

function removeFile(itemId) {
  const index = state.items.findIndex((item) => item.id === itemId);
  if (index < 0) {
    return;
  }
  cancelRenderWork();
  const [removed] = state.items.splice(index, 1);
  state.pageOrder = state.pageOrder.filter(
    (pageModel) => pageModel.itemId !== itemId
  );
  removed.previewDocument.destroy().catch(() => {});
  state.annotations.removeItem(itemId);
  state.selectedPages.forEach((key) => {
    if (key.startsWith(`${itemId}:`)) {
      state.selectedPages.delete(key);
    }
  });
  if (state.lastDeletion?.some((entry) => entry.pageModel.itemId === itemId)) {
    state.lastDeletion = null;
  }
  renderWorkspace();
  setStatus(`「${removed.file.name}」を結合対象から外しました。`);
}

function reorderFileByDrop(sourceId, targetId, insertAfter) {
  const sourceIndex = state.items.findIndex((item) => item.id === sourceId);
  if (sourceIndex < 0 || sourceId === targetId) {
    return;
  }
  const [source] = state.items.splice(sourceIndex, 1);
  const targetIndex = state.items.findIndex((item) => item.id === targetId);
  state.items.splice(targetIndex + (insertAfter ? 1 : 0), 0, source);
  regroupPagesByFileOrder();
  renderWorkspace();
  setStatus("ドラッグ操作でPDFの結合順を変更しました。");
}

function reorderPageByDrop(sourceKey, targetKey, insertAfter) {
  const sourceIndex = state.pageOrder.findIndex(
    (pageModel) => pageKey(pageModel.itemId, pageModel.sourceIndex) === sourceKey
  );
  if (sourceIndex < 0 || sourceKey === targetKey) {
    return;
  }
  const [source] = state.pageOrder.splice(sourceIndex, 1);
  const targetIndex = state.pageOrder.findIndex(
    (pageModel) => pageKey(pageModel.itemId, pageModel.sourceIndex) === targetKey
  );
  if (targetIndex < 0) {
    state.pageOrder.splice(sourceIndex, 0, source);
    return;
  }
  state.pageOrder.splice(targetIndex + (insertAfter ? 1 : 0), 0, source);
  const newIndex = state.pageOrder.indexOf(source);
  const scrollTop = globalThis.scrollY;
  renderPageCards();
  requestAnimationFrame(() => globalThis.scrollTo({ top: scrollTop }));
  setStatus(`${newIndex + 1}ページ目へ移動しました。保存PDFにもこの順序を反映します。`);
}

function setPageSelected(key, selected) {
  if (selected) {
    state.selectedPages.add(key);
  } else {
    state.selectedPages.delete(key);
  }
  const card = elements.pageGrid.querySelector(`[data-page-key="${key}"]`);
  if (card) {
    card.classList.toggle("selected", selected);
    const select = card.querySelector(".page-select");
    select.setAttribute("aria-pressed", String(selected));
  }
  updateSelectionToolbar();
}

function togglePageSelection(key) {
  setPageSelected(key, !state.selectedPages.has(key));
}

function selectAllPages() {
  getPageDescriptors().forEach((descriptor) => {
    state.selectedPages.add(descriptor.key);
  });
  elements.pageGrid.querySelectorAll(".page-card").forEach((card) => {
    card.classList.add("selected");
    card.querySelector(".page-select").setAttribute("aria-pressed", "true");
  });
  updateSelectionToolbar();
}

function clearPageSelection() {
  state.selectedPages.clear();
  elements.pageGrid.querySelectorAll(".page-card").forEach((card) => {
    card.classList.remove("selected");
    card.querySelector(".page-select").setAttribute("aria-pressed", "false");
  });
  updateSelectionToolbar();
}

function deleteSelectedPages() {
  if (state.busy || state.selectedPages.size === 0) {
    return;
  }

  const deleted = [];
  const remaining = [];
  state.pageOrder.forEach((pageModel, position) => {
    const key = pageKey(pageModel.itemId, pageModel.sourceIndex);
    if (state.selectedPages.has(key)) {
      deleted.push({ position, pageModel });
    } else {
      remaining.push(pageModel);
    }
  });
  state.pageOrder = remaining;

  state.lastDeletion = deleted;
  state.selectedPages.clear();
  renderWorkspace();
  setStatus(`${deleted.length}ページを削除しました。必要なら「削除を戻す」で復元できます。`);
}

function undoLastDeletion() {
  if (!state.lastDeletion || state.busy) {
    return;
  }
  state.lastDeletion
    .filter((entry) =>
      state.items.some((item) => item.id === entry.pageModel.itemId)
    )
    .sort((a, b) => a.position - b.position)
    .forEach((entry) => {
      state.pageOrder.splice(entry.position, 0, entry.pageModel);
    });
  const restored = state.lastDeletion.length;
  state.lastDeletion = null;
  renderWorkspace();
  setStatus(`${restored}ページを元に戻しました。`);
}

function rotatePage(itemId, sourceIndex, delta) {
  if (state.busy) {
    return;
  }
  const item = state.items.find((candidate) => candidate.id === itemId);
  const descriptor = getPageDescriptors().find(
    (page) => page.item.id === itemId && page.pageModel.sourceIndex === sourceIndex
  );
  if (!item || !descriptor) {
    return;
  }

  core.rotatePages(item.pdfDocument, [sourceIndex], delta);
  const card = elements.pageGrid.querySelector(`[data-page-key="${descriptor.key}"]`);
  const pageState = core.getPageState(
    item.pdfDocument.getPage(sourceIndex),
    sourceIndex
  );
  updatePageAngle(card, pageState.rotation);
  renderThumbnail(descriptor, card);
  setStatus(
    `${descriptor.globalIndex + 1}ページ目を${delta < 0 ? "左" : "右"}へ90°回転しました。`
  );
}

// 矢印付きのテキストに添える枠と矢印を組み立てる。画面で見えているものと
// 同じ形になるよう、計算は画面側と同じ関数を使う。
function buildCalloutItems(annotation, boxWidth, boxHeight) {
  if (!annotation.arrow) {
    return [];
  }
  const toPage = (point) => core.toPagePoint(annotation, point.x, point.y);
  const items = [
    {
      type: "stroke",
      points: [
        { x: 0, y: 0 },
        { x: boxWidth, y: 0 },
        { x: boxWidth, y: boxHeight },
        { x: 0, y: boxHeight },
        { x: 0, y: 0 }
      ].map(toPage),
      thickness: core.getCalloutLineWidth(annotation.fontSize),
      color: annotation.color
    }
  ];

  const geometry = core.getArrowGeometry(annotation, boxWidth, boxHeight);
  if (geometry) {
    items.push(
      {
        type: "stroke",
        points: [geometry.tail, geometry.tip].map(toPage),
        thickness: geometry.thickness,
        color: annotation.color
      },
      // 矢じりも線で描く。塗りつぶさない。
      {
        type: "stroke",
        points: geometry.head.map(toPage),
        thickness: geometry.thickness,
        color: annotation.color
      }
    );
  }
  return items;
}

// テキストは画像として重ねる。pdf-lib の標準フォントは日本語を含む多くの
// 文字を扱えないため、画面での見た目をそのまま持ち込める方法を選んでいる。
async function applyAnnotationsToOutput(output) {
  const itemMap = new Map(state.items.map((item) => [item.id, item]));
  for (let index = 0; index < state.pageOrder.length; index += 1) {
    const pageModel = state.pageOrder[index];
    const key = pageKey(pageModel.itemId, pageModel.sourceIndex);
    const annotations = state.annotations.get(key);
    if (annotations.length === 0) {
      continue;
    }
    const item = itemMap.get(pageModel.itemId);
    const box = await resolvePageBox(item, pageModel.sourceIndex);
    const drawItems = [];
    for (const annotation of annotations) {
      if (annotation.type === "text") {
        const rendered = renderTextImage(annotation);
        // 枠と矢印は、テキストの枠を基準にした局所座標で持っている。
        // ページ座標へ移してから、線と塗りとして書き込む。
        drawItems.push(
          ...buildCalloutItems(annotation, rendered.width, rendered.height)
        );
        drawItems.push({
          type: "image",
          image: await output.embedPng(rendered.dataUrl),
          ...core.getTextPlacement(annotation, rendered.width, rendered.height)
        });
      } else {
        drawItems.push(annotation);
      }
    }
    core.applyPageAnnotations(output.getPage(index), drawItems, box);
  }
}

async function buildOutputPdf() {
  const itemMap = new Map(state.items.map((item) => [item.id, item]));
  const output = await core.mergeOrderedPdfPages(
    state.pageOrder.map((pageModel) => ({
      pdfDocument: itemMap.get(pageModel.itemId).pdfDocument,
      sourceIndex: pageModel.sourceIndex
    }))
  );
  await applyAnnotationsToOutput(output);
  output.setProducer("PDF Tools Web App");
  output.setCreator("PDF Tools Web App");
  return output;
}

async function savePdf() {
  const pageTotal = getPageDescriptors().length;
  if (state.items.length === 0 || pageTotal === 0 || state.busy) {
    return;
  }

  setBusy(true);
  setStatus(
    state.items.length > 1
      ? "PDFを指定順に結合しています…"
      : "編集後のPDFを作成しています…"
  );
  let objectUrl = "";

  try {
    const output = await buildOutputPdf();
    const bytes = await output.save();
    const blob = new Blob([bytes], { type: "application/pdf" });
    objectUrl = URL.createObjectURL(blob);
    const filename = state.items.length > 1
      ? core.createMergedOutputName(state.items[0].file.name)
      : core.createEditedOutputName(state.items[0].file.name);

    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    globalThis.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);

    setStatus(`「${filename}」を保存しました。`);
  } catch (error) {
    console.error(error);
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
    setStatus(`保存できませんでした。${error.message || ""}`, "error");
  } finally {
    setBusy(false);
  }
}

function openPageForEditing(key) {
  if (state.busy) {
    return;
  }
  const descriptor = getPageDescriptors().find((page) => page.key === key);
  if (descriptor) {
    void pageEditor.openPage(descriptor);
  }
}

async function getPageContext(descriptor) {
  const { item, pageModel } = descriptor;
  const previewPage = await item.previewDocument.getPage(pageModel.sourceIndex + 1);
  const pageState = core.getPageState(
    item.pdfDocument.getPage(pageModel.sourceIndex),
    pageModel.sourceIndex
  );
  return {
    pdfPage: previewPage,
    rotation: pageState.rotation,
    box: cachePageBox(item, pageModel.sourceIndex, previewPage)
  };
}

pageEditor = createPageEditor({
  store: state.annotations,
  getDescriptors: getPageDescriptors,
  getPageContext,
  setStatus,
  onAnnotationsChanged: scheduleThumbnailRefresh
});

elements.chooseButton.addEventListener("click", (event) => {
  event.stopPropagation();
  openFilePicker();
});
elements.addFilesButton.addEventListener("click", openFilePicker);
elements.dropZone.addEventListener("click", openFilePicker);
elements.dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    openFilePicker();
  }
});
elements.fileInput.addEventListener("change", () => loadFiles(elements.fileInput.files));
elements.selectAllButton.addEventListener("click", selectAllPages);
elements.clearSelectionButton.addEventListener("click", clearPageSelection);
elements.deleteSelectedButton.addEventListener("click", deleteSelectedPages);
elements.undoDeleteButton.addEventListener("click", undoLastDeletion);
elements.saveButton.addEventListener("click", savePdf);

elements.fileList.addEventListener("click", (event) => {
  const button = event.target.closest(".file-action");
  if (!button) {
    return;
  }
  const itemId = button.closest(".file-row").dataset.itemId;
  if (button.dataset.fileAction === "up") {
    moveFile(itemId, -1);
  } else if (button.dataset.fileAction === "down") {
    moveFile(itemId, 1);
  } else if (button.dataset.fileAction === "remove") {
    removeFile(itemId);
  }
});

elements.fileList.addEventListener("dblclick", (event) => {
  const row = event.target.closest(".file-row");
  if (!row || event.target.closest(".file-action")) {
    return;
  }
  const descriptor = getPageDescriptors().find(
    (page) => page.item.id === row.dataset.itemId
  );
  if (descriptor) {
    openPageForEditing(descriptor.key);
  } else {
    setStatus("このPDFのページはすべて削除されています。", "error");
  }
});

elements.fileList.addEventListener("dragstart", (event) => {
  const row = event.target.closest(".file-row");
  if (!row || state.busy) {
    event.preventDefault();
    return;
  }
  state.draggedItemId = row.dataset.itemId;
  row.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", state.draggedItemId);
});
elements.fileList.addEventListener("dragover", (event) => {
  const row = event.target.closest(".file-row");
  if (!row || !state.draggedItemId) {
    return;
  }
  event.preventDefault();
  elements.fileList.querySelectorAll(".drag-over").forEach((item) => {
    item.classList.remove("drag-over");
  });
  row.classList.add("drag-over");
  event.dataTransfer.dropEffect = "move";
});
elements.fileList.addEventListener("drop", (event) => {
  const row = event.target.closest(".file-row");
  if (!row || !state.draggedItemId) {
    return;
  }
  event.preventDefault();
  const rect = row.getBoundingClientRect();
  reorderFileByDrop(
    state.draggedItemId,
    row.dataset.itemId,
    event.clientY > rect.top + rect.height / 2
  );
  state.draggedItemId = null;
});
elements.fileList.addEventListener("dragend", () => {
  state.draggedItemId = null;
  elements.fileList.querySelectorAll(".dragging, .drag-over").forEach((item) => {
    item.classList.remove("dragging", "drag-over");
  });
});

elements.pageGrid.addEventListener("click", (event) => {
  const card = event.target.closest(".page-card");
  if (!card) {
    return;
  }
  const rotateButton = event.target.closest(".page-rotate");
  if (rotateButton) {
    rotatePage(
      card.dataset.itemId,
      Number(card.dataset.sourceIndex),
      Number(rotateButton.dataset.rotate)
    );
    return;
  }
  if (event.target.closest(".page-edit")) {
    openPageForEditing(card.dataset.pageKey);
    return;
  }
  if (event.target.closest(".page-drag-handle")) {
    return;
  }
  if (event.target.closest(".preview-surface")) {
    togglePageSelection(card.dataset.pageKey);
  }
});

// ダブルクリックでページを開く。1回目と2回目のクリックで選択状態が入れ替わり、
// 元の状態へ戻るため、選択のための処理を打ち消す必要はない。
elements.pageGrid.addEventListener("dblclick", (event) => {
  const card = event.target.closest(".page-card");
  if (!card || event.target.closest(".page-rotate, .page-drag-handle, .page-select")) {
    return;
  }
  event.preventDefault();
  openPageForEditing(card.dataset.pageKey);
});

elements.pageGrid.addEventListener("dragstart", (event) => {
  const handle = event.target.closest(".page-drag-handle");
  const card = handle?.closest(".page-card");
  if (!handle || !card || state.busy) {
    return;
  }
  state.draggedPageKey = card.dataset.pageKey;
  card.classList.add("page-dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", state.draggedPageKey);
});
elements.pageGrid.addEventListener("dragover", (event) => {
  const card = event.target.closest(".page-card");
  if (!card || !state.draggedPageKey || card.dataset.pageKey === state.draggedPageKey) {
    return;
  }
  event.preventDefault();
  elements.pageGrid.querySelectorAll(".drag-before, .drag-after").forEach((item) => {
    item.classList.remove("drag-before", "drag-after");
  });
  const rect = card.getBoundingClientRect();
  card.classList.add(event.clientX > rect.left + rect.width / 2 ? "drag-after" : "drag-before");
  event.dataTransfer.dropEffect = "move";
});
elements.pageGrid.addEventListener("drop", (event) => {
  const card = event.target.closest(".page-card");
  if (!card || !state.draggedPageKey) {
    return;
  }
  event.preventDefault();
  const insertAfter = card.classList.contains("drag-after");
  reorderPageByDrop(state.draggedPageKey, card.dataset.pageKey, insertAfter);
  state.draggedPageKey = null;
});
elements.pageGrid.addEventListener("dragend", () => {
  state.draggedPageKey = null;
  elements.pageGrid
    .querySelectorAll(".page-dragging, .drag-before, .drag-after")
    .forEach((item) => {
      item.classList.remove("page-dragging", "drag-before", "drag-after");
    });
});
elements.pageGrid.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") &&
      event.target.classList.contains("preview-surface")) {
    event.preventDefault();
    const card = event.target.closest(".page-card");
    togglePageSelection(card.dataset.pageKey);
  }
});

// Listen on the whole document rather than only on the drop-zone. Without a
// document-level dragover handler, some browsers navigate to the PDF instead
// of dispatching a usable drop when the pointer crosses a child element.
document.addEventListener("dragenter", (event) => {
  if (isInternalReorderDrag()) {
    return;
  }
  event.preventDefault();
  externalFileDragDepth += 1;
  elements.dropZone.classList.add("dragging");
  document.documentElement.classList.add("file-dragging");
});

document.addEventListener("dragover", (event) => {
  if (isInternalReorderDrag()) {
    return;
  }
  // Some browsers deliberately hide DataTransfer types until the drop event.
  // Cancelling all non-internal drags keeps their default PDF navigation from
  // winning even in that case.
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "copy";
  }
});

document.addEventListener("dragleave", (event) => {
  if (isInternalReorderDrag()) {
    return;
  }
  externalFileDragDepth = Math.max(0, externalFileDragDepth - 1);
  if (externalFileDragDepth === 0) {
    resetExternalFileDrag();
  }
});

document.addEventListener("drop", (event) => {
  const dataTransfer = event.dataTransfer;
  const files = getDraggedFiles(dataTransfer);
  if (isInternalReorderDrag() || files.length === 0) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  resetExternalFileDrag();
  void loadFiles(files);
});

globalThis.addEventListener("blur", resetExternalFileDrag);

function isLocalHost() {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(location.hostname);
}

// 配信された状態でだけオフライン対応を有効にする。ローカルサーバーで開いている
// ときはファイルがすでに手元にあるため利点がなく、編集中のファイルが
// キャッシュから返って古い表示になるのを避けるために登録しない。
if ("serviceWorker" in navigator && !isLocalHost()) {
  globalThis.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // オフライン対応が使えなくても、アプリ本体の動作には影響しない。
    });
  });
}

// index.html のインラインスクリプトが、起動できたかどうかを判定するために参照する。
globalThis.pdfToolsReady = true;
