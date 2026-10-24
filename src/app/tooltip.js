// 圖示的說明：桌機滑鼠停留或鍵盤聚焦時出現；觸控長按出現；純狀態圖示（data-tip-tap）點一下出現。
// 文字來自元素的 data-tip（由 i18n 設定，與 aria-label 相同）。
import { h, clamp } from './dom.js';

let tip = null;
let current = null;
let showTimer = 0;
let hideTimer = 0;
let press = null;
let suppressClick = null;
let hostFor = () => document.body;

export function initTooltips(getHost) {
  if (getHost) hostFor = getHost;
  tip = h('div', { class: 'tip', role: 'tooltip', id: 'lv-tip', 'aria-hidden': 'true' });

  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (!el) return;
    if (el === current) return;
    schedule(el, 420);
  });
  document.addEventListener('pointerout', (e) => {
    if (e.pointerType !== 'mouse') return;
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (!el) return;
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;
    hide();
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (el && el.matches(':focus-visible')) schedule(el, 200);
  });
  document.addEventListener('focusout', () => hide());

  // 觸控長按
  document.addEventListener('pointerdown', (e) => {
    suppressClick = null;
    hideIfOutside(e.target);
    if (e.pointerType === 'mouse') {
      hide();
      return;
    }
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (!el || el.closest('.seekbar')) return;
    cancelPress();
    press = {
      el,
      x: e.clientX,
      y: e.clientY,
      timer: setTimeout(() => {
        show(el);
        suppressClick = el;
        hideLater(2200);
        if (navigator.vibrate) { try { navigator.vibrate(8); } catch { /* 忽略 */ } }
      }, 480),
    };
  }, { passive: true });
  document.addEventListener('pointermove', (e) => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancelPress();
  }, { passive: true });
  document.addEventListener('pointerup', () => cancelPress(), { passive: true });
  document.addEventListener('pointercancel', () => cancelPress(), { passive: true });
  // 長按後不觸發按鈕本身的動作
  document.addEventListener('click', (e) => {
    if (suppressClick && suppressClick.contains(e.target)) {
      e.preventDefault();
      e.stopPropagation();
      suppressClick = null;
      return;
    }
    suppressClick = null;
    const info = e.target.closest && e.target.closest('[data-tip-tap]');
    if (info) {
      show(info);
      hideLater(2400);
    }
  }, true);
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest && e.target.closest('[data-tip]') && (!e.pointerType || e.pointerType !== 'mouse')) e.preventDefault();
  });
  // 只有包含提示對象的區域捲動時才收起（歌詞自動追蹤的捲動不影響控制列上的提示）
  window.addEventListener('scroll', (e) => {
    const t = e.target;
    if (!current) return;
    if (t === document || t === window || (t && t.contains && t.contains(current))) hide();
  }, { passive: true, capture: true });
  window.addEventListener('resize', () => hide());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
}

function cancelPress() {
  if (press) clearTimeout(press.timer);
  press = null;
}

function hideIfOutside(target) {
  if (current && !current.contains(target)) hide();
}

function schedule(el, delay) {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  showTimer = setTimeout(() => show(el), current ? 0 : delay);
}

function hideLater(ms) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => hide(), ms);
}

export function hide() {
  clearTimeout(showTimer);
  current = null;
  if (tip) tip.classList.remove('is-shown');
}

function show(el) {
  const text = el.dataset.tip;
  if (!text || !el.isConnected) return;
  const host = hostFor();
  if (tip.parentNode !== host) host.append(tip);
  current = el;
  tip.textContent = text;
  const r = el.getBoundingClientRect();
  tip.style.left = '0px';
  tip.style.top = '0px';
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  const vw = window.innerWidth;
  const margin = 8;
  let top = r.top - th - 10;
  let below = false;
  if (top < margin + 4) {
    top = r.bottom + 10;
    below = true;
  }
  const left = clamp(r.left + r.width / 2 - tw / 2, margin, vw - tw - margin);
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
  tip.classList.toggle('is-below', below);
  tip.classList.add('is-shown');
}
