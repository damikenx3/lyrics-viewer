// 把 src/index.html + CSS + ES modules 打包成單一 HTML（零 npm 依賴）。
//
// 模組慣例（本檔會強制檢查）：
//   - 只允許行內具名匯出：export function / export async function / export class / export const
//   - 只允許 import { a, b as c } from './相對路徑.js'
//   - 禁止 default / re-export / 匯出清單 / export let|var / namespace import /
//     side-effect import / dynamic import / import.meta / top-level await / bare specifier
//
// 做法：每個模組包成獨立的 IIFE，依 import 圖後序排列（被依賴者先），
// 以 const { a, b: c } = __lv_N 取得相依模組的匯出。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export class BundleError extends Error {}
BundleError.prototype.name = 'BundleError';

// ---------------------------------------------------------------------------
// 一、最小 JS 掃描器（tokenizer）
// ---------------------------------------------------------------------------

class ScanError extends Error {
  constructor(message, line) {
    super(message);
    this.line = line;
  }
}

// 前一個 token 是這些關鍵字時，接著的 `/` 是 regex 開頭而不是除號
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete',
  'void', 'throw', 'instanceof', 'yield', 'await', 'default', 'extends',
]);

const WS = /\s/;
const isIdStart = (c) =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$' ||
  (c > '\x7f' && !WS.test(c));
