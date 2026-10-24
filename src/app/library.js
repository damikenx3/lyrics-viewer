// 歌曲庫模型：內嵌檔案 + 匯入檔案 → 依專輯分組、排序後的歌曲清單。
import { parseLibraryFile } from './core.js';
import { t } from './i18n.js';
import { baseName } from './dom.js';

export const UNSORTED = '未分類';

// 顯示用的專輯名：「未分類」依介面語言顯示
export function albumLabel(title) {
  return title === UNSORTED ? t('unsorted') : title;
}

// 對不到任何歌的音訊記錄：用保存的標籤與檔名當成「只有音訊」的歌
export function audioOnlyMeta(rec) {
  const tags = (rec && rec.tags) || null;
  const title = (tags && tags.title) || baseName(rec && rec.name) || '?';
  return {
    album: tags && tags.title ? (tags.album || UNSORTED) : UNSORTED,
    title,
    artist: (tags && (tags.artist || tags.albumArtist)) || null,
    track: tags && Number.isFinite(tags.track) ? tags.track : null,
  };
}

export class Library {
  constructor() {
    // { key, path, text, cover, origin: 'embedded' | 'imported', addedAt?, omit?: Set<songId> }
    // rebuild 後另有 allIds（檔內全部的歌）與 ids（實際採用的歌）
    this.sources = [];
    this.builtAt = 0;           // 內嵌歌詞庫的建置時間（ms），與匯入的 addedAt 比新舊
    this.extras = new Map();    // songId → { album, title, artist, track }：只有音訊、沒有歌詞的歌
    this.audio = new Map();     // songId → { blob, name, type, size, song, tags, addedAt }（IndexedDB 的音訊記錄）
    this.hints = new Map();     // songId → url（內嵌 audio 路徑提示）
    this.hintFailed = new Set();
    this.tagCovers = new Map(); // 專輯名 → 圖片 URL（從音訊標籤取出）
    this.songs = [];
    this.byId = new Map();
    this.albums = [];
    this.albumByTitle = new Map();
    this.origin = new Map();    // songId → 'embedded' | 'imported' | 'audio'：目前採用的版本
    this.embeddedIds = new Set();
    this.warnings = [];
  }

  setSource(src) {
    const i = this.sources.findIndex((s) => s.key === src.key);
    if (i >= 0) this.sources[i] = src;
    else this.sources.push(src);
  }

