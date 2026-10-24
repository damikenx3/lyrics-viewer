// tools/bundle.mjs 的測試：一律在暫存目錄建假專案，不碰真正的 src/
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import {
  BundleError,
  bundleHtml,
  bundleModules,
  injectLibrary,
  libraryToJson,
} from '../tools/bundle.mjs';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const tmpDirs = [];
after(async () => {
  for (const dir of tmpDirs) await fsp.rm(dir, { recursive: true, force: true });
});

/** 在暫存目錄建檔案（鍵是正斜線相對路徑），回傳目錄 */
async function mkProject(files) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lv-bundle-'));
  tmpDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, ...name.split('/'));
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content);
  }
  return dir;
}

const MIN_HTML =
  '<!doctype html><html><head></head><body><script type="module" src="main.js"></script></body></html>';

/** 取出 inline module script 的內容 */
function moduleScriptCode(html) {
  const m = /<script type="module">\n([\s\S]*?)\n<\/script>/.exec(html);
  assert.ok(m, '找不到 inline module script');
  return m[1];
}

/** 在乾淨的 vm context 執行 bundle code，回傳 sandbox */
function runCode(code, sandbox = {}) {
  vm.runInNewContext(code, sandbox);
  return sandbox;
}

/** 把 vm 內建立的物件轉成本 realm 的普通物件，方便 deepStrictEqual */
const plain = (v) => JSON.parse(JSON.stringify(v));

/** 單檔 main.js 專案（含 index.html），要求 bundleHtml 丟 BundleError，回傳 error */
async function bundleError(files, { html = MIN_HTML, ...opts } = {}) {
  const dir = await mkProject({ 'index.html': html, ...files });
  let caught;
  try {
    await bundleHtml({ srcDir: dir, ...opts });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, '預期丟出 BundleError，但沒有丟錯');
  assert.ok(caught instanceof BundleError, `預期 BundleError，實際是 ${caught && caught.name}: ${caught && caught.message}`);
  return caught;
}

/** main.js 的第 3 行放被測語法，前面兩行是墊底 */
const atLine3 = (stmt) => `const a = 1;\n// filler\n${stmt}\n`;

// ---------------------------------------------------------------------------
// 假專案：正常打包
// ---------------------------------------------------------------------------

const PROJECT = {
  'index.html': `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.example.com/css?family=X&amp;display=swap">
<link href='styles.css' rel='stylesheet'>
<!-- <link rel="stylesheet" href="missing-in-comment.css"> -->
</head>
<body>
<p id="app">hi</p>
<script id="lv-library" type="application/json">{}</script>
<script src="app/main.js" type="module"></script>
</body>
</html>
`,
  'styles.css': `body { margin: 0; }
.x::after { content: "$& $1 $$ </style>"; }
`,
  'app/main.js': `import { Counter, makeTitle, later } from './ui.js';
import {
  add as plus,
  mul,
  PI2,
  tag,
} from './util/math.js';
import { logCounter } from '../shared/log.js'
import { strings, nested, re, countRe, divs, post, afterReturn, typeofRe, sum, htmlComment, dollars, keywordProps, methodNames } from './tricky.js';
import { f as asyncF, g as asyncG, h as asyncH } from './asyncs.js';

globalThis.trace.push('main');
const counter = 'main-counter';
const c = new Counter(plus(1, 2));
globalThis.result = JSON.stringify({
  counter,
  mathCounter: tag(),
  logCounter: logCounter(),
  inc: c.inc(),
  product: mul(3, 4),
  twoPi: PI2 === Math.PI * 2,
  title: makeTitle('x'),
  strings,
  nested,
  reMatches: countRe('import/export await x <\\/script> "'),
  reFlags: re.flags,
  divs,
  post,
  afterReturn,
  typeofRe,
  sum,
  htmlComment,
  dollars,
  keywordProps,
  methodNames,
});
globalThis.pending = Promise.all([later(21), asyncF(), asyncG(), asyncH(Promise.resolve('z'))]).then((v) => {
  globalThis.asyncResult = JSON.stringify(v);
});
`,
  'app/ui.js': `import { add } from './util/math.js';
import { log } from '../shared/log.js';

const counter = 'ui-counter';
globalThis.trace.push('ui');
export class Counter {
  constructor(n) { this.n = n; }
  inc() { this.n = add(this.n, 1); return this.n; }
}
export const makeTitle = (s) => \`\${counter}:\${s}\`;
export async function later(v) {
  await Promise.resolve();
  return v * 2;
}
`,
  'app/util/math.js': `const counter = 'math-counter';
globalThis.trace.push('math');
export function add(a, b) { return a + b; }
export function mul(a, b) { return a * b; }
export const PI2 = Math.PI * 2;
export const tag = () => counter;
`,
  'shared/log.js': `const counter = 'log-counter';
globalThis.trace.push('log');
export function logCounter() { return counter; }
export const log = (name) => name;
`,
  'app/tricky.js': `// import { nope } from './nope.js'  <- 註解裡的 import 不算
/* export default 1;
   await nope();  </script> <!-- */
import { add } from './util/math.js';

export const strings = [
  "import { x } from './x.js'",
  'export default 1; await y; </script>',
  \`import \${\`export \${'await'}\`} </script> // 不是註解\`,
];
export const nested = \`a\${({ k: '}' }).k}b\${\`n\${1 + 1}\`}c\`;
export const re = /import\\/export|await\\s+x|<\\/script>|['"\`]/g;
export function countRe(s) {
  return (s.match(re) || []).length;
}
const q = /["'\`]/; // regex 含引號與反引號
export const divs = [10 / 2 / 5, (4 + 4) / 2 / 2, [8].length / 2, q.test('"') ? 1 / 1 : 0];
export const post = (() => { let k = 8; k++; return k / 3 / 3; })();
export const afterReturn = (() => { return /export default/.test('export default 1'); })();
export const typeofRe = typeof /await/;
export const sum = add(1, 1);
export const htmlComment = '<!-- not a comment -->';
export const dollars = '$& $1 $$ $\`';
const o = { import: 1, export: 2, await: 3 };
export const keywordProps = [o.import, o.export, o.await];
class K {
  import() { return 7; }
  static export() { return 8; }
}
export const methodNames = [new K().import(), K.export()];
globalThis.trace.push('tricky'); // trailing 'quote
`,
  'app/asyncs.js': `export async function f() { return await Promise.resolve(5); }
export const g = async () => await 6;
export const h = async (x) => \`v\${await x}\`;
export const k = async function () { for await (const x of [1]) { void x; } return 1; };
`,
};