const isIdPart = (c) => isIdStart(c) || (c >= '0' && c <= '9');
const isDigit = (c) => c >= '0' && c <= '9';
const NUM_RE =
  /0[xX][\da-fA-F_]+n?|0[oO][0-7_]+n?|0[bB][01_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?n?/y;

/**
 * 把原始碼切成有意義的 token（略過空白與註解）。
 * 回傳 { tokens, comments }
 * token: { t: 'id'|'num'|'str'|'tpl'|'re'|'p', v, s, e, line, el, d, bd, end?, tag?, regexAfter? }
 *   d  = 該 token 所在位置的括號深度（開括號與其對應的閉括號 d 相同）
 *   bd = 所在位置的真正 `{}` 深度（不含 template 的 `${}`）
 *   tpl 為 template 的文字片段（end 表示是否為結尾片段；tag 為 null | 'String.raw' | 'other'，
 *       表示這個 template 是否為 tagged template）；`${` 與其對應的 `}` 另外以 p token 輸出
 *   regexAfter 只出現在 `)`／`}`：表示它是 if/while/for/with 的條件括號、或是 block 的結尾，
 *       後面接的 `/` 是 regex 開頭而不是除號
 * comments: [{ s, e }]
 */
function tokenize(src) {
  const n = src.length;
  const tokens = [];
  const comments = [];
  const stack = []; // { v: '(' | '[' | '{' | '${', line, ... }
  let braces = 0;
  let i = 0;
  let line = 1;

  const add = (t, v, s, e, startLine, extra) => {
    const tk = { t, v, s, e, line: startLine, el: line, d: stack.length, bd: braces };
    if (extra) Object.assign(tk, extra);
    tokens.push(tk);
    return tk;
  };

  // 跳過反斜線跳脫（src[j] === '\\'），回傳新的位置
  const skipEscape = (j) => {
    if (src[j + 1] === '\r' && src[j + 2] === '\n') {
      line++;
      return j + 3;
    }
    if (src[j + 1] === '\n') line++;
    return j + 2;
  };

  // 讀 template 的一段文字：s 是 token 起點，from 是內容起點，tag 是這個 template 的 tagged 種類
  const readTemplateChunk = (s, from, tag) => {
    const startLine = line;
    let j = from;
    while (j < n) {
      const c = src[j];
      if (c === '\\') {
        j = skipEscape(j);
        continue;
      }
      if (c === '`') {
        j++;
        add('tpl', src.slice(s, j), s, j, startLine, { end: true, tag });
        i = j;
        return;
      }
      if (c === '$' && src[j + 1] === '{') {
        add('tpl', src.slice(s, j), s, j, startLine, { end: false, tag });
        add('p', '${', j, j + 2, line);
        stack.push({ v: '${', line, tag });
        i = j + 2;
        return;
      }
      if (c === '\n') line++;
      j++;
    }
    throw new ScanError('template literal 沒有結尾', startLine);
  };

  // 讀 regex literal，回傳結束位置；不是合法 regex（同一行沒有結尾 `/`）回傳 -1
  const readRegex = (from) => {
    let j = from + 1;
    let inClass = false;
    while (j < n) {
      const c = src[j];
      if (c === '\n' || c === '\r') return -1;
      if (c === '\\') {
        if (src[j + 1] === '\n' || src[j + 1] === '\r') return -1;
        j += 2;
        continue;
      }
      if (inClass) {
        if (c === ']') inClass = false;
      } else if (c === '[') {
        inClass = true;
      } else if (c === '/') {
        j++;
        while (j < n && isIdPart(src[j])) j++;
        return j;
      }
      j++;
    }
    return -1;
  };

  // 目前位置的 `/` 是否為 regex 開頭（依前一個有意義的 token 判斷）
  const regexAllowed = () => {
    const prev = tokens[tokens.length - 1];
    if (!prev) return true;
    switch (prev.t) {
      case 'num':
      case 'str':
      case 're':
        return false;
      case 'tpl':
        return !prev.end;
      case 'id': {
        const before = tokens[tokens.length - 2];
        if (before && before.t === 'p' && (before.v === '.' || before.v === '?.')) return false;
        return REGEX_KEYWORDS.has(prev.v);
      }
      default:
        if (prev.v === ')' || prev.v === '}') return !!prev.regexAfter;
        return !(prev.v === ']' || prev.v === '++' || prev.v === '--');
    }
  };

  // 目前位置的 `{` 是 block（語句開頭的大括號）還是 object literal 之類的表達式
  const braceIsBlock = () => {
    const prev = tokens[tokens.length - 1];
    if (!prev) return true;
    if (prev.t === 'id') return !REGEX_KEYWORDS.has(prev.v) || prev.v === 'else' || prev.v === 'do';
    if (prev.t === 'p') return prev.v === ')' || prev.v === ';' || prev.v === '{' || prev.v === '}' || prev.v === '=>';
    return false;
  };

  // 目前位置的 `(` 是不是 if / while / for / with 的條件括號
  const parenIsCondition = () => {
    const prev = tokens[tokens.length - 1];
    if (!prev || prev.t !== 'id') return false;
    const before = tokens[tokens.length - 2];
    if (before && before.t === 'p' && (before.v === '.' || before.v === '?.')) return false;
    if (prev.v === 'await') return !!before && before.t === 'id' && before.v === 'for';
    return prev.v === 'if' || prev.v === 'while' || prev.v === 'for' || prev.v === 'with';
  };

  // 目前位置的反引號是不是 tagged template：null（一般）| 'String.raw' | 'other'
  const templateTag = () => {
    const prev = tokens[tokens.length - 1];
    if (!prev) return null;
    if (prev.t === 'p') return prev.v === ')' || prev.v === ']' ? 'other' : null;
    if (prev.t === 'tpl') return prev.end ? 'other' : null;
    if (prev.t !== 'id') return null;
    const before = tokens[tokens.length - 2];
    if (before && before.t === 'p' && (before.v === '.' || before.v === '?.')) {
      const root = tokens[tokens.length - 3];
      return prev.v === 'raw' && before.v === '.' && root && root.t === 'id' && root.v === 'String' ? 'String.raw' : 'other';
    }
    return REGEX_KEYWORDS.has(prev.v) ? null : 'other';
  };

  while (i < n) {
    const c = src[i];

    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (WS.test(c)) {
      i++;
      continue;
    }

    if (c === '/') {
      const c2 = src[i + 1];
      if (c2 === '/') {
        const start = i;
        i += 2;
        while (i < n && src[i] !== '\n' && src[i] !== '\r' && src[i] !== '\u2028' && src[i] !== '\u2029') i++;
        comments.push({ s: start, e: i });
        continue;
      }
      if (c2 === '*') {
        const end = src.indexOf('*/', i + 2);
        if (end < 0) throw new ScanError('區塊註解 /* 沒有結尾', line);
        for (let j = i; j < end; j++) if (src[j] === '\n') line++;
        comments.push({ s: i, e: end + 2 });
        i = end + 2;
        continue;
      }
      if (regexAllowed()) {
        const end = readRegex(i);
        if (end >= 0) {
          add('re', src.slice(i, end), i, end, line);
          i = end;
          continue;
        }
      }
      add('p', '/', i, i + 1, line);
      i++;
      continue;
    }

    if (c === '"' || c === "'") {
      const startLine = line;
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new ScanError('字串沒有結尾', startLine);
        const ch = src[j];
        if (ch === '\\') {
          j = skipEscape(j);
          continue;
        }
        if (ch === c) {
          j++;
          break;
        }
        if (ch === '\n') throw new ScanError('字串沒有結尾（單引號／雙引號字串不能直接換行）', startLine);
        j++;
      }
      add('str', src.slice(i, j), i, j, startLine);
      i = j;
      continue;
    }

    if (c === '`') {
      readTemplateChunk(i, i + 1, templateTag());
      continue;
    }

    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      NUM_RE.lastIndex = i;
      const m = NUM_RE.exec(src);
      const end = m ? i + m[0].length : i + 1;
      add('num', src.slice(i, end), i, end, line);
      i = end;
      continue;
    }

    if (isIdStart(c) || (c === '#' && isIdStart(src[i + 1]))) {
      let j = i + 1;
      while (j < n && isIdPart(src[j])) j++;
      add('id', src.slice(i, j), i, j, line);
      i = j;
      continue;
    }

    if (c === '(' || c === '[' || c === '{') {
      const entry = { v: c, line };
      if (c === '(') entry.cond = parenIsCondition();
      else if (c === '{') entry.block = braceIsBlock();
      add('p', c, i, i + 1, line);
      stack.push(entry);
      if (c === '{') braces++;
      i++;
      continue;
    }

    if (c === ')' || c === ']' || c === '}') {
      const top = stack[stack.length - 1];
      if (!top) throw new ScanError(`多餘的 '${c}'`, line);
      if (c === '}' && top.v === '${') {
        // template 的 `${ ... }` 結束，接著繼續讀 template 文字
        stack.pop();
        add('p', '}', i, i + 1, line);
        readTemplateChunk(i + 1, i + 1, top.tag);
        continue;
      }
      const want = c === ')' ? '(' : c === ']' ? '[' : '{';
      if (top.v !== want) {
        throw new ScanError(`'${c}' 與第 ${top.line} 行的 '${top.v}' 不成對`, line);
      }
      stack.pop();
      if (c === '}') braces--;
      add('p', c, i, i + 1, line, c === ']' ? null : { regexAfter: !!(top.cond || top.block) });
      i++;
      continue;
    }

    // 其他標點：只特別合併 => ... ?. ++ --，其餘一律單一字元
    let len = 1;
    if (c === '=' && src[i + 1] === '>') len = 2;
    else if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') len = 3;
    else if (c === '?' && src[i + 1] === '.' && !isDigit(src[i + 2])) len = 2;
    else if ((c === '+' || c === '-') && src[i + 1] === c) len = 2;
    add('p', src.slice(i, i + len), i, i + len, line);
    i += len;
  }

  if (stack.length) {
    const top = stack[stack.length - 1];
    throw new ScanError(`'${top.v}' 沒有對應的結尾`, top.line);
  }
  return { tokens, comments };
}

