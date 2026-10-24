// 保存層：localStorage 放設定，IndexedDB 放匯入的歌詞、音訊 Blob、封面。
// 一律 feature-detect 並包 try/catch；失敗就只在本次開啟有效，由呼叫端低調告知一次。

const SETTINGS_KEY = 'lyrics-viewer.settings.v1';
const DEFAULT_SETTINGS = { calls: true, scale: 1, wakeLock: true, lastSong: null };

let settingsDurable = true;

export function loadSettings() {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return { ...DEFAULT_SETTINGS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    settingsDurable = false;
    return { ...DEFAULT_SETTINGS };
  }
}

// 回傳 false 代表沒存成功（本次開啟仍有效）
export function saveSettings(settings) {
  if (!settingsDurable) return false;
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    settingsDurable = false;
    return false;
  }
}

export function settingsAreDurable() {
  return settingsDurable;
}

// ───────────── IndexedDB ─────────────

const DB_NAME = 'lyrics-viewer';
const DB_VERSION = 1;
export const STORES = { files: 'files', audio: 'audio', covers: 'covers' };

let dbPromise = null;
let dbBroken = false;
// 被其他分頁占用（版本升級或刪除資料庫進行中）時不當成壞掉：等一下，逾時就讓下次呼叫重試
const BLOCKED_WAIT = 8000;

class BlockedError extends Error {}

function openDb() {
  if (dbBroken) return Promise.reject(new Error('IndexedDB 無法使用'));
  if (dbPromise) return dbPromise;
  const p = new Promise((resolve, reject) => {
    let req;
    try {
      if (!('indexedDB' in window) || !window.indexedDB) throw new Error('瀏覽器不支援 IndexedDB');
      req = window.indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    let blockedTimer = 0;
    let gaveUp = false;
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => {
      clearTimeout(blockedTimer);
      const db = req.result;
      // 已經逾時放棄的請求晚一步成功：關掉，不留著占用
      if (gaveUp) {
        db.close();
        return;
      }
      // 其他分頁要升級版本：讓出連線，下次使用時重新開啟
      db.onversionchange = () => {
        db.close();
        if (dbPromise === p) dbPromise = null;
      };
      // 瀏覽器自己關掉連線（例如使用者清除網站資料）：同樣下次重開
      db.onclose = () => {
        if (dbPromise === p) dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      clearTimeout(blockedTimer);
      reject(req.error || new Error('無法開啟 IndexedDB'));
    };
    // 其他分頁關閉舊連線後，這個請求會自己接著成功；等太久就先放棄這次
    req.onblocked = () => {
      clearTimeout(blockedTimer);
      blockedTimer = setTimeout(() => {
        gaveUp = true;
        reject(new BlockedError('IndexedDB 被其他分頁占用'));
      }, BLOCKED_WAIT);
    };
  }).catch((err) => {
    if (dbPromise === p) dbPromise = null;
    if (!(err instanceof BlockedError)) dbBroken = true;
    throw err;
  });
  dbPromise = p;
  return p;
}

export function storageIsDurable() {
  return !dbBroken;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('交易中止'));
  });
}

// 讀出整個 store：[{ key, value }]
export async function getAll(storeName) {
  const db = await openDb();
  const tx = db.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);
  const out = [];
  await new Promise((resolve, reject) => {
    const req = store.openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      out.push({ key: cur.key, value: cur.value });
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return out;
}

// 寫入；回傳 { ok, quota }。quota=true 代表容量不足。
export async function put(storeName, key, value) {
  try {
    const db = await openDb();
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value, key);
    await txDone(tx);
    return { ok: true, quota: false };
  } catch (err) {
    const name = err && err.name;
    return { ok: false, quota: name === 'QuotaExceededError' || /quota/i.test(String(err && err.message)) };
  }
}

export async function remove(storeName, key) {
  try {
    const db = await openDb();
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    await txDone(tx);
    return true;
  } catch {
    return false;
  }
}

// 要求持久化儲存（避免 Android 在空間吃緊時清掉音訊）；失敗無妨
export function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch { /* 忽略 */ }
}