test('打包假專案：結構、CSS inline、library 注入', async () => {
  const dir = await mkProject(PROJECT);
  const { html, modules, warnings } = await bundleHtml({
    srcDir: dir,
    library: { songs: [{ title: '</script><b>', lyric: 'a<!--b' }] },
  });

  // 只有一個 inline module script，且沒有帶 src 的 script
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
  assert.equal(scripts.filter((s) => /type="module"/.test(s)).length, 1);
  assert.equal(scripts.filter((s) => /\bsrc=/.test(s)).length, 0);
  assert.equal(scripts.length, 2); // lv-library + module
  assert.equal((html.match(/<\/script>/gi) || []).length, 2);

  // CSS 已 inline；遠端字型連結與註解內的 link 保持原樣
  assert.ok(!html.includes('href="styles.css"') && !html.includes("href='styles.css'"));
  assert.ok(html.includes('<style>\nbody { margin: 0; }'));
  assert.ok(html.includes('content: "$& $1 $$ <\\/style>"'), 'CSS 內容的 $& 與 </style 處理錯誤');
  assert.ok(html.includes('href="https://fonts.example.com/css?family=X&amp;display=swap"'));
  assert.ok(html.includes('<!-- <link rel="stylesheet" href="missing-in-comment.css"> -->'));

  // library 已注入，< 已轉成 \u003c，且能還原
  const m = /<script id="lv-library" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m);
  assert.ok(!m[1].includes('<'));
  assert.ok(m[1].includes('\\u003c/script>'));
  assert.deepEqual(JSON.parse(m[1]), { songs: [{ title: '</script><b>', lyric: 'a<!--b' }] });

  // bundle 內不含 <!--，也沒有未跳脫的 </script
  const code = moduleScriptCode(html);
  assert.ok(!code.includes('<!--'));
  assert.ok(!/<\/script/i.test(code));

  assert.deepEqual(modules, [
    'app/util/math.js',
    'shared/log.js',
    'app/ui.js',
    'app/tricky.js',
    'app/asyncs.js',
    'app/main.js',
  ]);
  assert.deepEqual(warnings, []);
  assert.match(code.split('\n')[0], /^\/\/ .*6/);
});