// ---------------------------------------------------------------------------
// 二、模組檢查與轉換
// ---------------------------------------------------------------------------

const countNewlines = (s) => {
  let k = 0;
  for (let j = 0; j < s.length; j++) if (s[j] === '\n') k++;
  return k;
};

/**
 * 檢查一個模組並做 import/export 轉換。
 * 回傳 { imports: [{ spec, names: [{ imported, local }], line }], exports: Map<name, line>, code }
 */
function analyzeModule(rel, src) {
  let tokens;
  let comments;
  try {
    ({ tokens, comments } = tokenize(src));
  } catch (err) {
    if (err instanceof ScanError) throw new BundleError(`${rel}:${err.line}: ${err.message}`);
    throw err;
  }

  const fail = (line, message) => {
    throw new BundleError(`${rel}:${line}: ${message}`);
  };
  const isP = (tk, v) => !!tk && tk.t === 'p' && tk.v === v;
  const isId = (tk, v) => !!tk && tk.t === 'id' && (v === undefined || tk.v === v);

  const edits = []; // { s, e, text }
  const imports = [];
  const exportsMap = new Map();
  const consumed = new Set(); // 已被 import 語句吃掉的 token 索引

  // `import (` 之後若是 `(...) {` 則為名為 import 的方法定義，不是 dynamic import
  const isMethodDefinition = (parenIdx) => {
    const open = tokens[parenIdx];
    for (let j = parenIdx + 1; j < tokens.length; j++) {
      if (isP(tokens[j], ')') && tokens[j].d === open.d) return isP(tokens[j + 1], '{');
    }
    return false;
  };

  // 前一個 token 是否「值已結束」、換行後的下一個 token 是否會開啟新語句（簡化版 ASI 判斷）
  const NON_VALUE_WORDS = new Set([
    'typeof', 'void', 'delete', 'new', 'in', 'instanceof', 'of', 'await', 'yield',
    'return', 'throw', 'case', 'do', 'else', 'extends',
  ]);
  const isStatementBreak = (prev, cur) => {
    if (cur.line <= prev.el) return false;
    const valueEnd =
      prev.t === 'num' || prev.t === 'str' || prev.t === 're' ||
      (prev.t === 'tpl' && prev.end) ||
      (prev.t === 'id' && !NON_VALUE_WORDS.has(prev.v)) ||
      (prev.t === 'p' && [')', ']', '}', '++', '--'].includes(prev.v));
    if (!valueEnd) return false;
    if (cur.t === 'num' || cur.t === 'str' || cur.t === 're') return true;
    if (cur.t === 'id') return cur.v !== 'in' && cur.v !== 'instanceof';
    return isP(cur, '{') || isP(cur, '++') || isP(cur, '--');
  };

  // export const a = 1, b = 2 這種一次宣告多個名稱：找 depth 0 的逗號（遇到分號或換行後的新語句為止）
  const hasTopLevelComma = (fromIdx) => {
    let prev = tokens[fromIdx - 1];
    for (let j = fromIdx; j < tokens.length; j++) {
      const t = tokens[j];
      if (t.d > 0) continue;
      if (isP(t, ';')) return false;
      if (isP(t, ',')) return true;
      if (isStatementBreak(prev, t)) return false;
      prev = t;
    }
    return false;
  };

  const addExport = (nameTok) => {
    if (exportsMap.has(nameTok.v)) fail(nameTok.line, `重複匯出 ${nameTok.v}`);
    exportsMap.set(nameTok.v, nameTok.line);
  };

  const dropExportKeyword = (tk) => {
    let e = tk.e;
    while (src[e] === ' ' || src[e] === '\t') e++;
    edits.push({ s: tk.s, e, text: '' });
  };

  // 讓輸出能安全放進 <script>：依 token 種類跳脫 </script 與 <!--（跳脫後語意不變）。
  //   字串／regex：</script → <\/script、<!-- → <\x21--
  //   template 文字：插入空的 ${''}，連 String.raw 的結果都不變
  //   註解：任意打斷即可
  //   一般程式碼：不應該出現，出現就報錯，不默默改
  const escapeForScriptTag = () => {
    const ranges = [];
    for (const tk of tokens) {
      if (tk.t === 'str' || tk.t === 're' || tk.t === 'tpl') ranges.push({ s: tk.s, e: tk.e, kind: tk.t, tk });
    }
    for (const cm of comments) ranges.push({ s: cm.s, e: cm.e, kind: 'comment' });
    ranges.sort((a, b) => a.s - b.s);
    const removed = edits.filter((ed) => ed.removed); // 整句被刪掉的 import，內容不會輸出
    const lineAt = (index) => countNewlines(src.slice(0, index)) + 1;
    let ri = 0;
    for (const m of src.matchAll(/<\/script|<!--/gi)) {
      const at = m.index;
      const end = at + m[0].length;
      if (removed.some((r) => at >= r.s && at < r.e)) continue;
      while (ri < ranges.length && ranges[ri].e <= at) ri++;
      const range = ranges[ri];
      if (!range || range.s > at || end > range.e) {
        fail(lineAt(at), `程式碼裡不可直接出現 ${m[0]}（只能出現在字串、regex、template 或註解裡；請改寫）`);
      }
      const isScript = m[0][1] === '/';
      let text;
      if (range.kind === 'tpl') {
        if (range.tk.tag === 'other') {
          fail(lineAt(at), `tagged template 內不可含 ${m[0]}（跳脫會改變它收到的字串；請改寫，或改用 String.raw）`);
        }
        text = isScript ? `<\${''}${m[0].slice(1)}` : `<!-\${''}-`;
      } else if (range.kind === 'comment') {
        text = isScript ? `<\\/${m[0].slice(2)}` : '<!- -';
      } else {
        text = isScript ? `<\\/${m[0].slice(2)}` : '<\\x21--';
      }
      edits.push({ s: at, e: end, text });
    }
  };

  // 解析頂層 import 語句，回傳最後一個被吃掉的 token 索引
  const parseImport = (idx) => {
    const kw = tokens[idx];
    const line = kw.line;
    const first = tokens[idx + 1];
    if (!first) fail(line, 'import 語句不完整');
    if (isP(first, '*')) {
      fail(line, '不允許 namespace import（import * as ns from ...；請改用 import { a, b } from ...）');
    }
    if (first.t === 'str') {
      fail(line, "不允許 side-effect import（import './x.js'；請改用 import { a } from './x.js'）");
    }
    if (first.t === 'id') {
      fail(line, '不允許 default import（import x from ...；請改用 import { x } from ...，來源模組用 export function / export const）');
    }
    if (!isP(first, '{')) {
      fail(line, "不支援的 import 寫法（只允許 import { a, b as c } from './x.js'）");
    }

    const names = [];
    let j = idx + 2;
    for (;;) {
      const a = tokens[j];
      if (!a) fail(line, 'import { ... } 沒有結尾');
      if (isP(a, '}')) {
        j++;
        break;
      }
      if (a.t !== 'id') fail(a.line, `import 名稱清單裡有不支援的寫法 ${a.v}（只允許 a 或 a as b）`);
      let imported = a.v;
      let local = a.v;
      j++;
      if (isId(tokens[j], 'as')) {
        const b = tokens[j + 1];
        if (!b || b.t !== 'id') fail(a.line, `import 名稱 ${a.v} as 後面必須接識別字`);
        local = b.v;
        j += 2;
      }
      if (imported === 'default') {
        fail(a.line, '不允許 default import（import { default as x }；請改用具名匯出）');
      }
      names.push({ imported, local });
      if (isP(tokens[j], ',')) {
        j++;
      } else if (!isP(tokens[j], '}')) {
        fail(a.line, `import 名稱清單裡有多餘的 ${tokens[j] ? tokens[j].v : '結尾'}`);
      }
    }
    if (names.length === 0) {
      fail(line, "import { } 沒有任何名稱（等同 side-effect import，不允許；請列出要用的名稱）");
    }
    if (!isId(tokens[j], 'from')) fail(line, "import 缺少 from '...'");
    const str = tokens[j + 1];
    if (!str || str.t !== 'str') fail(line, "import from 後面必須是 './x.js' 這種字串");
    const spec = str.v.slice(1, -1);
    if (spec.includes('\\')) fail(line, 'import 路徑不可含反斜線跳脫');
    let last = j + 1;
    if (isP(tokens[last + 1], ';') && tokens[last + 1].line === str.el) last++;

    for (let k = idx; k <= last; k++) consumed.add(k);
    let before = idx - 1;
    while (before >= 0 && consumed.has(before)) before--;
    const needSemi = before >= 0 && !isP(tokens[before], ';') && !isP(tokens[before], '}');
    const end = tokens[last].e;
    const filler = (needSemi ? ';' : '') + '\n'.repeat(countNewlines(src.slice(kw.s, end)));
    edits.push({ s: kw.s, e: end, text: filler, removed: true });
    imports.push({ spec, names, line });
    return last;
  };

  // 解析頂層 export 語句（只允許四種行內宣告），刪掉 export 關鍵字
  const parseExport = (idx) => {
    const kw = tokens[idx];
    const line = kw.line;
    const n1 = tokens[idx + 1];
    if (!n1) fail(line, 'export 語句不完整');

    if (isP(n1, '*')) {
      fail(line, '不允許 export * / export * as（re-export；請在使用端直接 import 原模組）');
    }
    if (isP(n1, '{')) {
      let close = idx + 2;
      while (close < tokens.length && !(isP(tokens[close], '}') && tokens[close].d === n1.d)) close++;
      if (isId(tokens[close + 1], 'from')) {
        fail(line, '不允許 export { ... } from（re-export；請在使用端直接 import 原模組）');
      }
      fail(line, '不允許 export { ... }（匯出清單；請在宣告處直接寫 export function / export const）');
    }
    if (n1.t !== 'id') fail(line, '不支援的 export 寫法（只允許 export function / export async function / export class / export const）');

    const nameAfterFunction = (fnIdx) => {
      let k = fnIdx + 1;
      if (isP(tokens[k], '*')) k++;
      const name = tokens[k];
      if (!isId(name)) fail(line, 'export function 後面必須有函式名稱');
      return name;
    };

    switch (n1.v) {
      case 'default':
        fail(line, '不允許 export default（請改用 export function / export const）');
        break;
      case 'let':
      case 'var':
        fail(line, `不允許 export ${n1.v}（打包後不是 live binding；請改用 export const，需要可變狀態就匯出函式或物件）`);
        break;
      case 'function':
        addExport(nameAfterFunction(idx + 1));
        break;
      case 'async':
        if (!isId(tokens[idx + 2], 'function')) fail(line, '不支援的 export async 寫法（只允許 export async function）');
        addExport(nameAfterFunction(idx + 2));
        break;
      case 'class': {
        const name = tokens[idx + 2];
        if (!isId(name) || name.v === 'extends') fail(line, 'export class 後面必須有類別名稱');
        addExport(name);
        break;
      }
      case 'const': {
        const name = tokens[idx + 2];
        if (!isId(name)) {
          fail(line, 'export const 後面必須是單一識別字，不可解構（請改成逐一 export const a = ...; export const b = ...）');
        }
        if (hasTopLevelComma(idx + 3)) {
          fail(line, 'export const 一次只能宣告一個名稱（請拆成多個 export const）');
        }
        addExport(name);
        break;
      }
      default:
        fail(line, `不支援的 export 寫法 export ${n1.v}（只允許 export function / export async function / export class / export const）`);
    }
    dropExportKeyword(kw);
    return idx;
  };

  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk.t !== 'id') continue;
    const prev = tokens[i - 1];
    if (prev && prev.t === 'p' && (prev.v === '.' || prev.v === '?.')) continue; // 屬性名稱，例如 obj.import
    const next = tokens[i + 1];
    switch (tk.v) {
      case 'import':
        if (isP(next, '(')) {
          if (!isMethodDefinition(i + 1)) {
            fail(tk.line, "不允許 dynamic import（import(...)；請改用靜態 import { a } from './x.js'）");
          }
        } else if (isP(next, '.')) {
          fail(tk.line, '不允許 import.meta（打包成單一 HTML 後不存在；請改由參數或常數傳入）');
        } else if (tk.d === 0) {
          i = parseImport(i);
        }
        break;
      case 'export':
        if (tk.d === 0) i = parseExport(i);
        break;
      case 'return':
        if (tk.bd === 0) fail(tk.line, '模組頂層不可使用 return');
        break;
      default:
    }
  }

  escapeForScriptTag();

  edits.sort((a, b) => a.s - b.s);
  let code = '';
  let pos = 0;
  for (const ed of edits) {
    code += src.slice(pos, ed.s) + ed.text;
    pos = ed.e;
  }
  code += src.slice(pos);
  return { imports, exports: exportsMap, code };
}