  rebuild() {
    const order = [];
    const byId = new Map();
    const info = new Map();
    const origin = new Map();
    const stamp = new Map();   // songId → 採用版本的時間
    const embeddedIds = new Set();
    const warnings = [];

    const albumInfo = (title) => {
      let a = info.get(title);
      if (!a) {
        a = { title, artist: null, year: null, cover: null };
        info.set(title, a);
      }
      return a;
    };

    for (const src of this.sources) {
      src.allIds = new Set();
      src.ids = new Set();
      let res;
      try {
        res = parseLibraryFile(src.text, { path: src.path });
      } catch (err) {
        warnings.push(`${src.path}：${err && err.message ? err.message : err}`);
        continue;
      }
      // res.warnings 已含「路徑:行號」
      for (const w of res.warnings || []) warnings.push(w);
      const fileAlbum = res.album || {};
      const imported = src.origin === 'imported';
      // 同一首歌以較新的版本為準：內嵌版看建置時間，匯入版看加入時間（同時間時匯入的優先）
      const time = imported ? (src.addedAt || 0) : this.builtAt;
      for (const song of res.songs || []) {
        src.allIds.add(song.id);
        if (imported && src.omit && src.omit.has(song.id)) continue;
        if (!imported) embeddedIds.add(song.id);
        if (byId.has(song.id) && stamp.get(song.id) > time) continue;
        src.ids.add(song.id);
        if (!byId.has(song.id)) order.push(song.id);
        byId.set(song.id, song);
        origin.set(song.id, imported ? 'imported' : 'embedded');
        stamp.set(song.id, time);
        const a = albumInfo(song.album || UNSORTED);
        const sameAlbum = !fileAlbum.title || fileAlbum.title === song.album;
        if (sameAlbum) {
          if (fileAlbum.artist && !a.artist) a.artist = fileAlbum.artist;
          if (fileAlbum.year && !a.year) a.year = fileAlbum.year;
        }
        if (src.cover && (sameAlbum || !a.cover)) a.cover = src.cover;
        if (!a.artist && song.artist) a.artist = song.artist;
      }
    }

    // 只有音訊的歌：每一筆音訊記錄都要看得到。對不到歌詞的（包括歌名或專輯改過、id 變了的）
    // 用匯入時記下的資料或標籤顯示，使用者才能播放或刪除。
    for (const [id, rec] of this.audio) {
      if (byId.has(id)) continue;
      const x = this.extras.get(id) || audioOnlyMeta(rec);
      const song = {
        id,
        album: x.album || UNSORTED,
        artist: x.artist || null,
        track: Number.isFinite(x.track) ? x.track : null,
        title: x.title,
        credits: [],
        meta: {},
        lines: [],
        spans: [],
        timed: false,
        duration: null,
        path: null,
        audioOnly: true,
      };
      order.push(id);
      byId.set(id, song);
      origin.set(id, 'audio');
      const a = albumInfo(song.album);
      if (!a.artist && song.artist) a.artist = song.artist;
    }

    // 專輯依第一次出現的順序；「未分類」放最後。曲目依曲序，其次依出現順序。
    const groups = new Map();
    order.forEach((id, pos) => {
      const song = byId.get(id);
      const title = song.album || UNSORTED;
      if (!groups.has(title)) groups.set(title, []);
      groups.get(title).push({ song, pos });
    });
    const titles = [...groups.keys()].sort((a, b) => (a === UNSORTED) - (b === UNSORTED));

    const albums = [];
    const songs = [];
    for (const title of titles) {
      const list = groups.get(title)
        .sort((x, y) => (x.song.track ?? Infinity) - (y.song.track ?? Infinity) || x.pos - y.pos)
        .map((x) => x.song);
      const a = info.get(title) || { title, artist: null, year: null, cover: null };
      const album = {
        key: title,
        title,
        artist: a.artist,
        year: a.year,
        cover: a.cover || this.tagCovers.get(title) || null,
        songs: list,
      };
      albums.push(album);
      songs.push(...list);
    }

    this.byId = byId;
    this.songs = songs;
    this.albums = albums;
    this.albumByTitle = new Map(albums.map((a) => [a.title, a]));
    this.origin = origin;
    this.embeddedIds = embeddedIds;
    this.warnings = warnings;
  }

  // 編輯模式：這首歌有使用者連結（存在 IndexedDB）的音訊
  canRemoveAudio(id) {
    return this.audio.has(id);
  }

  // 編輯模式：目前顯示的是匯入的歌詞；移除後恢復內嵌版本（有的話）
  canRemoveLyrics(id) {
    return this.origin.get(id) === 'imported';
  }

  hasEmbedded(id) {
    return this.embeddedIds.has(id);
  }

  // 有東西可以移除（決定編輯按鈕要不要啟用）
  hasRemovable() {
    if (this.audio.size) return true;
    for (const o of this.origin.values()) if (o === 'imported') return true;
    return false;
  }

  albumOf(song) {
    return song ? this.albumByTitle.get(song.album || UNSORTED) || null : null;
  }

  // 音訊來源：使用者連結的 Blob 優先，其次是內嵌路徑提示
  audioSourceFor(id) {
    const rec = this.audio.get(id);
    if (rec && rec.blob) return { kind: 'blob', blob: rec.blob, name: rec.name, type: rec.type };
    const url = this.hints.get(id);
    if (url && !this.hintFailed.has(id)) return { kind: 'url', url, name: decodeURIComponent(url.replace(/^.*\//, '')) };
    return null;
  }

  hasAudio(id) {
    return !!this.audioSourceFor(id);
  }

  neighbor(id, dir) {
    if (!this.songs.length) return null;
    const i = this.songs.findIndex((s) => s.id === id);
    if (i < 0) return this.songs[0];
    const j = i + dir;
    if (j < 0 || j >= this.songs.length) return null;
    return this.songs[j];
  }

  // 媒體鍵用：只在有音訊的歌之間移動（換到沒有音訊的歌時，Android 會收掉通知列的媒體控制）
  neighborWithAudio(id, dir) {
    const i = this.songs.findIndex((s) => s.id === id);
    if (i < 0) return null;
    for (let j = i + dir; j >= 0 && j < this.songs.length; j += dir) {
      if (this.hasAudio(this.songs[j].id)) return this.songs[j];
    }
    return null;
  }
}
