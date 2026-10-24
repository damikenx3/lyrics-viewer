// 封面：有圖用圖；沒有就用專輯名的明朝字排版生成。另外負責縮圖與 Media Session artwork。
import { h } from './dom.js';
import { albumLabel } from './library.js';

const CJK_RE = /[　-ヿ㐀-鿿豈-﫿＀-￯]/;

// 以 em 估算字寬（Zen Old Mincho 900 的拉丁字偏寬，寧可估大）
function units(str) {
  let u = 0;
  for (const ch of str) {
    if (CJK_RE.test(ch)) u += 1;
    else if (ch === ' ') u += 0.3;
    else if (/[iljtfrI.,'!:;|]/.test(ch)) u += 0.34;
    else if (/[mwMW]/.test(ch)) u += 0.9;
    else if (/[A-Z0-9]/.test(ch)) u += 0.72;
    else u += 0.58;
  }
  return u;
}

// 把專輯名排成 1–4 行，估算字級（cqw）
export function layoutName(name) {
  const text = String(name || '').trim() || '未分類';
  let lines;
  if (/\s/.test(text)) {
    const words = text.split(/\s+/);
    lines = [];
    const maxLines = 4;
    const target = Math.max(...words.map(units), units(text) / maxLines);
    let cur = '';
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (cur && units(next) > target * 1.15) {
        lines.push(cur);
        cur = w;
      } else cur = next;
    }
    if (cur) lines.push(cur);
  } else {
    const chars = [...text];
    const rows = chars.length <= 5 ? 1 : chars.length <= 12 ? 2 : chars.length <= 21 ? 3 : 4;
    const per = Math.ceil(chars.length / rows);
    lines = [];
    for (let i = 0; i < chars.length; i += per) lines.push(chars.slice(i, i + per).join(''));
  }
  const widest = Math.max(...lines.map(units), 1);
  const size = Math.min(76 / widest, 56 / (lines.length * 1.1), 24);
  return { lines, size };
}

export function coverNode(album, { mono = false } = {}) {
  if (album && album.cover) {
    return h('img', { src: album.cover, alt: '', decoding: 'async', loading: 'lazy' });
  }
  const name = album ? albumLabel(album.title) : '';
  if (mono) {
    const first = [...String(name || '歌').trim()][0] || '歌';
    return h('span', { class: 'gcover gcover--mono', lang: 'ja', 'aria-hidden': 'true' },
      h('span', { class: 'gcover-name' }, first));
  }
  const { lines, size } = layoutName(name);
  const nameEl = h('span', { class: 'gcover-name', style: { fontSize: `${size.toFixed(2)}cqw` } });
  lines.forEach((ln, i) => {
    if (i) nameEl.append(h('br'));
    nameEl.append(ln);
  });
  return h('span', { class: 'gcover', lang: 'ja', 'aria-hidden': 'true' },
    h('span', { class: 'gcover-stick' }), nameEl);
}

// 音訊標籤內的封面 → 長邊約 400px 的 JPEG Blob
export async function resizeCover(data, mime, max = 400) {
  try {
    const blob = new Blob([data], { type: mime || 'image/jpeg' });
    let bitmap;
    if (typeof createImageBitmap === 'function') {
      bitmap = await createImageBitmap(blob);
    } else {
      bitmap = await loadImage(URL.createObjectURL(blob));
    }
    const w = bitmap.width;
    const hgt = bitmap.height;
    const scale = Math.min(1, max / Math.max(w, hgt));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(hgt * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, cw, ch);
    if (bitmap.close) bitmap.close();
    return await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.86));
  } catch {
    return null;
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Media Session 用的 artwork：有封面用封面，沒有就用 canvas 畫生成封面
const artCache = new Map();   // 生成封面：畫上去的文字 → artwork
const sizeCache = new Map();  // 封面圖：src → Promise<'寬x高' | null>

export async function artworkFor(album) {
  if (!album) return [];
  if (album.cover) {
    const sizes = await coverSizes(album.cover);
    return sizes ? [{ src: album.cover, sizes, type: guessType(album.cover) }] : [];
  }
  // 「未分類」依介面語言顯示不同文字，快取 key 要用實際畫上去的文字
  const label = albumLabel(album.title);
  if (artCache.has(label)) return artCache.get(label);
  const out = await drawArtwork(label).catch(() => []);
  artCache.set(label, out);
  return out;
}

// sizes 要寫圖片實際尺寸（可能是內嵌的大圖，也可能是標籤縮圖後的 400px）；載入失敗回 null，不留快取
function coverSizes(src) {
  let p = sizeCache.get(src);
  if (!p) {
    p = measureImage(src);
    sizeCache.set(src, p);
    p.then((sizes) => { if (!sizes) sizeCache.delete(src); });
  }
  return p;
}

async function measureImage(src) {
  try {
    const img = await loadImage(src);
    const w = img.naturalWidth;
    const hgt = img.naturalHeight;
    return w > 0 && hgt > 0 ? `${w}x${hgt}` : null;
  } catch {
    return null;
  }
}

function guessType(src) {
  if (/^data:image\/png/.test(src) || /\.png$/i.test(src)) return 'image/png';
  if (/^data:image\/webp/.test(src)) return 'image/webp';
  return 'image/jpeg';
}

async function drawArtwork(name) {
  const S = 512;
  const family = '"Zen Old Mincho", "Hiragino Mincho ProN", "Yu Mincho", serif';
  const { lines, size } = layoutName(name);
  const px = (size / 100) * S;
  try {
    if (document.fonts && document.fonts.load) await document.fonts.load(`900 ${Math.round(px)}px "Zen Old Mincho"`, lines.join(''));
  } catch { /* 字型載入失敗就用系統明朝 */ }
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#26252D';
  ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = '#FE4B74';
  roundRect(ctx, S * 0.1, S * 0.1, S * 0.032, S * 0.26, S * 0.016);
  ctx.fill();
  ctx.fillStyle = '#F7F3F6';
  ctx.font = `900 ${px}px ${family}`;
  ctx.textBaseline = 'alphabetic';
  const lh = px * 1.08;
  let y = S * 0.91 - (lines.length - 1) * lh - px * 0.16;
  for (const ln of lines) {
    ctx.fillText(ln, S * 0.1, y, S * 0.82);
    y += lh;
  }
  const url = canvas.toDataURL('image/png');
  return [{ src: url, sizes: '512x512', type: 'image/png' }];
}

function roundRect(ctx, x, y, w, hgt, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + hgt, r);
  ctx.arcTo(x + w, y + hgt, x, y + hgt, r);
  ctx.arcTo(x, y + hgt, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