// ---------------------------------------------------------------------------
// 三、相依解析與輸出
// ---------------------------------------------------------------------------

const toPosix = (p) => p.split(path.sep).join('/');
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/**
 * 從入口檔開始解析所有模組，回傳 { code, modules }。
 * @param {string} entryFile 入口檔絕對路徑
 * @param {{ rootDir: string }} options rootDir 之外的檔案不允許被 import
 */
export async function bundleModules(entryFile, { rootDir } = {}) {
  if (!rootDir) throw new BundleError('bundleModules 需要 rootDir');
  let root;
  try {
    root = fs.realpathSync.native(path.resolve(rootDir));
  } catch {
    throw new BundleError(`找不到 rootDir：${rootDir}`);
  }

  // 相對 rootDir 的正斜線路徑；超出 rootDir 回傳 null
  const relOf = (realPath) => {
    const r = path.relative(root, realPath);
    if (r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r)) return null;
    return toPosix(r);
  };

  const records = new Map(); // 真實路徑 -> 模組紀錄
  const order = []; // 後序（被依賴者先）

  const readModule = async (realPath, rel, onError) => {
    let src;
    try {
      src = await fsp.readFile(realPath, 'utf8');
    } catch (err) {
      onError(`讀不到檔案 ${rel}（${err.code ?? err.message}）`);
    }
    const info = analyzeModule(rel, stripBom(src));
    const rec = { abs: realPath, rel, state: 0, id: 0, ...info };
    records.set(realPath, rec);
    return rec;
  };

  const resolveImport = (rec, imp) => {
    const fail = (message) => {
      throw new BundleError(`${rec.rel}:${imp.line}: ${message}`);
    };
    const spec = imp.spec;
    if (!(spec.startsWith('./') || spec.startsWith('../'))) {
      fail(`不允許 bare specifier '${spec}'（只能用 ./ 或 ../ 開頭的相對路徑）`);
    }
    if (!spec.endsWith('.js')) fail(`import 路徑必須以 .js 結尾：'${spec}'`);
    const target = path.resolve(path.dirname(rec.abs), spec);
    let real;
    try {
      real = fs.realpathSync.native(target);
      if (!fs.statSync(real).isFile()) throw new Error('not a file');
    } catch {
      fail(`找不到模組 '${spec}'（解析為 ${toPosix(path.relative(root, target))}）`);
    }
    const rel = relOf(real);
    if (rel === null) fail(`import '${spec}' 超出 rootDir，不允許（${toPosix(path.relative(root, real))}）`);
    return { real, rel, fail };
  };

  const visit = async (rec, chain) => {
    rec.state = 1;
    chain.push(rec);
    for (const imp of rec.imports) {
      const { real, rel, fail } = resolveImport(rec, imp);
      let dep = records.get(real);
      if (!dep) dep = await readModule(real, rel, fail);
      for (const nm of imp.names) {
        if (!dep.exports.has(nm.imported)) fail(`${dep.rel} 沒有匯出 ${nm.imported}`);
      }
      if (dep.state === 1) {
        const cycle = chain.slice(chain.indexOf(dep)).map((r) => r.rel);
        cycle.push(dep.rel);
        fail(`循環相依：${cycle.join(' → ')}（請把共用的部分抽到第三個模組）`);
      }
      imp.dep = dep;
      if (dep.state === 0) await visit(dep, chain);
    }
    chain.pop();
    rec.state = 2;
    order.push(rec);
    rec.id = order.length;
  };

  let entryReal;
  try {
    entryReal = fs.realpathSync.native(path.resolve(entryFile));
  } catch {
    throw new BundleError(`找不到入口檔 ${entryFile}`);
  }
  const entryRel = relOf(entryReal);
  if (entryRel === null) throw new BundleError(`入口檔 ${entryFile} 不在 rootDir（${rootDir}）之內`);
  const entry = await readModule(entryReal, entryRel, (message) => {
    throw new BundleError(message);
  });
  await visit(entry, []);

  const pieces = [];
  for (const rec of order) {
    const decls = rec.imports.map((imp) => {
      const list = imp.names.map((nm) => (nm.imported === nm.local ? nm.local : `${nm.imported}: ${nm.local}`));
      return `const { ${list.join(', ')} } = __lv_${imp.dep.id};`;
    });
    const head = `// ---- ${rec.rel}\nconst __lv_${rec.id} = (function () {${decls.length ? ' ' + decls.join(' ') : ''}\n`;
    const body = rec.code.endsWith('\n') ? rec.code : rec.code + '\n';
    const names = [...rec.exports.keys()];
    const tail = `${names.length ? `return { ${names.join(', ')} };` : 'return {};'}\n})();`;
    const wrapped = head + body + tail;
    await checkSyntax(rec, wrapped, countNewlines(head));
    pieces.push(wrapped);
  }

  const code = `// lyrics-viewer bundle：${order.length} 個模組\n${pieces.join('\n')}`;
  return { code, modules: order.map((r) => r.rel) };
}

