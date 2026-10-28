// 歌詞庫檔案（timed markdown）解析。格式見 docs/lyrics-format.md。
//
// 除了規格的 { album, songs, warnings }，另外回傳 issues：
//   [{ level: 'error' | 'warning' | 'hint', line: 檔案行號（1 起算）, message }]
// 檔案是手動編修的，CLI 的 check / build 用 issues 以「檔名:行號」回報手誤；
// warnings 是 error 與 warning 的字串版（`路徑:行號: 訊息`），給 app 顯示用，不含 hint。
// 一個檔一首歌：songs 最多一筆。songLines[i] 是 songs[i] 的標題行號（1 起算），CLI 回報跨檔重複歌曲時用。
import { TIME_SOURCE, checkTimeParts, timeFromParts, roundTime, formatTime, TIME_EPSILON } from './time.js';
import { songId } from './normalize.js';
import { buildSpans, timelineFields } from './timeline.js';

export const UNCATEGORIZED = '未分類';

const LEAD_RE = new RegExp('^\\[\\s*' + TIME_SOURCE + '\\s*(?:-\\s*' + TIME_SOURCE + '\\s*)?\\]');
const INLINE_RE = new RegExp('^<' + TIME_SOURCE + '>');
// 「看起來像時間標記但格式不對」，套在 NFKC 後的前綴上（所以全形數字、．、［］、～ 也抓得到）：
// 數字後接 : 或 ; 的方括號／角括號，例如 [00;05.20]、[00:05.2345]、[00:01.00~00:02.00]，少了 ] 也算。
// 第一個分隔符號限定冒號／分號，避免把歌詞裡的 [1, 2, 3] 誤判成手誤。
const LOOSE_LEAD_RE = /^\[\s*\d{1,4}\s*[:;]\s*\d[\d\s:;.,~〜–—-]*\]?/;
const LOOSE_INLINE_RE = /^<\s*\d{1,4}\s*[:;]\s*\d[\d\s:;.,]*>?/;
const RANGE_TYPO_RE = /[~〜–—]/;
// 行首標記前後的分隔空白（含全形空白）
const LEAD_WS_RE = /^\s+/; // \s 含全形空白
// 從 LRC 貼來的 ID 標籤行：不顯示
const LRC_ID_RE = /^\s*\[(ti|ar|al|au|by|length|re|ve|#|offset)\s*:([^\]]*)\]\s*$/i;
// 可用反斜線跳脫的字元。規格要求 \( \（ \《 \｜；另外補上 ) ） 》 | [ ] < > # \ { }，
// 讓「行首就是 [00:00] 字樣」「行首是 # 」這類歌詞也寫得出來。
const ESCAPABLE = new Set(['(', ')', '（', '）', '《', '》', '｜', '|', '[', ']', '<', '>', '#', '\\', '{', '}']);
const OPEN = new Set(['(', '（']);
const CLOSE = new Set([')', '）']);
// 隱形 call 標記：{…} 裡的文字是 call，大括號本身不顯示
const HIDDEN_OPEN = new Set(['{']);
const HIDDEN_CLOSE = new Set(['}']);
// 振假名 base 的「漢字」：Han 文字加上 々〆ヶ（青空文庫的慣例）
const KANJI_RE = /[\p{Script=Han}々〆ヶ]/u;
const isMark = (x, marks) => x.kind === 'c' && !x.esc && marks.includes(x.ch);

// credits 判斷。除了規格列的字樣，另外接受 Words by / Written by 與中文「詞：」「曲：」開頭。
const CREDIT_RE = /\b(lyrics|words|music|composed|arranged|written)\s+by\b|作詞|作曲|編曲|^\s*(詞|曲)\s*[:：]/i;

function basename(p) {
  const parts = String(p || '').replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || '';
}

function folderName(p) {
  const parts = String(p || '').replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : null;
}

function parseFrontValue(v) {
  const s = v.trim();
  if (s.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(s);
    if (m) return m[1].replace(/\\(.)/g, '$1');
  }
  if (s.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'/.exec(s);
    if (m) return m[1].replace(/''/g, "'");
  }
  // YAML 慣例：空白後的 # 起算是註解（規格範例的 cover 行就這樣寫）。
  return s.replace(/\s+#.*$/, '').trim();
}

// 振假名（青空文庫寫法）：`漢字《よみ》` 或 `｜任意文字《よみ》`。只在同一行內配對。
// items：[{ kind: 'c', ch, esc } | { kind: 'in', ... }]，就地改寫：
// 去掉 ｜ 與《よみ》，base 字元標上 ruby（readings 的索引），base／讀音裡的行內時間移到 base 前面，
// 讓 ruby 片段保持完整一段。
function applyRuby(items, readings, warn) {
  let k = 0;
  let floor = 0; // ｜ 只往回找到上一個 ruby 結束處
  while (k < items.length) {
    if (!isMark(items[k], '《')) {
      k++;
      continue;
    }
    let close = -1;
    for (let j = k + 1; j < items.length; j++) {
      if (isMark(items[j], '》')) {
        close = j;
        break;
      }
    }
    if (close < 0) {
      warn('《 沒有對應的 》，照字面顯示（《 本身是歌詞的話請寫成 \\《）');
      return;
    }
    const reading = items
      .slice(k + 1, close)
      .filter((x) => x.kind === 'c')
      .map((x) => x.ch)
      .join('')
      .trim();
    let pipe = -1;
    for (let j = k - 1; j >= floor; j--) {
      if (isMark(items[j], '｜|')) {
        pipe = j;
        break;
      }
    }
    let baseStart = pipe >= 0 ? pipe + 1 : k;
    if (pipe < 0) {
      while (baseStart > floor && items[baseStart - 1].kind === 'c' && KANJI_RE.test(items[baseStart - 1].ch)) baseStart--;
    }
    const baseChars = items.slice(baseStart, k).filter((x) => x.kind === 'c');
    if (!reading || !baseChars.length) {
      warn(
        !reading
          ? '《》裡沒有讀音，照字面顯示'
          : '《 前面沒有漢字，也沒有用 ｜ 標出要加讀音的文字，照字面顯示（例：｜お住まい《ドメイン》；《 本身是歌詞的話請寫成 \\《）',
      );
      k = close + 1;
      floor = k;
      continue;
    }
    const id = readings.push(reading) - 1;
    const moved = items.slice(baseStart, close).filter((x) => x.kind === 'in');
    const before = items.slice(0, pipe >= 0 ? pipe : baseStart);
    const after = items.slice(close + 1);
    const base = baseChars.map((x) => ({ ...x, ruby: id }));
    items.splice(0, items.length, ...before, ...moved, ...base, ...after);
    k = before.length + moved.length + base.length;
    floor = k;
  }
}

// 從 raw[i] 開始逐字做 NFKC（最多 max 個字），map[k] 是正規化後第 k 個字在 raw 的位置，
// map[text.length] 是讀到的結尾。用來辨認全形寫成的時間手誤並算出要略過的原文長度。
function nfkcPrefix(raw, i, max = 48) {
  let text = '';
  const map = [];
  let pos = i;
  while (pos < raw.length && text.length < max) {
    const cp = String.fromCodePoint(raw.codePointAt(pos));
    const n = cp.normalize('NFKC');
    for (let k = 0; k < n.length; k++) map.push(pos);
    text += n;
    pos += cp.length;
  }
  map.push(pos);
  return { text, map };
}

// 時間手誤的說明
function looseHint(normTag, rawTag, strictRe, close) {
  if (RANGE_TYPO_RE.test(normTag)) return '範圍請用半形 -，例如 [00:01.00-00:02.00]';
  if (!normTag.trimEnd().endsWith(close)) return `少了 ${close}`;
  if (normTag !== rawTag && strictRe.test(normTag)) return `請改用半形字元：${normTag.trim()}`;
  return close === ']' ? '正確寫法 [mm:ss.xx] 或 [mm:ss.xx-mm:ss.xx]' : '行內時間的正確寫法 <mm:ss.xx>';
}

// 標題開頭的數字是曲序；以 \ 開頭可跳脫（標題本身以數字開頭、又不是曲序時用）。
function parseHeading(text) {
  const t = text.trim();
  if (t.startsWith('\\')) return { track: null, title: t.slice(1).trim() };
  const m = /^(\d+)(?:\s*[.\-]\s*|\s+)(\S.*)$/.exec(t);
  if (m) return { track: Number(m[1]), title: m[2].trim() };
  return { track: null, title: t };
}

export function parseLibraryFile(text, { path = '' } = {}) {
  const issues = [];
  const report = (level, lineNo, message) => issues.push({ level, line: lineNo + 1, message });

  let src = String(text ?? '');
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1); // BOM
  const rawLines = src
    .split(/\r\n|\n|\r/)
    .map((l) => l.replace(/[ \t]+$/, ''));

  // ---- front matter：這首歌的所有設定
  const front = {};
  const frontLine = new Map();
  let bodyStart = 0;
  if (rawLines.length && rawLines[0].trim() === '---') {
    let close = -1;
    for (let i = 1; i < rawLines.length; i++) {
      const t = rawLines[i].trim();
      if (t === '---' || t === '...') {
        close = i;
        break;
      }
    }
    if (close < 0) {
      report('error', 0, 'front matter 沒有結束的 ---（整個檔案當成一般內容解析）');
    } else {
      for (let i = 1; i < close; i++) {
        const line = rawLines[i].trim();
        if (!line || line.startsWith('#')) continue;
        const m = /^([A-Za-z][\w-]*)\s*:(.*)$/.exec(line);
        if (!m) {
          report('warning', i, `front matter 無法解析：${line}（只支援 key: value）`);
          continue;
        }
        const key = m[1].toLowerCase();
        if (frontLine.has(key)) report('warning', i, `${m[1]} 重複設定（第 ${frontLine.get(key) + 1} 行已設定），以後面這個為準`);
        frontLine.set(key, i);
        front[key] = parseFrontValue(m[2]);
      }
      bodyStart = close + 1;
    }
  }
  // 歌曲設定（給配對與時間軸用）
  const meta = {};
  if (front.audio) meta.audio = front.audio;
  if (front.offset != null && front.offset !== '') {
    const v = Number(front.offset);
    if (Number.isFinite(v)) meta.offset = v;
    else report('warning', frontLine.get('offset'), `offset 不是數字：${front.offset}（已忽略）`);
  }
  // call: hidden → 只有 {} 是 call，() 當一般文字
  let hiddenOnly = false;
  if (front.call != null && front.call !== '') {
    const v = front.call.toLowerCase();
    if (v === 'hidden') hiddenOnly = true;
    else if (v !== 'visible') report('warning', frontLine.get('call'), `call 只能是 visible 或 hidden：${front.call}（已忽略）`);
  }

  // ---- 逐行切 token（處理跨行 HTML 註解；註解只是備註，內容不使用）
  // token：x＝顯示文字的一個字元、c＝註解、lead＝行首時間、in＝行內時間、ws＝行首標記旁的分隔空白
  let open = null; // 進行中的跨行註解 { line }
  const info = [];
  for (let n = 0; n < rawLines.length; n++) {
    if (n < bodyStart) {
      info.push(null);
      continue;
    }
    const raw = rawLines[n];
    const startsInComment = open != null;
    const tokens = [];
    let bad = false; // 有格式錯誤的時間標記（已報錯並略過）
    let i = 0;

    const eatComment = (from) => {
      const close = raw.indexOf('-->', from);
      if (close < 0) {
        i = raw.length;
      } else {
        open = null;
        i = close + 3;
      }
      tokens.push({ t: 'c' });
    };
    const tryComment = () => {
      if (open) {
        eatComment(i);
        return true;
      }
      if (raw.startsWith('<!--', i)) {
        open = { line: n };
        eatComment(i + 4);
        return true;
      }
      return false;
    };
    const char = (ch, esc = false) => ({ t: 'x', ch, esc });
    // 看起來像時間但格式不對（含全形寫法、範圍用 ~、少了括號）：報錯並略過，不當歌詞顯示
    const tryLoose = (looseRe, strictRe, close) => {
      const np = nfkcPrefix(raw, i);
      const lm = looseRe.exec(np.text);
      if (!lm) return false;
      const end = np.map[lm[0].length];
      const rawTag = raw.slice(i, end);
      report('error', n, `時間格式錯：${rawTag.trim()}（${looseHint(lm[0], rawTag, strictRe, close)}）`);
      bad = true;
      i = end;
      return true;
    };

    // 從 LRC 貼來的 ID 標籤行（[ti:] [ar:] [offset:] …）：不顯示
    const lrc = startsInComment ? null : LRC_ID_RE.exec(raw);
    if (lrc) {
      const key = lrc[1].toLowerCase();
      if (key === 'offset') {
        const ms = Number(lrc[2].trim());
        const eq = Number.isFinite(ms) ? `；${raw.trim()} 相當於 offset: ${-ms / 1000}` : '';
        report('warning', n, `LRC 的 [offset:] 不支援，已忽略。請在 front matter 寫 offset: 秒，注意正負相反：LRC 的正值是提早，這裡的正值是延後${eq}`);
      } else {
        const where = { ti: '（歌名請寫在 # 標題）', ar: '（歌手請寫在 front matter 的 artist）', al: '（專輯請寫在 front matter 的 album）' }[key] || '';
        report('hint', n, `LRC 的 [${lrc[1]}:] 標籤不會顯示${where}`);
      }
      info.push({ raw, startsInComment, tokens: [{ t: 'c' }], bad: false });
      continue;
    }

    // 行首階段：空白、註解、行首時間標記
    let leadFound = false;
    const leadPhaseStart = tokens.length;
    const leadSeen = new Set();
    while (i < raw.length) {
      if (tryComment()) continue;
      const rest = raw.slice(i);
      const ws = LEAD_WS_RE.exec(rest);
      if (ws) {
        tokens.push({ t: 'lws', raw: ws[0] });
        i += ws[0].length;
        continue;
      }
      const m = raw[i] === '[' ? LEAD_RE.exec(rest) : null;
      if (m) {
        const err = checkTimeParts(m[1], m[2], m[3]) || (m[4] != null ? checkTimeParts(m[4], m[5], m[6]) : null);
        leadFound = true;
        i += m[0].length;
        if (err) {
          report('error', n, `時間格式錯：${m[0]}（${err}）`);
          bad = true;
          continue;
        }
        const start = timeFromParts(m[1], m[2], m[3]);
        let end = m[4] != null ? timeFromParts(m[4], m[5], m[6]) : null;
        if (end != null && end <= start + TIME_EPSILON) {
          report('error', n, `結束時間不晚於開始時間：${m[0]}`);
          end = null;
        }
        const key = `${start}-${end}`;
        if (leadSeen.has(key)) {
          report('warning', n, `重複的行首時間 ${m[0]}，已略過`);
          continue;
        }
        leadSeen.add(key);
        tokens.push({ t: 'lead', start, end });
        continue;
      }
      if ((raw[i] === '[' || raw[i] === '［') && tryLoose(LOOSE_LEAD_RE, LEAD_RE, ']')) {
        leadFound = true;
        continue;
      }
      break;
    }
    // 有行首標記時，標記前後的空白只是分隔，不算歌詞；否則還原成文字。
    for (let k = leadPhaseStart; k < tokens.length; k++) {
      const tok = tokens[k];
      if (tok.t !== 'lws') continue;
      if (leadFound) tok.t = 'ws';
      else tokens.splice(k, 1, ...[...tok.raw].map((ch) => char(ch)));
    }

    // 本文階段
    let warnedMidTag = false;
    while (i < raw.length) {
      if (tryComment()) continue;
      const ch = raw[i];
      if (ch === '\\' && i + 1 < raw.length && ESCAPABLE.has(raw[i + 1])) {
        tokens.push(char(raw[i + 1], true));
        i += 2;
        continue;
      }
      if (ch === '<') {
        const m = INLINE_RE.exec(raw.slice(i));
        if (m) {
          const err = checkTimeParts(m[1], m[2], m[3]);
          if (err) {
            report('error', n, `時間格式錯：${m[0]}（${err}）`);
            bad = true;
          } else tokens.push({ t: 'in', time: timeFromParts(m[1], m[2], m[3]), raw: m[0] });
          i += m[0].length;
          continue;
        }
      }
      if ((ch === '<' || ch === '＜') && tryLoose(LOOSE_INLINE_RE, INLINE_RE, '>')) continue;
      if ((ch === '[' || ch === '［') && !warnedMidTag) {
        const np = nfkcPrefix(raw, i);
        const m = LEAD_RE.exec(np.text) || LOOSE_LEAD_RE.exec(np.text);
        if (m) {
          report('warning', n, `${raw.slice(i, np.map[m[0].length]).trim()} 不在行首，會照字面顯示（行首時間要寫在最前面，行中間請用 <mm:ss.xx>）`);
          warnedMidTag = true;
        }
      }
      const cp = String.fromCodePoint(raw.codePointAt(i));
      tokens.push(char(cp));
      i += cp.length;
    }
    info.push({ raw, startsInComment, tokens, bad });
  }
  if (open) report('error', open.line, 'HTML 註解 <!-- 沒有結束的 -->（之後的內容全被當成註解）');

  const visible = (it) =>
    it.tokens
      .filter((tk) => tk.t === 'x')
      .map((tk) => tk.ch)
      .join('');

  // ---- 一個檔一首歌：從 # 標題到檔案結尾
  const headings = [];
  for (let n = bodyStart; n < rawLines.length; n++) {
    const it = info[n];
    // `#02 歌名`、`#　歌名`（全形空白）也算標題；`##` 以上不算
    if (!it.startsInComment && /^#(?!#)\s*\S/.test(it.raw)) headings.push(n);
  }
  const blocks = [];
  if (headings.length === 0) {
    // 沒有 # 標題：歌名與曲序取自檔名。
    const name = basename(path).replace(/\.[^.]+$/, '');
    const hasContent = info.slice(bodyStart).some((it) => it && it.tokens.some((tk) => tk.t !== 'c' && tk.t !== 'ws'));
    if (hasContent) blocks.push({ heading: null, from: bodyStart, to: rawLines.length, ...parseHeading(name || '無題') });
  } else {
    const h = headings[0];
    for (let n = bodyStart; n < h; n++) {
      if (visible(info[n]).trim()) {
        report('warning', n, '# 標題之前的文字會被忽略');
        break;
      }
    }
    // 第二個以後的 # 標題：照字面當歌詞顯示，並報錯
    for (const extra of headings.slice(1)) {
      report('error', extra, '一個檔只能有一首歌，這個 # 標題後面的歌請拆成另一個檔（# 開頭的歌詞請寫成 \\#）');
    }
    blocks.push({ heading: h, from: h + 1, to: rawLines.length, ...parseHeading(visible(info[h]).replace(/^#\s*/, '')) });
  }

  const fileAlbum = front.album || folderName(path) || UNCATEGORIZED;
  const album = {
    title: fileAlbum,
    artist: front.artist || null,
    year: front.year || null,
    cover: front.cover || null,
  };

  const songs = [];
  const songLines = [];
  for (const b of blocks) {
    const songStart = b.heading ?? b.from;
    const offset = typeof meta.offset === 'number' ? meta.offset : 0;
    const shift = (t) => roundTime(Math.max(0, t + offset));

    // 分類每一行
    const credits = [];
    const markers = [];
    const rows = []; // { kind: 'blank'|'lyric', n, it }
    let inCredits = true;
    for (let n = b.from; n < b.to; n++) {
      const it = info[n];
      const hasTag = it.tokens.some((tk) => tk.t === 'lead' || tk.t === 'in');
      const text = visible(it);
      const hasComment = it.startsInComment || it.tokens.some((tk) => tk.t === 'c');
      if (!text.trim()) {
        if (hasTag) {
          // 只有時間標記的行＝結束標記
          for (const tk of it.tokens) {
            if (tk.t === 'lead') markers.push(shift(tk.start));
            else if (tk.t === 'in') markers.push(shift(tk.time));
          }
          if (it.tokens.some((tk) => tk.t === 'lead' && tk.end != null)) report('warning', n, '結束標記行不需要寫結束時間，已忽略');
        } else if (!hasComment && !it.bad) {
          rows.push({ kind: 'blank', n, it });
        }
        continue;
      }
      if (inCredits && !hasTag && CREDIT_RE.test(text)) {
        credits.push(text.trim());
        continue;
      }
      inCredits = false;
      rows.push({ kind: 'lyric', n, it });
    }
    while (rows.length && rows[0].kind === 'blank') rows.shift();
    while (rows.length && rows[rows.length - 1].kind === 'blank') rows.pop();

    // 每行的字元表
    const lyric = rows.map((r) => {
      if (r.kind === 'blank') return null;
      const chars = []; // { ch, esc, call, ruby }
      const inline = []; // { idx, time, raw }
      const leads = [];
      const items = [];
      for (const tk of r.it.tokens) {
        if (tk.t === 'lead') leads.push({ start: shift(tk.start), end: tk.end != null ? shift(tk.end) : null });
        else if (tk.t === 'in') items.push({ kind: 'in', time: shift(tk.time), raw: tk.raw });
        else if (tk.t === 'x') items.push({ kind: 'c', ch: tk.ch, esc: tk.esc });
      }
      const readings = [];
      applyRuby(items, readings, (msg) => report('warning', r.n, msg));
      for (const x of items) {
        if (x.kind === 'in') inline.push({ idx: chars.length, time: x.time, raw: x.raw });
        else chars.push({ ch: x.ch, esc: x.esc, call: false, ruby: x.ruby ?? null });
      }
      // 行尾空白不顯示
      while (chars.length && /\s/.test(chars[chars.length - 1].ch)) chars.pop();
      for (const x of inline) if (x.idx > chars.length) x.idx = chars.length;
      return { chars, inline, leads, readings };
    });

    // 括號配對：可跨行（範例資料有三行長的 call），但不跨段落（空行）。
    // 沒關的括號當一般文字顯示並提出警告。
    // () 和 {} 各自配對；配成對的 {} 標上 hidden，之後拿掉不顯示。
    const flushStanza = (stanza) => {
      const seq = [];
      for (const k of stanza) for (const c of lyric[k].chars) seq.push({ c, k });
      const diff = new Array(seq.length + 1).fill(0);
      const match = (opens, closes, hidden) => {
        const stack = [];
        seq.forEach(({ c }, idx) => {
          if (c.esc) return;
          if (opens.has(c.ch)) stack.push(idx);
          else if (closes.has(c.ch)) {
            if (!stack.length) {
              report('warning', rows[seq[idx].k].n, `多餘的「${c.ch}」，前面沒有對應的開括號，當一般文字顯示`);
              return;
            }
            const o = stack.pop();
            diff[o] += 1;
            diff[idx + 1] -= 1;
            if (hidden) seq[o].c.hidden = c.hidden = true;
          }
        });
        for (const o of stack) {
          report('warning', rows[seq[o].k].n, `括號「${seq[o].c.ch}」在這段裡沒有關閉，當一般文字顯示（括號本身是歌詞的話請寫成 \\${seq[o].c.ch}）`);
        }
      };
      if (!hiddenOnly) match(OPEN, CLOSE, false);
      match(HIDDEN_OPEN, HIDDEN_CLOSE, true);
      let depth = 0;
      seq.forEach(({ c }, idx) => {
        depth += diff[idx];
        c.call = depth > 0;
      });
      // ruby 片段不切開：整段沿用 base 第一個字所在位置的 call 屬性
      let first = null;
      for (const { c, k } of seq) {
        if (c.ruby == null) first = null;
        else if (!first || first.k !== k || first.c.ruby !== c.ruby) first = { c, k };
        else c.call = first.c.call;
      }
    };
    let stanza = [];
    rows.forEach((r, k) => {
      if (r.kind === 'blank') {
        flushStanza(stanza);
        stanza = [];
      } else stanza.push(k);
    });
    flushStanza(stanza);

    // 拿掉隱形標記 {}，行內時間的位置跟著前移。
    // 拿掉後沒有文字的行（例如 { 單獨一行）比照只有時間標記的行：有時間就當結束標記，不顯示。
    const dropped = new Set();
    lyric.forEach((L, k) => {
      if (!L || !L.chars.some((c) => c.hidden)) return;
      const shiftTo = [];
      const kept = [];
      for (const c of L.chars) {
        shiftTo.push(kept.length);
        if (!c.hidden) kept.push(c);
      }
      shiftTo.push(kept.length);
      while (kept.length && /\s/.test(kept[kept.length - 1].ch)) kept.pop();
      for (const x of L.inline) x.idx = Math.min(shiftTo[x.idx], kept.length);
      L.chars = kept;
      if (kept.some((c) => c.ch.trim())) return;
      for (const ld of L.leads) markers.push(ld.start);
      for (const x of L.inline) markers.push(x.time);
      dropped.add(k);
    });
    if (dropped.size) {
      const rs = rows.filter((_, k) => !dropped.has(k));
      const ls = lyric.filter((_, k) => !dropped.has(k));
      while (rs.length && rs[0].kind === 'blank') rs.shift(), ls.shift();
      while (rs.length && rs[rs.length - 1].kind === 'blank') rs.pop(), ls.pop();
      rows.splice(0, rows.length, ...rs);
      lyric.splice(0, lyric.length, ...ls);
    }

    // 組 Line 與時間
    const lines = [];
    const lineNos = [];
    const entries = [];
    const inlineChecks = []; // 算完 span 後檢查行內時間是否晚於行的結束
    rows.forEach((r, k) => {
      const index = lines.length;
      lineNos.push(r.n);
      if (r.kind === 'blank') {
        lines.push({ index, blank: true, segments: [], times: [] });
        return;
      }
      const L = lyric[k];
      const atByIdx = new Map();
      for (const x of L.inline) atByIdx.set(x.idx, x.time); // 同位置多個標記取最後一個
      // 行內時間往後傳：標記之後的片段即使被 call 或 ruby 切開，也帶著同一個 at，直到下一個標記。
      const segments = [];
      let cur = null;
      let curRuby = null;
      let curAt = null;
      L.chars.forEach((c, idx) => {
        const marked = atByIdx.has(idx);
        if (marked) curAt = atByIdx.get(idx);
        if (!cur || cur.call !== c.call || marked || c.ruby !== curRuby) {
          cur = { text: '', call: c.call, at: curAt, ruby: c.ruby == null ? null : L.readings[c.ruby] };
          curRuby = c.ruby;
          segments.push(cur);
        }
        cur.text += c.ch;
      });
      lines.push({ index, blank: false, segments, times: [] });

      for (const x of L.inline) {
        if (x.idx < L.chars.length) continue;
        const isStart = !L.leads.length && x === L.inline[0];
        report('warning', r.n, `行尾的 ${x.raw} 後面沒有文字${isStart ? '，被當成這行的開始時間（開始時間請寫在行首 [mm:ss.xx]）' : '，不會有作用'}`);
      }
      if (L.leads.length) {
        for (const ld of L.leads) entries.push({ line: index, start: ld.start, end: ld.end });
        const first = Math.min(...L.leads.map((ld) => ld.start));
        for (const x of L.inline) {
          if (x.time < first - TIME_EPSILON) report('warning', r.n, `行內時間 ${x.raw} 早於這行的開始時間 ${formatTime(first)}`);
        }
      } else if (L.inline.length) {
        entries.push({ line: index, start: L.inline[0].time, end: null });
      }
      inlineChecks.push({ index, n: r.n, inline: L.inline });
    });

    // 開始時間倒退：只比較單一開始時間的行（LRC 重複行的多重標記本來就不單調）。
    const startsPerLine = new Map();
    for (const e of entries) startsPerLine.set(e.line, (startsPerLine.get(e.line) || 0) + 1);
    let prev = null;
    for (const e of entries) {
      if (startsPerLine.get(e.line) !== 1) continue;
      if (prev && e.start < prev.start - TIME_EPSILON) {
        report('warning', lineNos[e.line], `開始時間 ${formatTime(e.start)} 比前面第 ${lineNos[prev.line] + 1} 行的 ${formatTime(prev.start)} 早（時間倒退）`);
      }
      prev = e;
    }

    const spans = buildSpans(entries, markers);
    const tl = timelineFields(lines, spans);
    // 行內時間不早於該行（第一次出現）的結束：後面的片段永遠不會亮
    for (const { index, n, inline } of inlineChecks) {
      const line = lines[index];
      if (!line.times.length) continue;
      const firstSpan = tl.spans.find((s) => s.line === index && s.start === line.times[0]);
      for (const x of inline) {
        if (x.time >= firstSpan.end - TIME_EPSILON) {
          report('warning', n, `行內時間 ${x.raw} 不早於這行的結束時間 ${formatTime(firstSpan.end)}，後面的文字不會亮`);
        }
      }
    }
    if (tl.timed) {
      for (const line of lines) {
        if (!line.blank && line.times.length === 0) report('hint', lineNos[line.index], '這行沒有時間（這首歌有時間軸，這行不會亮）');
      }
    }

    const song = {
      id: songId(fileAlbum, b.title),
      album: fileAlbum,
      artist: front.artist || null,
      track: b.track,
      title: b.title,
      credits,
      meta,
      lines,
      spans: tl.spans,
      timed: tl.timed,
      duration: tl.duration,
      path,
    };
    if (!lines.some((l) => !l.blank)) report('warning', songStart, `「${b.title}」沒有歌詞`);
    songs.push(song);
    songLines.push(songStart + 1);
  }

  issues.sort((a, b) => a.line - b.line);
  const warnings = issues
    .filter((x) => x.level !== 'hint')
    .map((x) => `${path || '<text>'}:${x.line}: ${x.level === 'error' ? '錯誤：' : ''}${x.message}`);
  return { album, songs, warnings, issues, songLines };
}
