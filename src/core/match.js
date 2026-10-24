// 音檔 ↔ 歌曲配對。
import { normalizeTitle } from './normalize.js';

function baseName(p) {
  const parts = String(p || '').replace(/\\/g, '/').split('/');
  return (parts[parts.length - 1] || '').normalize('NFC').toLowerCase();
}

function stripExt(name) {
  return name.replace(/\.[^.]+$/, '');
}

function leadingNumber(name) {
  const m = /^\s*(\d+)/.exec(name);
  return m ? Number(m[1]) : null;
}

// 伴奏版：檔名或標籤歌名有這些字樣、但歌曲名稱沒有時，不配對（避免把 off vocal 當成原曲）
const INSTRUMENTAL_RE = /(?<![a-z])(instrumental|inst|off[\s_.-]*vocal|karaoke)(?![a-z])|オフボーカル|カラオケ|インスト/i;
const isInstrumental = (s) => INSTRUMENTAL_RE.test(String(s || '').normalize('NFKC'));

// 「檔名包含歌名」的比對。
// - 歌名正規化後全是英數：要對在字詞邊界（"Ai" 不會配到 "Daisuki"、"Rain"）。
// - 其他歌名：正規化後至少 3 個字（「みこ」這種短名太容易出現在歌手名或別的歌名裡）。
function containsTitle(stem, title) {
  const t = normalizeTitle(title);
  if (!t) return false;
  if (/^[a-z0-9]+$/.test(t)) {
    // 檔名只留英數字元比對，並記住每個字元在原字串的位置，檢查前後是否為字詞邊界
    const s = stem.normalize('NFKC').toLowerCase();
    let alnum = '';
    const pos = [];
    for (let i = 0; i < s.length; i++) {
      if (/[a-z0-9]/.test(s[i])) {
        alnum += s[i];
        pos.push(i);
      }
    }
    for (let k = alnum.indexOf(t); k >= 0; k = alnum.indexOf(t, k + 1)) {
      const before = pos[k] > 0 ? s[pos[k] - 1] : '';
      const after = s[pos[k + t.length - 1] + 1] || '';
      if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    }
    return false;
  }
  return t.length >= 3 && normalizeTitle(stem).includes(t);
}

// 回傳 { id, by } 或 null；by 表示配對依據：'meta' | 'tags' | 'filename'。
// build 用 by 決定同一首歌有多個音檔時要選哪個。
export function matchAudioDetail({ fileName, tags } = {}, songs) {
  const name = baseName(fileName);
  const stem = stripExt(name);
  tags = tags || {};

  // 1. 歌曲 meta 的 audio 檔名。先比完整檔名，再比去掉副檔名（同一首轉成 mp3 也認得）。
  //    這是使用者明確指定的，不套用下面的伴奏版與曲序檢查。
  if (name) {
    for (const s of songs) if (s.meta?.audio && baseName(s.meta.audio) === name) return { id: s.id, by: 'meta' };
    for (const s of songs) if (s.meta?.audio && stripExt(baseName(s.meta.audio)) === stem) return { id: s.id, by: 'meta' };
  }

  const instrumental = isInstrumental(stem) || isInstrumental(tags.title);
  const usable = songs.filter((s) => !instrumental || isInstrumental(s.title));
  const tagAlbum = tags.album ? normalizeTitle(tags.album) : null;
  const tagTrack = tags.track ?? null;
  const albumOk = (s) => tagAlbum != null && normalizeTitle(s.album) === tagAlbum;
  const trackOk = (s, track) => track != null && s.track === track;
  // 平手時：曲序相同 > 專輯相同 > 歌名較長（「Story」與「Star Story」都被包含時選後者）
  const rank = (cands, track) =>
    cands
      .map((s) => ({ s, score: (trackOk(s, track) ? 4 : 0) + (albumOk(s) ? 2 : 0), len: normalizeTitle(s.title).length }))
      .sort((a, b) => b.score - a.score || b.len - a.len)[0].s;

  // 2. 標籤的歌名。標籤有專輯或曲序時，至少要有一項對得上，否則視為別張專輯的同名曲，不配。
  if (tags.title) {
    const t = normalizeTitle(tags.title);
    let cands = usable.filter((s) => normalizeTitle(s.title) === t);
    if (cands.length && (tagAlbum != null || tagTrack != null)) {
      cands = cands.filter((s) => albumOk(s) || trackOk(s, tagTrack));
      if (!cands.length) return null;
    }
    if (cands.length) return { id: rank(cands, tagTrack).id, by: 'tags' };
  }

  // 3. 檔名包含歌名。檔名開頭有數字（曲序）時，曲序必須相同：
  //    「05 March of Something」不會配到第 4 首的「March」。
  if (stem) {
    const track = tagTrack ?? leadingNumber(stem);
    const cands = usable.filter((s) => containsTitle(stem, s.title) && (leadingNumber(stem) == null || s.track == null || s.track === track));
    if (cands.length) return { id: rank(cands, track).id, by: 'filename' };
  }
  return null;
}

export function matchAudio(file, songs) {
  const r = matchAudioDetail(file, songs);
  return r ? r.id : null;
}