/**
 * 以 module goal 檢查一段模組程式碼的語法（用 data: URL 動態載入，外面包 if (false) 所以不會執行）。
 * 有語法錯誤時丟出 SyntaxError，否則什麼都不做。
 */
async function assertModuleSyntax(code) {
  await import('data:text/javascript,' + encodeURIComponent('if (false) {\n' + code + '\n}'));
}

// V8 對 data: URL 模組的 SyntaxError 沒有行號；失敗時才把同樣內容寫成暫存 .mjs，
// 用 node --check 取得行號與被標示的 token。取不到就回傳 null。
function locateSyntaxError(text) {
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-syntax-'));
    const file = path.join(dir, 'module.mjs');
    fs.writeFileSync(file, text);
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    const lines = String(r.stderr ?? '').split(/\r?\n/);
    const m = /:(\d+)$/.exec(lines[0] ?? '');
    if (!m) return null;
    const caret = lines[2] ?? '';
    const from = caret.indexOf('^');
    const token = from >= 0 ? (lines[1] ?? '').slice(from, from + caret.split('^').length - 1) : '';
    return { line: Number(m[1]), token };
  } catch {
    return null;
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 檢查包好的模組語法（module goal，所以 await 的位置、import/export 的位置都照模組規則）；
// 錯誤行號換算回原始檔行號（扣掉 if (false) { 與 wrapper 表頭）
async function checkSyntax(rec, wrapped, headLines) {
  try {
    await assertModuleSyntax(wrapped);
  } catch (err) {
    if (!err || err.name !== 'SyntaxError') throw err;
    const where = locateSyntaxError('if (false) {\n' + wrapped + '\n}');
    const prefix = where ? `${rec.rel}:${Math.max(1, where.line - 1 - headLines)}` : rec.rel;
    let hint = '';
    if (/await/.test(err.message) || (where && where.token === 'await')) {
      hint = '（可能是 top-level await：模組會被包進函式，請把 await 放進 async 函式裡）';
    } else if (/Unexpected token '(import|export)'/.test(err.message)) {
      hint = '（import／export 只能寫在模組最上層）';
    }
    throw new BundleError(`${prefix}: 語法錯誤：${err.message}${hint}`);
  }
}

// ---------------------------------------------------------------------------
// 四、HTML
// ---------------------------------------------------------------------------

const TAG_RE = /<([A-Za-z][^\s\/>]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/y;
const ATTR_RE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(text) {
  const attrs = new Map();
  for (const m of text.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    if (!attrs.has(name)) attrs.set(name, m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/**
 * 掃出 HTML 裡的開始標籤（略過註解，script/style 內容視為純文字）。
 * 回傳 [{ name, start, end, attrs, closeStart, closeEnd }]；closeStart/closeEnd 只有 script/style 有意義。
 */
function scanHtml(html) {
  const tags = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    TAG_RE.lastIndex = lt;
    const m = TAG_RE.exec(html);
    if (!m) {
      i = lt + 1;
      continue;
    }
    const tag = {
      name: m[1].toLowerCase(),
      start: lt,
      end: lt + m[0].length,
      attrs: parseAttrs(m[2]),
      closeStart: -1,
      closeEnd: -1,
    };
    tags.push(tag);
    i = tag.end;
    if (tag.name === 'script' || tag.name === 'style') {
      const re = new RegExp(`</${tag.name}(?=[\\s/>])`, 'gi');
      re.lastIndex = i;
      const cm = re.exec(html);
      if (cm) {
        const gt = html.indexOf('>', cm.index);
        tag.closeStart = cm.index;
        tag.closeEnd = gt < 0 ? html.length : gt + 1;
        i = tag.closeEnd;
      } else {
        i = html.length;
      }
    }
  }
  return tags;
}

// 指向本地相對路徑的參照（排除空字串、#、任何 scheme:（data/http/https/blob/mailto…）、//）
function isLocalRef(value) {
  if (value == null) return false;
  const s = value.trim();
  if (s === '' || s.startsWith('#') || s.startsWith('//')) return false;
  return !/^[a-z][a-z0-9+.\-]*:/i.test(s);
}

export function libraryToJson(library) {
  return JSON.stringify(library ?? null).replace(/</g, () => '\\u003c');
}

export function injectLibrary(html, library) {
  const json = libraryToJson(library);
  const tag = scanHtml(html).find((t) => t.name === 'script' && t.attrs.get('id') === 'lv-library');
  if (!tag) {
    throw new BundleError('找不到 <script id="lv-library" type="application/json"> 標籤，無法注入歌曲庫（請在 index.html 加上這個標籤）');
  }
  if ((tag.attrs.get('type') ?? '').trim().toLowerCase() !== 'application/json') {
    throw new BundleError('id="lv-library" 的 script 標籤 type 必須是 application/json');
  }
  if (tag.closeStart < 0) throw new BundleError('id="lv-library" 的 script 標籤沒有 </script>');
  return html.slice(0, tag.end) + json + html.slice(tag.closeStart);
}

// 檢查 CSS 內本地相對路徑的 url(...) 與 @import，回傳 warning 清單
function cssWarnings(href, css) {
  const warnings = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, () => '');
  const report = (ref, what) => {
    if (isLocalRef(ref)) warnings.push(`${href}: ${what} 指向本地相對路徑 ${ref}，單一 HTML 不會 inline 它`);
  };
  for (const m of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]*))\s*\)/gi)) {
    report(m[1] ?? m[2] ?? m[3] ?? '', 'url(...)');
  }
  for (const m of text.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/gi)) {
    report(m[1] ?? m[2] ?? '', '@import');
  }
  return warnings;
}