test('執行打包結果：結果正確、模組只執行一次、順序正確、同名變數不衝突', async () => {
  const dir = await mkProject(PROJECT);
  const { html } = await bundleHtml({ srcDir: dir, library: {} });
  const sandbox = runCode(moduleScriptCode(html), { trace: [] });

  // 被依賴者先、每個模組只執行一次（math 被三個模組 import 仍只有一次）
  assert.deepEqual(plain(sandbox.trace), ['math', 'log', 'ui', 'tricky', 'main']);

  const result = JSON.parse(sandbox.result);
  assert.equal(result.counter, 'main-counter');
  assert.equal(result.mathCounter, 'math-counter');
  assert.equal(result.logCounter, 'log-counter');
  assert.equal(result.title, 'ui-counter:x');
  assert.equal(result.inc, 4);
  assert.equal(result.product, 12);
  assert.equal(result.twoPi, true);

  // 字串／註解／template／regex 內的 import、export、await、</script> 不誤判，值維持原樣
  assert.deepEqual(result.strings, [
    "import { x } from './x.js'",
    'export default 1; await y; </script>',
    'import export await </script> // 不是註解',
  ]);
  assert.equal(result.nested, 'a}bn2c');
  assert.equal(result.reMatches, 4); // import/export、await x、</script>、"
  assert.equal(result.reFlags, 'g');
  assert.deepEqual(result.divs, [1, 2, 0.5, 1]);
  assert.equal(result.post, 1);
  assert.equal(result.afterReturn, true);
  assert.equal(result.typeofRe, 'object');
  assert.equal(result.sum, 2);
  assert.equal(result.htmlComment, '<!-- not a comment -->');
  assert.equal(result.dollars, '$& $1 $$ $`');
  assert.deepEqual(result.keywordProps, [1, 2, 3]);
  assert.deepEqual(result.methodNames, [7, 8]);

  // async function／async 箭頭函式本體內的 await 不會報錯，也能正常執行
  await sandbox.pending;
  assert.deepEqual(JSON.parse(sandbox.asyncResult), [42, 5, 6, 'vz']);
});

test('bundleModules 直接呼叫：回傳 code 與依序排列的相對路徑', async () => {
  const dir = await mkProject({
    'a.js': "import { b } from './sub/b.js';\nglobalThis.out = b();\n",
    'sub/b.js': "import { c as cc } from '../c.js';\nexport function b() { return cc + 1; }\n",
    'c.js': 'export const c = 41;\n',
  });
  const { code, modules } = await bundleModules(path.join(dir, 'a.js'), { rootDir: dir });
  assert.deepEqual(modules, ['c.js', 'sub/b.js', 'a.js']);
  assert.ok(code.includes('// ---- sub/b.js'));
  assert.ok(code.includes('const __lv_2 = (function () { const { c: cc } = __lv_1;'));
  assert.ok(code.includes('const __lv_3 = (function () { const { b } = __lv_2;'));
  assert.equal(runCode(code).out, 42);
});

test('import 換成空行，錯誤行號仍對應原始檔（含多行 import、CRLF）', async () => {
  const dir = await mkProject({
    'x.js': 'export const a = 1;\nexport const b = 2;\n',
    'main.js': [
      "import {",
      '  a,',
      '  b as bb,',
      "} from './x.js'; // 三行的 import",
      'const ok = a + bb;',
      'const = 1;', // 第 6 行語法錯誤
      '',
    ].join('\r\n'),
    'index.html': MIN_HTML,
  });
  await assert.rejects(bundleHtml({ srcDir: dir }), (err) => {
    assert.ok(err instanceof BundleError);
    assert.match(err.message, /^main\.js:6: /);
    assert.match(err.message, /語法錯誤/);
    return true;
  });
});

test('輸出的 script 不受 String.replace 特殊樣式影響（$&、$1、$$ 原樣保留）', async () => {
  const dir = await mkProject({
    'index.html': MIN_HTML,
    'main.js': "globalThis.out = ['$&', '$1', '$$', \"$'\", '$`'].join('|');\n",
  });
  const { html } = await bundleHtml({ srcDir: dir });
  assert.equal(runCode(moduleScriptCode(html)).out, "$&|$1|$$|$'|$`");
});

// ---------------------------------------------------------------------------
// libraryToJson / injectLibrary
// ---------------------------------------------------------------------------

test('libraryToJson：所有 < 換成 \\u003c 且可還原', () => {
  const lib = { a: '</script><!--', b: [1, null, '<'] };
  const json = libraryToJson(lib);
  assert.ok(!json.includes('<'));
  assert.equal(json, '{"a":"\\u003c/script>\\u003c!--","b":[1,null,"\\u003c"]}');
  assert.deepEqual(JSON.parse(json), lib);
});

test('injectLibrary：替換標籤內容，內容有 $& 不被解讀；找不到標籤丟 BundleError', () => {
  const html = '<p>x</p><script type="application/json" id="lv-library">old</script><script>var a;</script>';
  const out = injectLibrary(html, { s: '$& $1' });
  assert.equal(out, '<p>x</p><script type="application/json" id="lv-library">{"s":"$& $1"}</script><script>var a;</script>');

  assert.throws(() => injectLibrary('<script>x</script>', {}), BundleError);
  assert.throws(() => injectLibrary('<!-- <script id="lv-library" type="application/json"></script> -->', {}), BundleError);
});

test('缺少 lv-library 標籤：library 非 null 時丟 BundleError，null 時不處理', async () => {
  const files = { 'main.js': 'globalThis.out = 1;\n' };
  const err = await bundleError(files, { library: { songs: [] } });
  assert.match(err.message, /lv-library/);

  const dir = await mkProject({ 'index.html': MIN_HTML, ...files });
  const { html } = await bundleHtml({ srcDir: dir, library: null });
  assert.ok(html.includes('<script type="module">'));
});

