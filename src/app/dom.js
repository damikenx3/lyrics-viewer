// 小工具：建立元素、時間格式、reduced-motion 偵測
import { t } from './i18n.js';

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const key in props) {
      const v = props[key];
      if (v == null || v === false) continue;
      if (key === 'class') el.className = v;
      else if (key === 'text') el.textContent = v;
      else if (key === 'dataset') Object.assign(el.dataset, v);
      else if (key === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (key.startsWith('on') && typeof v === 'function') el.addEventListener(key.slice(2), v);
      else if (v === true) el.setAttribute(key, '');
      else el.setAttribute(key, v);
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec + 1e-6);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function spokenTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec);
  return t('spoken', { m: Math.floor(s / 60), s: s % 60 });
}

const rmQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
export function reducedMotion() {
  return !!(rmQuery && rmQuery.matches);
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// WAAPI 動畫，回傳 finished promise；不支援時直接 resolve。
// 隱藏的頁面不推進動畫，所以加上逾時，避免等待的流程卡住。
export function animate(el, keyframes, options) {
  if (!el || typeof el.animate !== 'function') return Promise.resolve();
  try {
    const a = el.animate(keyframes, options);
    const total = ((options && options.duration) || 0) + ((options && options.delay) || 0);
    const timeout = new Promise((r) => setTimeout(r, total + 120));
    return Promise.race([a.finished.then(() => a, () => a), timeout]);
  } catch {
    return Promise.resolve();
  }
}

export function fileExt(name) {
  const m = /\.([^.\\/]+)$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

export function baseName(name) {
  return String(name || '').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
}
