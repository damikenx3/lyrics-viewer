// 收集歌詞庫：解析 .md、內嵌封面、掃描音檔並產生路徑提示。build / check / serve 共用。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseLibraryFile } from '../src/core/parse.js';
import { matchAudioDetail } from '../src/core/match.js';
import { readTags } from '../src/core/tags.js';

export const COVER_WARN_BYTES = 400 * 1024;
export const AUDIO_EXTS = new Set(['.flac', '.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.weba', '.webm']);
const IMAGE_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
// 同一首歌有多個音檔時的格式偏好：無損優先（桌機 file:// 與 serve 都能直接播 FLAC）。
const FORMAT_RANK = { '.flac': 5, '.wav': 4, '.m4a': 3, '.ogg': 3, '.oga': 3, '.opus': 3, '.aac': 2, '.mp3': 2, '.webm': 1, '.weba': 1 };
const MATCH_RANK = { meta: 3, tags: 2, filename: 1 };

const naturalCompare = (a, b) => a.localeCompare(b, 'ja', { numeric: true });

export async function walk(dir, accept) {
  const out = [];
  async function rec(d) {
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await rec(p);
      else if (e.isFile() && accept(e.name)) out.push(p);
    }
  }
  await rec(dir);
  return out.sort((a, b) => naturalCompare(a, b));
}

export const toPosix = (p) => p.split(path.sep).join('/');
export const displayPath = (abs) => {
  const rel = path.relative(process.cwd(), abs);
  return toPosix(rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs);
};

function lineOf(text, re) {
  const lines = text.split(/\r\n|\n|\r/);
  const k = lines.findIndex((l) => re.test(l));
  return k >= 0 ? k + 1 : 1;
}

// audioUrl(absPath) → 寫進 library.audio 的 URL。display(absPath) → 訊息裡顯示的歌詞檔路徑。
export async function collectLibrary({ libraryDir, audioDir = libraryDir, audioUrl, display = displayPath }) {
  const issues = []; // { level, file, line, message }
  const add = (level, file, line, message) => issues.push({ level, file, line, message });

  if (!fs.existsSync(libraryDir) || !fs.statSync(libraryDir).isDirectory()) {
    add('error', displayPath(libraryDir), null, '找不到歌詞庫資料夾');
    return { library: null, files: [], audio: [], issues };
  }

  // 歌詞庫本身是一個 repo：README.md 和根目錄 docs/ 裡的是說明文件（例如格式規格的副本），不是歌詞
  const mdFiles = await walk(libraryDir, (n) => n.toLowerCase().endsWith('.md') && n.toLowerCase() !== 'readme.md');
  const files = [];
  const libFiles = [];
  // 一首歌一個檔，同專輯的每個檔都寫同一張封面：每張專輯的每張圖只內嵌一次（app 取專輯裡有封面的那個檔）
  const embeddedCovers = new Set();
  for (const abs of mdFiles) {
    const rel = toPosix(path.relative(libraryDir, abs));
    if (rel.split('/')[0].toLowerCase() === 'docs') continue;
    const shown = display(abs);
    const text = await fsp.readFile(abs, 'utf8');
    const result = parseLibraryFile(text, { path: rel });
    for (const x of result.issues) add(x.level, shown, x.line, x.message);

    let cover = null;
    if (result.album.cover) {
      const coverAbs = path.resolve(path.dirname(abs), result.album.cover);
      const coverKey = `${result.album.title}\0${coverAbs}`;
      const mime = IMAGE_MIME[path.extname(coverAbs).toLowerCase()];
      const line = lineOf(text, /^\s*cover\s*:/);
      if (!mime) add('warning', shown, line, `封面格式不支援：${result.album.cover}（可用 jpg / png / webp / gif）`);
      else if (!fs.existsSync(coverAbs)) add('warning', shown, line, `找不到封面圖檔：${result.album.cover}`);
      else if (embeddedCovers.has(coverKey)) {
        // 已經內嵌過
      } else {
        embeddedCovers.add(coverKey);
        const buf = await fsp.readFile(coverAbs);
        if (buf.length > COVER_WARN_BYTES) {
          add('warning', shown, line, `封面圖檔 ${Math.round(buf.length / 1024)} KB，超過 ${COVER_WARN_BYTES / 1024} KB，會讓 HTML 變大（建議縮到 800px 以內的 JPEG）`);
        }
        cover = `data:${mime};base64,${buf.toString('base64')}`;
      }
    }
    files.push({ abs, rel, shown, text, result, coverBytes: cover ? cover.length : 0 });
    libFiles.push({ path: rel, text, cover });
  }

  // 跨檔案的重複歌曲（同專輯同名）：音訊快取以 songId 為 key，撞名會互相覆蓋。
  const seen = new Map(); // songId → { file, line }
  for (const f of files) {
    f.result.songs.forEach((s, k) => {
      const line = f.result.songLines[k];
      const first = seen.get(s.id);
      if (first && first.file !== f.shown) add('error', f.shown, line, `歌曲「${s.title}」與 ${first.file}:${first.line} 的歌同名且同專輯`);
      else if (!first) seen.set(s.id, { file: f.shown, line });
    });
  }

  // 音檔
  const songs = files.flatMap((f) => f.result.songs);
  const audio = []; // { abs, shown, tags, match }
  if (audioDir && fs.existsSync(audioDir)) {
    const audioFiles = await walk(audioDir, (n) => AUDIO_EXTS.has(path.extname(n).toLowerCase()));
    for (const abs of audioFiles) {
      let tags = null;
      try {
        // 建置只需要配對用的文字標籤，不讀封面
        tags = await readTags(await fs.openAsBlob(abs), { picture: false });
      } catch (e) {
        add('warning', displayPath(abs), null, `讀取音檔標籤失敗：${e.message}`);
      }
      const match = matchAudioDetail({ fileName: path.basename(abs), tags }, songs);
      audio.push({ abs, shown: displayPath(abs), tags, match });
    }
  } else if (audioDir) {
    add('warning', displayPath(audioDir), null, '找不到音檔資料夾');
  }
  const best = new Map(); // songId → audio entry
  const score = (a) => MATCH_RANK[a.match.by] * 100 + (FORMAT_RANK[path.extname(a.abs).toLowerCase()] || 0);
  for (const a of audio) {
    if (!a.match) continue;
    const cur = best.get(a.match.id);
    if (!cur || score(a) > score(cur)) best.set(a.match.id, a);
  }
  const audioMap = {};
  for (const [id, a] of best) audioMap[id] = audioUrl(a.abs);

  const library = { version: 1, builtAt: new Date().toISOString(), files: libFiles, audio: audioMap };
  return { library, files, audio, best, issues };
}

// 相對於輸出 HTML 的 URL（每段 encodeURIComponent）。不同磁碟機時退回 file:// URL。
export function relativeUrl(fromDir, abs) {
  const rel = path.relative(fromDir, abs);
  if (path.isAbsolute(rel)) return pathToFileURL(abs).href;
  return toPosix(rel).split('/').map(encodeURIComponent).join('/');
}