/**
 * 讀 srcDir/htmlFile，把本地 CSS 與 module script 全部 inline。
 * @returns {Promise<{ html: string, modules: string[], warnings: string[] }>}
 */
export async function bundleHtml({ srcDir, htmlFile = 'index.html', library = null }) {
  const root = path.resolve(srcDir);
  const htmlPath = path.resolve(root, htmlFile);
  const htmlDir = path.dirname(htmlPath);
  const htmlName = toPosix(htmlFile);

  let html;
  try {
    html = stripBom(await fsp.readFile(htmlPath, 'utf8'));
  } catch (err) {
    throw new BundleError(`${htmlName}: 讀不到 HTML 檔（${err.code ?? err.message}）`);
  }

  const lineAt = (index) => countNewlines(html.slice(0, index)) + 1;
  const fail = (index, message) => {
    throw new BundleError(`${htmlName}:${lineAt(index)}: ${message}`);
  };
  // 參照 -> 檔案絕對路徑（去掉 ?query / #hash；開頭 / 視為相對 srcDir）
  const refToFile = (ref) => {
    let p = ref.trim();
    const cut = p.search(/[?#]/);
    if (cut >= 0) p = p.slice(0, cut);
    try {
      p = decodeURIComponent(p);
    } catch {
      // 保留原字串
    }
    return p.startsWith('/') ? path.join(root, p) : path.resolve(htmlDir, p);
  };

  const tags = scanHtml(html);
  const edits = [];
  const warnings = [];
  const handled = new Set();

  // 1. CSS
  for (const tag of tags) {
    if (tag.name !== 'link') continue;
    const rel = (tag.attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
    const href = tag.attrs.get('href');
    if (!rel.includes('stylesheet') || !isLocalRef(href)) continue;
    let css;
    try {
      css = await fsp.readFile(refToFile(href), 'utf8');
    } catch {
      fail(tag.start, `找不到樣式表 ${href}`);
    }
    css = stripBom(css).trimEnd();
    warnings.push(...cssWarnings(href, css));
    const safe = css.replace(/<\/style/gi, (m) => '<\\/' + m.slice(2));
    const media = tag.attrs.get('media');
    const mediaAttr = media ? ` media="${media.replace(/"/g, () => '&quot;')}"` : '';
    edits.push({ s: tag.start, e: tag.end, text: `<style${mediaAttr}>\n${safe}\n</style>` });
    handled.add(tag);
  }

  // 2. module script（必須剛好一個，且 src 指向本地檔案）
  const moduleScripts = tags.filter(
    (t) =>
      t.name === 'script' &&
      (t.attrs.get('type') ?? '').trim().toLowerCase() === 'module' &&
      isLocalRef(t.attrs.get('src')),
  );
  if (moduleScripts.length !== 1) {
    const where = moduleScripts.length > 1 ? `:${lineAt(moduleScripts[1].start)}` : '';
    throw new BundleError(
      `${htmlName}${where}: 必須剛好有一個 <script type="module" src="..."></script>，目前有 ${moduleScripts.length} 個`,
    );
  }
  const script = moduleScripts[0];
  if (script.closeStart < 0) fail(script.start, '<script type="module"> 沒有對應的 </script>');
  const entryFile = refToFile(script.attrs.get('src'));
  const bundled = await bundleModules(entryFile, { rootDir: root });
  // </script 與 <!-- 已在各模組依 token 種類跳脫；這裡只做最後保險（例如檔案路徑本身含這些字樣）
  const leftover = /<\/script|<!--/i.exec(bundled.code);
  if (leftover) {
    throw new BundleError(`${htmlName}: 打包結果仍含 ${leftover[0]}，無法安全放進 <script>（檢查模組路徑或註解）`);
  }
  edits.push({ s: script.start, e: script.closeEnd, text: `<script type="module">\n${bundled.code}\n</script>` });
  handled.add(script);

  // 3. 仍指向本地相對路徑的 src / href
  for (const tag of tags) {
    if (handled.has(tag)) continue;
    for (const attr of ['src', 'href']) {
      const v = tag.attrs.get(attr);
      if (isLocalRef(v)) {
        warnings.push(`${htmlName}:${lineAt(tag.start)}: <${tag.name}> 的 ${attr}="${v}" 指向本地相對路徑，單一 HTML 不會包含該檔案`);
      }
    }
  }

  edits.sort((a, b) => a.s - b.s);
  let out = '';
  let pos = 0;
  for (const ed of edits) {
    out += html.slice(pos, ed.s) + ed.text;
    pos = ed.e;
  }
  out += html.slice(pos);

  if (library !== null) out = injectLibrary(out, library);
  return { html: out, modules: bundled.modules, warnings };
}
