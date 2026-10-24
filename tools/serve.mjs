// 區網開發伺服器：每次請求 / 都重新建置（在記憶體中），音檔支援 HTTP Range。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { collectLibrary, toPosix, AUDIO_EXTS } from './library.mjs';
import { bundleHtml, injectLibrary } from './bundle.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.weba': 'audio/webm',
  '.webm': 'audio/webm',
};

export function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

// URL 路徑 → root 底下的檔案；越界（../）回傳 null。
function resolveUnder(root, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const abs = path.resolve(root, '.' + path.sep + rel.replace(/^\/+/, ''));
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(text);
}

function errorPage(title, lines) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title>
<body style="font:14px/1.5 monospace;padding:1em;white-space:pre-wrap"><h3>${esc(title)}</h3>${lines.map(esc).join('\n')}</body>`;
}

// 檔案內容用 stream.pipeline 送出：client 中斷時會一併關掉 read stream。
// 等 read stream 開檔成功才寫 header，開檔失敗可以回 500；傳送途中出錯則由 pipeline 結束回應。
// 開檔期間 client 可能已離開（<audio> 換 src、拖進度條會取消 Range 請求），此時 res 已關閉，不能再 pipe。
export function streamFile(res, abs, opts, status, headers, log) {
  const rs = fs.createReadStream(abs, opts);
  let started = false;
  // pipeline 接手之前 client 就斷線：自己關掉 read stream，不然 fd 會一直開著
  const onClose = () => rs.destroy();
  res.once('close', onClose);
  rs.once('error', (e) => {
    if (started) return;
    log(`讀取失敗：${abs}：${e.message}`);
    sendText(res, 500, 'Read error');
  });
  rs.once('open', () => {
    res.off('close', onClose);
    // client 已離開：不寫 header、不 pipe
    if (res.destroyed || res.closed) return void rs.destroy();
    started = true;
    // 這裡在 event handler 內，同步丟錯會讓整個行程結束，所以一定要接住
    try {
      res.writeHead(status, headers);
      pipeline(rs, res, (err) => {
        if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') log(`傳送中斷：${abs}：${err.message}`);
      });
    } catch (e) {
      rs.destroy();
      res.destroy();
      log(`傳送失敗：${abs}：${e.message}`);
    }
  });
}

// 音檔：支援 Range，<audio> 才能拖曳進度。
function sendFile(req, res, abs, log) {
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return sendText(res, 404, 'Not found');
  }
  if (!stat.isFile()) return sendText(res, 404, 'Not found');
  const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  const size = stat.size;
  const range = req.headers.range;
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start;
    let end;
    if (m && (m[1] !== '' || m[2] !== '')) {
      if (m[1] === '') {
        // bytes=-N：最後 N bytes
        start = Math.max(0, size - Number(m[2]));
        end = size - 1;
      } else {
        start = Number(m[1]);
        end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
      }
    }
    if (start == null || start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    const h = { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 };
    if (req.method === 'HEAD') return void res.writeHead(206, h).end();
    return streamFile(res, abs, { start, end }, 206, h, log);
  }
  const h = { ...headers, 'Content-Length': size };
  if (req.method === 'HEAD') return void res.writeHead(200, h).end();
  return streamFile(res, abs, {}, 200, h, log);
}

export function startServer({ port, host = '0.0.0.0', srcDir, libraryDir, audioDir, log = console.log }) {
  const audioUrl = (abs) => '/audio/' + toPosix(path.relative(audioDir, abs)).split('/').map(encodeURIComponent).join('/');
  const build = async () => {
    const lib = await collectLibrary({ libraryDir, audioDir, audioUrl });
    const errors = lib.issues.filter((x) => x.level === 'error');
    const songs = lib.files.reduce((n, f) => n + f.result.songs.length, 0);
    log(`[${new Date().toLocaleTimeString()}] 重新建置：${lib.files.length} 個檔案、${songs} 首歌、${Object.keys(lib.library?.audio || {}).length} 個音檔路徑${errors.length ? `、${errors.length} 個錯誤（npm run check 看細節）` : ''}`);
    return lib;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed');
      if (p === '/' || p === '/index.html') {
        const lib = await build();
        if (!lib.library) return sendText(res, 500, errorPage('建置失敗', lib.issues.map((x) => `${x.file}: ${x.message}`)), MIME['.html']);
        const { html } = await bundleHtml({ srcDir, library: lib.library });
        return sendText(res, 200, html, MIME['.html']);
      }
      if (p.startsWith('/audio/')) {
        const abs = resolveUnder(audioDir, p.slice('/audio/'.length));
        if (!abs) return sendText(res, 403, 'Forbidden');
        // 只提供音檔，音檔資料夾裡的其他檔案不外流
        if (!AUDIO_EXTS.has(path.extname(abs).toLowerCase())) return sendText(res, 404, 'Not found');
        return sendFile(req, res, abs, log);
      }
      if (p === '/src') {
        // 轉到 /src/，index.html 裡的相對路徑（app/main.js）才會解析到 /src/ 底下
        res.writeHead(301, { Location: '/src/' + url.search, 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (p.startsWith('/src/')) {
        const rel = p === '/src/' ? 'index.html' : p.slice('/src/'.length);
        const abs = resolveUnder(srcDir, rel);
        if (!abs) return sendText(res, 403, 'Forbidden');
        // 未打包的開發模式：src/index.html 也注入目前的歌詞庫，模組直接由瀏覽器載入。
        if (path.resolve(abs) === path.resolve(srcDir, 'index.html')) {
          const lib = await build();
          const html = fs.readFileSync(abs, 'utf8');
          return sendText(res, 200, lib.library ? injectLibrary(html, lib.library) : html, MIME['.html']);
        }
        return sendFile(req, res, abs, log);
      }
      return sendText(res, 404, 'Not found');
    } catch (e) {
      log(`錯誤：${e.message}`);
      return sendText(res, 500, errorPage('建置失敗', [e.message]), MIME['.html']);
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
