/*
 * 編集中の状態をIndexedDBへ保存し、画面の再読み込み後も復元できるようにする。
 * PDFの中身を含めてすべてこの端末のブラウザー内だけに留まり、外部へは送信しない。
 *
 * 「files」にはPDFごとの中身（結合順に依存しない）を、「workspace」には
 * ファイルの並び順・ページ順・書き込みなど頻繁に変わる軽い情報を分けて持つ。
 * 分けているのは、書き込みのたびにPDF本体まで丸ごと書き直すと重くなるため。
 */

const DB_NAME = "pdf-tools-session";
const DB_VERSION = 1;
const FILES_STORE = "files";
const WORKSPACE_STORE = "workspace";
const WORKSPACE_KEY = "current";

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in globalThis)) {
        reject(new Error("IndexedDB is not available."));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(FILES_STORE)) {
          db.createObjectStore(FILES_STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(WORKSPACE_STORE)) {
          db.createObjectStore(WORKSPACE_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

function withStore(storeName, mode, run) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const request = run(tx.objectStore(storeName));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      })
  );
}

export async function saveFileRecord(record) {
  try {
    await withStore(FILES_STORE, "readwrite", (store) => store.put(record));
  } catch (error) {
    console.error(error);
  }
}

export async function deleteFileRecord(id) {
  try {
    await withStore(FILES_STORE, "readwrite", (store) => store.delete(id));
  } catch (error) {
    console.error(error);
  }
}

export async function loadAllFileRecords() {
  try {
    return await withStore(FILES_STORE, "readonly", (store) => store.getAll());
  } catch (error) {
    console.error(error);
    return [];
  }
}

export async function saveWorkspace(data) {
  try {
    await withStore(WORKSPACE_STORE, "readwrite", (store) =>
      store.put({ ...data, key: WORKSPACE_KEY })
    );
  } catch (error) {
    console.error(error);
  }
}

export async function loadWorkspace() {
  try {
    return await withStore(WORKSPACE_STORE, "readonly", (store) =>
      store.get(WORKSPACE_KEY)
    );
  } catch (error) {
    console.error(error);
    return null;
  }
}

export async function clearSession() {
  try {
    await withStore(FILES_STORE, "readwrite", (store) => store.clear());
    await withStore(WORKSPACE_STORE, "readwrite", (store) => store.clear());
  } catch (error) {
    console.error(error);
  }
}
