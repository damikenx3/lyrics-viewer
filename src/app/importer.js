// 檔案匯入：.md 歌詞與音訊。結果寫進歌曲庫並保存到 IndexedDB。
// 另外負責編輯模式的移除（先改記憶體、延後才寫入 IndexedDB，讓使用者能復原）。
import { parseLibraryFile, readTags, matchAudio, songId } from './core.js';
import { UNSORTED } from './library.js';
import { fileExt, baseName } from './dom.js';
import { canPlay, guessMime } from './transport.js';
import { resizeCover } from './cover.js';
import { put, getAll, remove, STORES, storageIsDurable } from './store.js';

const LYRIC_EXT = new Set(['md', 'markdown']);
const AUDIO_EXT = new Set(['flac', 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav']);

// 同一批選了同一首的多個音檔時的音質等級：無損 ＞ AAC／Opus／Vorbis ＞ MP3
const QUALITY = { flac: 3, wav: 3, m4a: 2, aac: 2, opus: 2, ogg: 2, oga: 2, mp3: 1 };

export function classify(file) {
  const ext = fileExt(file.name);
  if (LYRIC_EXT.has(ext)) return 'lyrics';
  if (AUDIO_EXT.has(ext) || (file.type && file.type.startsWith('audio/'))) return 'audio';
  return 'other';
}

export function emptySummary() {
  return {
    lyricFiles: 0,
    songs: 0,
    lyricTitles: [],                  // 匯入的歌名（提示裡列出）
    audio: [],                        // [{ name, id, title, created, album }]
    unsupported: [],                  // [{ name, fmt }]
    failed: [],                       // [{ name, why, msg? }]
    duplicates: [],                   // [{ name, kept }]：同一批同一首、音質較差而略過
    skipped: [],                      // 不是歌詞也不是音訊的檔名
    moved: new Map(),                 // 舊 id → 新 id：只有音訊的歌配上了匯入的歌詞
    quota: false,
    volatile: false,
  };
}

// 從 IndexedDB 還原先前匯入的檔案；回傳 false 代表保存層無法使用
export async function restore(library) {
  try {
    const [files, audio, covers] = await Promise.all([
      getAll(STORES.files), getAll(STORES.audio), getAll(STORES.covers),
    ]);
    files.sort((a, b) => (a.value.addedAt || 0) - (b.value.addedAt || 0));
    for (const { key, value } of files) {
      if (value && typeof value.text === 'string') {
        library.setSource({
          key,
          path: value.path || String(key),
          text: value.text,
          cover: null,
          origin: 'imported',
          addedAt: value.addedAt || 0,
          omit: new Set(Array.isArray(value.omit) ? value.omit : []),
          savedOmit: new Set(Array.isArray(value.omit) ? value.omit : []),
        });
      }
    }
    for (const { key, value } of audio) {
      if (!value || !value.blob) continue;
      library.audio.set(key, value);
      if (value.song) library.extras.set(key, value.song);
    }
    for (const { key, value } of covers) {
      if (value && value.blob) library.tagCovers.set(key, URL.createObjectURL(value.blob));
    }
    return true;
  } catch {
    return false;
  }
}

// ctx：{ library, audioEl }；onProgress(done, total) 在每個檔案處理完時呼叫
export async function importFiles(files, ctx, onProgress) {
  const { library } = ctx;
  const summary = emptySummary();
  const total = files.length;
  let done = 0;
  const tick = () => {
    done++;
    if (onProgress) onProgress(done, total);
  };

  const lyrics = [];
  const audio = [];
  for (const f of files) {
    const kind = classify(f);
    if (kind === 'lyrics') lyrics.push(f);
    else if (kind === 'audio') audio.push(f);
    else {
      summary.skipped.push(f.name);
      tick();
    }
  }

  for (const f of lyrics) {
    await importLyricFile(f, library, summary);
    tick();
  }
  if (lyrics.length) {
    library.rebuild();
    summary.moved = await rematchOrphans(library, summary);
  }

  // 先讀標籤、配對，同一首只留音質最好的一個，再寫入
  const picks = [];
  for (const f of audio) {
    const p = await analyzeAudio(f, null, ctx, summary);
    if (p) picks.push(p);
    else tick();
  }
  const best = new Map();
  for (const p of picks) {
    const cur = best.get(p.id);
    if (!cur || better(p.file, cur.file) > 0) best.set(p.id, p);
  }
  for (const p of picks) {
    const keep = best.get(p.id);
    if (keep === p) continue;
    summary.duplicates.push({ name: p.file.name, kept: keep.file.name });
    tick();
  }
  for (const p of best.values()) {
    await commitAudio(p, ctx, summary);
    tick();
  }
  library.rebuild();
  return summary;
}

async function importLyricFile(f, library, summary) {
  let text;
  try {
    text = await f.text();
  } catch {
    summary.failed.push({ name: f.name, why: 'whyUnreadable' });
    return;
  }
  let res;
  try {
    res = parseLibraryFile(text, { path: f.name });
  } catch (err) {
    summary.failed.push({ name: f.name, why: 'whyParse', msg: err && err.message ? err.message : '' });
    return;
  }
  if (!res.songs || !res.songs.length) {
    summary.failed.push({ name: f.name, why: 'whyNoSongs' });
    return;
  }
  const key = `import:${f.name}`;
  const addedAt = Date.now();
  // 重新匯入同名檔案：使用者主動的操作，先前在編輯模式移除的歌也一起回來
  library.setSource({ key, path: f.name, text, cover: null, origin: 'imported', addedAt, omit: new Set(), savedOmit: new Set() });
  summary.lyricFiles++;
  summary.songs += res.songs.length;
  for (const s of res.songs) summary.lyricTitles.push(s.title);
  noteStore(summary, await put(STORES.files, key, { path: f.name, text, addedAt }));
}

function quality(file) {
  return QUALITY[fileExt(file.name)] || 0;
}

// 正數代表 a 比 b 好：音質等級高的優先，同等級取檔案較大者
function better(a, b) {
  return quality(a) - quality(b) || (a.size || 0) - (b.size || 0);
}

// 把一個音檔綁到指定的歌（target）或自動配對，並寫入
export async function attachAudio(file, target, ctx, summary) {
  const p = await analyzeAudio(file, target, ctx, summary);
  if (!p) return null;
  await commitAudio(p, ctx, summary);
  return p.id;
}

// 讀標籤並決定要綁到哪首歌；還不寫入。回傳 null 代表格式不支援。
async function analyzeAudio(file, target, ctx, summary) {
  const { library, audioEl } = ctx;
  const type = guessMime(file.name, file.type);
  if (canPlay(audioEl, file.name, type) === '') {
    summary.unsupported.push({ name: file.name, fmt: fileExt(file.name).toUpperCase() || '?' });
    return null;
  }
  let tags = null;
  try {
    tags = await readTags(file);
  } catch {
    tags = null;
  }

  let id = target ? target.id : null;
  if (!id) {
    // 先找有歌詞的歌，找不到才退回只有音訊的歌（避免同一個檔再次匯入時又配回替身）
    const withLyrics = library.songs.filter((s) => !s.audioOnly);
    try {
      id = matchAudio({ fileName: file.name, tags }, withLyrics) || matchAudio({ fileName: file.name, tags }, library.songs);
    } catch {
      id = null;
    }
  }
  let songMeta = null;
  if (!id || !library.byId.has(id)) {
    const title = (tags && tags.title) || baseName(file.name);
    const album = tags && tags.title ? (tags.album || UNSORTED) : UNSORTED;
    id = songId(album, title);
    songMeta = {
      album,
      title,
      artist: (tags && (tags.artist || tags.albumArtist)) || null,
      track: tags && Number.isFinite(tags.track) ? tags.track : null,
    };
    if (library.byId.has(id)) songMeta = null;
  } else if (library.extras.has(id)) {
    songMeta = library.extras.get(id);
  }
  return { file, type, tags, id, songMeta };
}

async function commitAudio({ file, type, tags, id, songMeta }, ctx, summary) {
  const { library } = ctx;
  let created = false;
  if (songMeta && !library.byId.has(id) && !library.extras.has(id)) created = true;
  if (songMeta) library.extras.set(id, songMeta);

  const rec = { blob: file, name: file.name, type, size: file.size, song: songMeta, tags: plainTags(tags), addedAt: Date.now() };
  library.audio.set(id, rec);
  library.hintFailed.delete(id);
  noteStore(summary, await put(STORES.audio, id, rec));

  // 標籤內的封面 → 專輯沒有封面時採用
  if (tags && tags.picture && tags.picture.data) {
    const song = library.byId.get(id);
    const albumTitle = (song && song.album) || (songMeta && songMeta.album) || UNSORTED;
    const album = library.albumByTitle.get(albumTitle);
    if (!library.tagCovers.has(albumTitle) && !(album && album.cover && !album.cover.startsWith('blob:'))) {
      const blob = await resizeCover(tags.picture.data, tags.picture.mime);
      if (blob) {
        library.tagCovers.set(albumTitle, URL.createObjectURL(blob));
        noteStore(summary, await put(STORES.covers, albumTitle, { blob, addedAt: Date.now() }));
      }
    }
  }

  const name = (library.byId.get(id) || songMeta || {}).title || baseName(file.name);
  summary.audio.push({ name: file.name, id, title: name, created, album: songMeta ? songMeta.album : null });
}

// 只保存比對用的標籤欄位（不含封面圖）
function plainTags(tags) {
  if (!tags) return null;
  const { title, artist, album, albumArtist, track, disc } = tags;
  return { title: title || null, artist: artist || null, album: album || null, albumArtist: albumArtist || null, track: track ?? null, disc: disc ?? null };
}

// 「只有音訊」的歌（包括歌名或專輯改過、id 對不到歌詞的舊記錄）重新配對到有歌詞的歌，
// 配上了就把保存的 key 改過去。還原時與匯入歌詞後呼叫。
// 回傳 Map（舊 id → 新 id），讓呼叫端把目前的歌、上次播放的歌跟著換過去。
export async function rematchOrphans(library, summary) {
  const withLyrics = library.songs.filter((s) => !s.audioOnly);
  const moves = new Map();
  let changed = false;
  for (const [oldId] of [...library.extras]) {
    const rec = library.audio.get(oldId);
    const song = library.byId.get(oldId);
    if (song && !song.audioOnly) {
      // 同一個 id 已經有歌詞了：替身資料不再需要
      library.extras.delete(oldId);
      if (rec && rec.song) {
        rec.song = null;
        noteStore(summary, await put(STORES.audio, oldId, rec));
      }
      changed = true;
    }
  }
  for (const orphan of library.songs.filter((s) => s.audioOnly)) {
    const oldId = orphan.id;
    const rec = library.audio.get(oldId);
    if (!rec) continue;
    let id = null;
    try {
      id = matchAudio({ fileName: rec.name, tags: rec.tags || null }, withLyrics);
    } catch {
      id = null;
    }
    if (!id || id === oldId || library.audio.has(id)) continue;
    const moved = { ...rec, song: null };
    // 先寫新 key，成功了才刪舊的；寫不進去（例如容量不足）就留在原處，下次還原再試
    const r = await put(STORES.audio, id, moved);
    noteStore(summary, r);
    if (!r.ok) continue;
    library.audio.set(id, moved);
    library.audio.delete(oldId);
    library.extras.delete(oldId);
    await remove(STORES.audio, oldId);
    moves.set(oldId, id);
    changed = true;
  }
  if (changed) library.rebuild();
  return moves;
}

// ───────────── 編輯模式的移除 ─────────────
// 回傳 { undo(), commit() }：呼叫時只改記憶體；commit 才寫入 IndexedDB。
// 等待期間使用者若重新匯入同一首（或同一個檔），以新的為準：undo 與 commit 都不再動它。

// 移除連結的音訊（連同 IndexedDB 裡的 Blob）
export function removeAudio(library, id) {
  const rec = library.audio.get(id);
  if (!rec) return null;
  const extra = library.extras.get(id);
  library.audio.delete(id);
  library.extras.delete(id);
  library.rebuild();
  return {
    undo() {
      if (library.audio.has(id)) return false;
      library.audio.set(id, rec);
      if (extra) library.extras.set(id, extra);
      library.rebuild();
      return true;
    },
    async commit() {
      if (library.audio.has(id)) return;
      await remove(STORES.audio, id);
    },
  };
}

// 移除匯入的歌詞：這首歌從所有匯入的檔案裡拿掉，恢復成內嵌版本；沒有內嵌版本就整首移除。
// 檔案裡的其他歌不受影響；整個檔案都被拿掉時刪除這筆記錄。
export function removeImportedLyrics(library, id) {
  const touched = library.sources.filter((s) => s.origin === 'imported' && s.allIds && s.allIds.has(id) && !(s.omit && s.omit.has(id)));
  if (!touched.length) return null;
  for (const src of touched) {
    if (!src.omit) src.omit = new Set();
    src.omit.add(id);
  }
  library.rebuild();
  const alive = (src) => library.sources.includes(src);
  return {
    undo() {
      let any = false;
      for (const src of touched) {
        if (!alive(src)) continue;
        src.omit.delete(id);
        any = true;
      }
      if (any) library.rebuild();
      return any;
    },
    // 只寫入這一筆：其他還在等待（可能會被復原）的移除不跟著存進去，所以另外記一份已保存的 savedOmit
    async commit() {
      for (const src of touched) {
        if (!alive(src) || !src.omit.has(id)) continue;
        if (!src.savedOmit) src.savedOmit = new Set();
        src.savedOmit.add(id);
        const left = [...src.allIds].filter((x) => !src.savedOmit.has(x));
        if (!left.length) {
          library.sources.splice(library.sources.indexOf(src), 1);
          await remove(STORES.files, src.key);
        } else {
          await put(STORES.files, src.key, { path: src.path, text: src.text, addedAt: src.addedAt || 0, omit: [...src.savedOmit] });
        }
      }
    },
  };
}

function noteStore(summary, r) {
  if (r.ok) return;
  if (r.quota) summary.quota = true;
  else summary.volatile = true;
  if (!storageIsDurable()) summary.volatile = true;
}