// ---------------------------------------------------------------------------
// HTML 層級
// ---------------------------------------------------------------------------

test('兩個 module script 丟 BundleError；零個也丟', async () => {
  const two =
    '<script type="module" src="main.js"></script>\n<script type="module" src="other.js"></script>';
  const err = await bundleError({ 'main.js': '', 'other.js': '' }, { html: two });
  assert.match(err.message, /^index\.html:2: .*剛好有一個.*2 個/);

  const none = await bundleError({}, { html: '<html><body><script>var a;</script></body></html>' });
  assert.match(none.message, /^index\.html: .*剛好有一個.*0 個/);
});

test('警告：殘留的本地相對 src/href 與 CSS url()；遠端、data:、#、mailto 不警告', async () => {
  const dir = await mkProject({
    'index.html': `<!doctype html>
<html><head>
<link rel="icon" href="favicon.ico">
<link rel="icon" href="data:image/svg+xml,%3Csvg%3E">
<link rel="preconnect" href="https://fonts.gstatic.com">
<link rel="stylesheet" href="styles.css">
</head><body>
<a href="#top">top</a> <a href="mailto:a@b.c">mail</a> <a href="http://x.test/">x</a> <a href="blob:abc">b</a>
<img src="img/logo.png"> <img src="data:image/gif;base64,AAAA">
<script src="https://cdn.example.com/x.js"></script>
<script type="module" src="main.js"></script>
</body></html>`,
    'styles.css': `/* url(commented.png) */
.a { background: url(img/a.png); }
.b { background: url("data:image/png;base64,AAAA"); }
.c { background: url('https://x.test/c.png'); }
.d { background: url( "../up.png" ); }
@import 'other.css';
`,
    'main.js': 'globalThis.out = 1;\n',
  });
  const { warnings } = await bundleHtml({ srcDir: dir });
  assert.equal(warnings.length, 5, warnings.join('\n'));
  const text = warnings.join('\n');
  assert.match(text, /styles\.css: url\(\.\.\.\) 指向本地相對路徑 img\/a\.png/);
  assert.match(text, /url\(\.\.\.\) 指向本地相對路徑 \.\.\/up\.png/);
  assert.match(text, /@import 指向本地相對路徑 other\.css/);
  assert.match(text, /index\.html:3: <link> 的 href="favicon\.ico"/);
  assert.match(text, /index\.html:\d+: <img> 的 src="img\/logo\.png"/);
  assert.ok(!/commented\.png|data:|https?:|mailto|#top|blob:/.test(text), text);
});

test('找不到 CSS 檔丟 BundleError 並含行號', async () => {
  const html = '<head>\n<link rel="stylesheet" href="nope.css">\n</head><script type="module" src="main.js"></script>';
  const err = await bundleError({ 'main.js': '' }, { html });
  assert.match(err.message, /^index\.html:2: 找不到樣式表 nope\.css/);
});

// ---------------------------------------------------------------------------
// 禁止的語法：每種各一個測試，訊息含檔名與行號
// ---------------------------------------------------------------------------

const FORBIDDEN = [
  ['export default function', 'export default function () {}', /不允許 export default/],
  ['export default 表達式', 'export default 42;', /不允許 export default/],
  ['export default class', 'export default class A {}', /不允許 export default/],
  ['export *', "export * from './x.js';", /不允許 export \*/],
  ['export * as', "export * as ns from './x.js';", /不允許 export \*/],
  ['export { x } 匯出清單', 'export { a };', /不允許 export \{ \.\.\. \}（匯出清單/],
  ['export { x } from（re-export）', "export { a } from './x.js';", /不允許 export \{ \.\.\. \} from（re-export/],
  ['export let', 'export let v = 1;', /不允許 export let/],
  ['export var', 'export var v = 1;', /不允許 export var/],
  ['default import', "import x from './x.js';", /不允許 default import/],
  ['default import + 具名', "import x, { a } from './x.js';", /不允許 default import/],
  ['import { default as x }', "import { default as x } from './x.js';", /不允許 default import/],
  ['namespace import', "import * as ns from './x.js';", /不允許 namespace import/],
  ['side-effect import', "import './x.js';", /不允許 side-effect import/],
  ['空的 import { }', "import {} from './x.js';", /import \{ \} 沒有任何名稱/],
  ['dynamic import（頂層）', "const m = import('./x.js');", /不允許 dynamic import/],
  ['dynamic import（函式內）', "function f() { return import('./x.js'); }", /不允許 dynamic import/],
  ['import.meta', 'const u = import.meta.url;', /不允許 import\.meta/],
  ['top-level await（語句）', 'await Promise.resolve();', /語法錯誤：.*top-level await/],
  ['top-level await（宣告）', 'const v = await Promise.resolve(1);', /語法錯誤：.*top-level await/],
  ['top-level await（括號內）', 'foo(await bar);', /語法錯誤：.*top-level await/],
  ['top-level for await', 'for await (const x of y) {}', /語法錯誤：.*top-level await/],
  ['bare specifier', "import { x } from 'lodash';", /不允許 bare specifier 'lodash'/],
  ['非相對路徑（絕對）', "import { x } from '/abs/x.js';", /不允許 bare specifier '\/abs\/x\.js'/],
  ['不以 .js 結尾', "import { x } from './x';", /必須以 \.js 結尾/],
  ['export const 解構（物件）', 'export const { a, b } = obj;', /export const 後面必須是單一識別字.*逐一 export const/],
  ['export const 解構（陣列）', 'export const [a, b] = arr;', /export const 後面必須是單一識別字/],
  ['export const 一次多個', 'export const p = 1, q = 2;', /export const 一次只能宣告一個/],
  ['export const 逗號換行', 'export const p = 1\n  , q = 2;', /export const 一次只能宣告一個/],
  ['模組頂層 return', 'return 1;', /模組頂層不可使用 return/],
];

for (const [name, stmt, pattern] of FORBIDDEN) {
  test(`禁止語法：${name}`, async () => {
    const err = await bundleError({
      'main.js': atLine3(stmt),
      'x.js': 'export const a = 1;\nexport const x = 1;\n',
    });
    assert.match(err.message, /^main\.js:3: /, err.message);
    assert.match(err.message, pattern);
  });
}

test('禁止語法：重複匯出同一個名稱', async () => {
  const err = await bundleError({ 'main.js': 'const a = 1;\nexport function d() {}\nexport const d = 1;\n' });
  assert.match(err.message, /^main\.js:3: 重複匯出 d/);
});

test('禁止語法在子目錄模組，訊息用相對 rootDir 的路徑', async () => {
  const err = await bundleError({
    'main.js': "import { a } from './app/ui.js';\n",
    'app/ui.js': atLine3('export default 1;'),
  });
  assert.match(err.message, /^app\/ui\.js:3: .*export default/);
});

test('多行的禁止語法：行號是語句開頭那一行', async () => {
  const err = await bundleError({
    'main.js': "const a = 1;\n\nexport {\n  a,\n}\n",
  });
  assert.match(err.message, /^main\.js:3: /);
});

test('合法但長得像禁止語法的寫法不誤判', async () => {
  const dir = await mkProject({
    'index.html': MIN_HTML,
    'x.js': [
      'export function* gen() { yield 1; }',
      'export async function af() { return 2; }',
      'export class C { static v = 3; }',
      'export const arrow = async () => await 4;',
      'export const multi = [',
      '  1,',
      '  2,',
      '];',
      'export const noSemi = 5',
      'export const second = (1, 2)',
      'export const tpl = `${[1, 2].map((n) => n * 2)}`',
      'export const fnc = function (a, b) { return a + b }',
      '',
    ].join('\n'),
    'main.js': [
      "import { gen, af, C, arrow, multi, noSemi, second, tpl, fnc } from './x.js';",
      'globalThis.pending = Promise.all([af(), arrow()]).then((v) => {',
      '  globalThis.out = JSON.stringify([[...gen()], v, C.v, multi, noSemi, second, tpl, fnc(1, 2)]);',
      '});',
      '',
    ].join('\n'),
  });
  const { html } = await bundleHtml({ srcDir: dir });
  const sandbox = runCode(moduleScriptCode(html));
  await sandbox.pending;
  assert.deepEqual(JSON.parse(sandbox.out), [[1], [2, 4], 3, [1, 2], 5, 2, '2,4', 3]);
});

// ---------------------------------------------------------------------------
// 相依解析
// ---------------------------------------------------------------------------

test('缺少匯出名稱：x.js 沒有匯出 foo（含 importer 與行號）', async () => {
  const err = await bundleError({
    'main.js': "const a = 1;\nimport { ok, foo } from './x.js';\n",
    'x.js': 'export const ok = 1;\nexport const notExported = 2;\nconst foo = 3;\n',
  });
  assert.match(err.message, /^main\.js:2: x\.js 沒有匯出 foo/);
});

test('找不到檔案：含 importer 與行號', async () => {
  const err = await bundleError({
    'main.js': "\n\nimport { a } from './missing.js';\n",
  });
  assert.match(err.message, /^main\.js:3: 找不到模組 '\.\/missing\.js'（解析為 missing\.js）/);
});

test('import 的是目錄也報找不到', async () => {
  const err = await bundleError({
    'main.js': "import { a } from './dir.js';\n",
    'dir.js/inner.js': 'export const a = 1;\n',
  });
  assert.match(err.message, /^main\.js:1: 找不到模組/);
});

test('import 超出 rootDir 丟 BundleError', async () => {
  const outer = await mkProject({
    'secret.js': 'export const s = 1;\n',
    'src/index.html': MIN_HTML,
    'src/main.js': "import { s } from '../secret.js';\n",
  });
  await assert.rejects(bundleHtml({ srcDir: path.join(outer, 'src') }), (err) => {
    assert.ok(err instanceof BundleError);
    assert.match(err.message, /^main\.js:1: .*超出 rootDir/);
    return true;
  });
});

test('循環相依：列出循環路徑', async () => {
  const err = await bundleError({
    'main.js': "import { a } from './a.js';\n",
    'a.js': "import { b } from './b.js';\nexport const a = 1;\n",
    'b.js': "\nimport { a } from './a.js';\nexport const b = 2;\n",
  });
  assert.match(err.message, /^b\.js:2: 循環相依：a\.js → b\.js → a\.js/);
});

test('自己 import 自己也是循環相依', async () => {
  const err = await bundleError({
    'main.js': "import { m } from './main.js';\nexport const m = 1;\n",
  });
  assert.match(err.message, /^main\.js:1: 循環相依：main\.js → main\.js/);
});

test('菱形相依：共用模組只輸出一次，依 import 順序做 DFS 後序', async () => {
  const dir = await mkProject({
    'index.html': MIN_HTML,
    'main.js': "import { b } from './b.js';\nimport { a } from './a.js';\nglobalThis.out = a + b;\n",
    'a.js': "import { shared } from './shared.js';\nexport const a = shared + 'a';\n",
    'b.js': "import { shared } from './shared.js';\nexport const b = shared + 'b';\n",
    'shared.js': "globalThis.count = (globalThis.count || 0) + 1;\nexport const shared = 's';\n",
  });
  const { html, modules } = await bundleHtml({ srcDir: dir });
  assert.deepEqual(modules, ['shared.js', 'b.js', 'a.js', 'main.js']);
  const sandbox = runCode(moduleScriptCode(html));
  assert.equal(sandbox.count, 1);
  assert.equal(sandbox.out, 'sasb');
});

test('不同大小寫的 import 路徑指向同一檔案時不會重複打包（大小寫不分的檔案系統）', async (t) => {
  const dir = await mkProject({
    'index.html': MIN_HTML,
    'main.js': "import { a } from './Shared.js';\nimport { b } from './sub.js';\nglobalThis.out = a + b;\n",
    'sub.js': "import { a } from './shared.js';\nexport const b = a + 1;\n",
    'shared.js': 'export const a = 1;\n',
  });
  let insensitive = true;
  try {
    await fsp.access(path.join(dir, 'SHARED.JS'));
  } catch {
    insensitive = false;
  }
  if (!insensitive) {
    t.skip('檔案系統大小寫有別');
    return;
  }
  const { modules } = await bundleHtml({ srcDir: dir });
  assert.equal(modules.filter((m) => m.toLowerCase() === 'shared.js').length, 1);
});

// ---------------------------------------------------------------------------
// await 的處理
// ---------------------------------------------------------------------------

test('函式內的 await 不報錯', async () => {
  const dir = await mkProject({
    'index.html': MIN_HTML,
    'main.js': [
      'async function inner() { const v = await Promise.resolve(1); return v + 1; }',
      'const arrow = async () => { return await inner(); };',
      'const expr = async () => await inner();',
      'const nestedExpr = async (xs) => (await Promise.all(xs.map(async (x) => await x)));',
      "const o = { async m() { return await 1; } };",
      'globalThis.pending = Promise.all([inner(), arrow(), expr(), nestedExpr([5]), o.m()]).then((v) => {',
      '  globalThis.out = JSON.stringify(v);',
      '});',
      '',
    ].join('\n'),
  });
  const { html } = await bundleHtml({ srcDir: dir });
  const sandbox = runCode(moduleScriptCode(html));
  await sandbox.pending;
  assert.deepEqual(JSON.parse(sandbox.out), [2, 2, 2, [5], 1]);
});

// top-level await 一律交給 module goal 的語法檢查（沒有掃描器推測），訊息含行號與 top-level await 提示
const TLA_CASES = [
  ['頂層 if 區塊內', 'if (true) { await Promise.resolve(); }', 3],
  ['頂層 if 區塊內，await 後接括號', 'if (true) { globalThis.out = await (Promise.resolve(1)); }', 3],
  ['頂層 await 後接括號', 'globalThis.out = await (Promise.resolve(1));', 3],
  ['物件 literal 裡', 'const o = { a: await Promise.resolve(1) };', 3],
  ['async 箭頭函式之外（有分號）', 'const f = async () => 1;\nawait f();', 4],
  ['async 箭頭函式之外（沒有分號）', 'const f = async () => 1\nawait f()', 4],
  ['非 async 函式裡', 'function f() { return await 1; }', 3],
  ['非 async 箭頭函式裡', 'const f = () => await 1;', 3],
];
for (const [name, stmt, line] of TLA_CASES) {
  test(`await 不在 async 函式裡由語法檢查擋下：${name}`, async () => {
    const err = await bundleError({ 'main.js': atLine3(stmt) });
    assert.match(err.message, new RegExp(`^main\\.js:${line}: 語法錯誤：`), err.message);
    assert.match(err.message, /top-level await/);
  });
}

test('語法錯誤的行號換算：多行 import 與 CRLF 之後仍指到原始檔那一行', async () => {
  const err = await bundleError({
    'x.js': 'export const a = 1;\n',
    'main.js': "import {\r\n  a,\r\n} from './x.js';\r\n\r\nconst ok = a;\r\nif (ok) { await a; }\r\n",
  });
  assert.match(err.message, /^main\.js:6: 語法錯誤：/);
});

test('巢狀區塊裡的 import／export：由 vm 語法檢查擋下並提示只能寫在最上層', async () => {
  const err = await bundleError({
    'main.js': atLine3('if (true) { export const a = 1; }'),
  });
  assert.match(err.message, /^main\.js:3: 語法錯誤：.*export/);
  assert.match(err.message, /只能寫在模組最上層/);
});

// ---------------------------------------------------------------------------
// 掃描器細節
// ---------------------------------------------------------------------------

test('掃描器：字串、註解、template、regex 內的關鍵字都不誤判', async () => {
  const dir = await mkProject({
    'index.html': MIN_HTML,
    'main.js': [
      "const s = 'import { a } from \"./x.js\"; export default 1; await y; import(\"z\"); import.meta';",
      '// export default 1',
      '// import("dyn")',
      '/* await x; export { y }; ',
      '   import.meta */',
      'const t = `export default ${"import(\'q\')"} await ${`import.meta`}`;',
      'const r = /import\\(|export\\s+default|await|\\/\\*|\'|"/;',
      'const d = 6 / 3 / 1; // 除號不是 regex 開頭，後面的引號 \' 不能被當成字串',
      "const e = (6) / 3 / '1';",
      'const arr = [6][0] / 3 / 2;',
      'let n = 9; const post = n++ / 3 / 3;',
      'globalThis.out = JSON.stringify([s.length > 0, t, r.test("await"), d, e, arr, post]);',
      '',
    ].join('\n'),
  });
  const { html } = await bundleHtml({ srcDir: dir });
  const out = JSON.parse(runCode(moduleScriptCode(html)).out);
  assert.equal(out[0], true);
  assert.equal(out[1], 'export default import(\'q\') await import.meta');
  assert.deepEqual(out.slice(2), [true, 2, 2, 1, 1]);
});

test('掃描器：未結束的字串、template、區塊註解與括號都報行號', async () => {
  const cases = [
    ["const s = 'abc;\nconst t = 1;\n", /^main\.js:1: 字串沒有結尾/],
    ['const t = `abc\n\n', /^main\.js:1: template literal 沒有結尾/],
    ['const a = 1;\n/* abc\n', /^main\.js:2: 區塊註解/],
    ['function f() {\n  return 1;\n', /^main\.js:1: '\{' 沒有對應的結尾/],
    ['const a = (1;\n}\n', /^main\.js:\d+: /],
  ];
  for (const [src, pattern] of cases) {
    const err = await bundleError({ 'main.js': src });
    assert.match(err.message, pattern);
  }
});

test('hasTopLevelComma 不誤判：逗號在括號內、下一行是新語句', async () => {
  const dir = await mkProject({
    'index.html': MIN_HTML,
    'x.js': [
      'export const a = foo(1, 2)',
      'export const b = [1, 2]',
      'export const c = { k: 1, l: 2 }',
      'export const d = (x, y) => x + y',
      'function foo(p, q) { return p + q }',
      '',
    ].join('\n'),
    'main.js': "import { a, b, c, d } from './x.js';\nglobalThis.out = JSON.stringify([a, b, c, d(1, 2)]);\n",
  });
  const { html } = await bundleHtml({ srcDir: dir });
  assert.deepEqual(JSON.parse(runCode(moduleScriptCode(html)).out), [3, [1, 2], { k: 1, l: 2 }, 3]);
});

// ---------------------------------------------------------------------------
// </script 與 <!-- 的跳脫：依 token 種類處理，跳脫後語意不變
// ---------------------------------------------------------------------------

/** 打包單檔 main.js（加上 extraFiles）並執行；順便確認輸出裡沒有會截斷 <script> 的字樣 */
async function bundleAndRun(mainSource, extraFiles = {}) {
  const dir = await mkProject({ 'index.html': MIN_HTML, 'main.js': mainSource, ...extraFiles });
  const { html } = await bundleHtml({ srcDir: dir });
  const code = moduleScriptCode(html);
  assert.ok(!/<\/script/i.test(code), '打包結果仍含 </script');
  assert.ok(!code.includes('<!--'), '打包結果仍含 <!--');
  assert.equal((html.match(/<\/script>/gi) || []).length, 1);
  return { code, html, sandbox: runCode(code) };
}

test('跳脫：字串字面值（含大小寫與跳脫字元）的值不變', async () => {
  const { sandbox } = await bundleAndRun(
    String.raw`globalThis.out = ['</script>', "<!--", '</SCRIPT x>', '\<!--', '<\/script>', "a<!--b</Script>c"];`,
  );
  assert.deepEqual(plain(sandbox.out), ['</script>', '<!--', '</SCRIPT x>', '<!--', '</script>', 'a<!--b</Script>c']);
});

test('跳脫：regex literal（含 u flag 與字元類別）行為不變', async () => {
  const { sandbox } = await bundleAndRun(
    [
      String.raw`const a = /<!--([\s\S]*?)-->/u.exec('x<!-- y -->z')[1];`,
      'const b = /[</script]+/.exec("<//ss")[0];',
      "const c = /<!--/giu.test('<!--');",
      'globalThis.out = [a, b, c];',
      '',
    ].join('\n'),
  );
  assert.deepEqual(plain(sandbox.out), [' y ', '<//ss', true]);
});

test('跳脫：template literal 以空 substitution 打斷，一般與 String.raw 的結果都不變', async () => {
  const { sandbox } = await bundleAndRun(
    'const n = 1;\n' +
      'globalThis.out = [`a</script>b${n}<!--c`, String.raw`</script>\\n<!--${n}`, `${"</script>"}${`<!--${n}`}`];\n',
  );
  assert.deepEqual(plain(sandbox.out), ['a</script>b1<!--c', '</script>\\n<!--1', '</script><!--1']);
});

test('跳脫：註解裡的 </script 與 <!-- 任意打斷，不影響程式', async () => {
  const { sandbox } = await bundleAndRun(
    '// a </script> b <!-- c\n/* </SCRIPT>\n <!-- */\nglobalThis.out = 1; // </script>\n',
  );
  assert.equal(sandbox.out, 1);
});

test('跳脫：被刪掉的 import 語句裡的註解不會造成重疊編輯', async () => {
  const { sandbox } = await bundleAndRun(
    "import {\n  a, // </script> <!--\n  b,\n} from './x.js'; // </script>\nglobalThis.out = a + b;\n",
    { 'x.js': 'export const a = 1;\nexport const b = 2;\n' },
  );
  assert.equal(sandbox.out, 3);
});

test('跳脫：一般程式碼裡出現 </script 或 <!-- 直接報錯，不默默改', async () => {
  let err = await bundleError({ 'main.js': atLine3("const t = 1 </script/.test('x');") });
  assert.match(err.message, /^main\.js:3: 程式碼裡不可直接出現 <\/script/);
  err = await bundleError({ 'main.js': atLine3('const a = 1, b = 2;\nconst c = a<!--b;') });
  assert.match(err.message, /^main\.js:4: 程式碼裡不可直接出現 <!--/);
});

test('跳脫：tagged template 內含 </script 報錯（跳脫會改變 tag 收到的字串），不含時照常', async () => {
  const err = await bundleError({
    'main.js': atLine3('const tag = (s) => s[0];\nglobalThis.out = tag`</script>`;'),
  });
  assert.match(err.message, /^main\.js:4: tagged template/);

  const { sandbox } = await bundleAndRun('const tag = (s, ...v) => s.raw.join("|") + v.length;\nglobalThis.out = tag`a${1}b`;\n');
  assert.equal(sandbox.out, 'a|b1');
});

test('regex 與除號：if/while 條件括號與 block 結尾之後的 / 是 regex，其餘 ) ] 之後是除號', async () => {
  const { sandbox } = await bundleAndRun(
    [
      `const s = 'a"b';`,
      'let hit = 0;',
      `if (s) /["']/.test(s) && (hit += 1);`,
      'while (hit < 2) /"/.test(s) && (hit += 1);',
      'function f() {}',
      `/'/.test("'") ? (hit += 10) : 0;`,
      'if (hit) { hit += 100 }',
      `/'/.test("'") && (hit += 1000);`,
      'const a = 8, b = 2, g = 2;',
      'globalThis.out = [hit, (a) / b / g, [a][0] / b / g];',
      '',
    ].join('\n'),
  );
  assert.deepEqual(plain(sandbox.out), [1112, 2, 2]);
});

test('BundleError 是 Error 的子類別，name 為 BundleError', () => {
  const err = new BundleError('x');
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'BundleError');
});
