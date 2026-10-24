// 低調的提示：從底部的控制列上方升起，數秒後消失；可帶一個前導圖示與一個圖示動作鈕（例如復原）。
// 面板開啟時顯示在面板裡、底部設定列上方，不擋住面板標頭的按鈕。
import { h } from './dom.js';
import { icon as iconEl } from './icons.js';

let region = null;
let hostFor = () => document.body;
const closers = new WeakMap();

export function initToasts(el, getHost) {
  region = el;
  if (getHost) hostFor = getHost;
}

// action：{ icon, label, onClick }，label 是 aria-label 與 tooltip。
// onClose(reason)：提示消失時呼叫一次；reason 是 'action'（按了動作鈕）、'timeout' 或 'dismiss'
// （點掉、被新提示擠掉、或呼叫回傳的函式）。
export function notify(message, { duration = 4200, icon = null, action = null, onClose = null, lang = null } = {}) {
  if (!region) return () => {};
  const host = hostFor();
  if (region.parentNode !== host) host.append(region);

  const text = h('span', { class: 'toast-text', lang });
  if (Array.isArray(message)) text.append(...message);
  else text.append(message);
  let actionBtn = null;
  if (action) {
    actionBtn = h('button', { class: 'toast-action press', type: 'button', 'aria-label': action.label, 'data-tip': action.label }, iconEl(action.icon));
  }
  const toast = h('div', { class: 'toast is-entering' + (action ? ' toast--action' : '') },
    icon ? h('span', { class: 'toast-lead', 'aria-hidden': 'true' }, iconEl(icon)) : null,
    text,
    actionBtn);
  let timer = 0;
  let closed = false;
  const close = (reason) => {
    clearTimeout(timer);
    if (closed) return;
    closed = true;
    if (onClose) {
      try { onClose(reason); } catch (err) { console.error('[lyrics-viewer]', err); }
    }
    if (!toast.isConnected) return;
    toast.classList.add('is-leaving');
    setTimeout(() => toast.remove(), 260);
  };
  closers.set(toast, close);
  if (actionBtn) {
    actionBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (closed) return;
      // 先關掉再執行：動作本身若又跳出新提示，這則不會被擠掉而當成「沒按」
      close('action');
      try { action.onClick(); } catch (err) { console.error('[lyrics-viewer]', err); }
    });
  }
  toast.addEventListener('click', () => close('dismiss'));
  region.append(toast);
  // 最多同時三則；被擠掉的也要走完 onClose（例如延後的刪除要真的執行）
  const live = [...region.children].filter((el) => !el.classList.contains('is-leaving'));
  for (let i = 0; i < live.length - 3; i++) {
    const c = closers.get(live[i]);
    if (c) c('dismiss');
    live[i].remove();
  }
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.remove('is-entering')));
  if (duration > 0) timer = setTimeout(() => close('timeout'), duration);
  return () => close('dismiss');
}

export function boldName(name) {
  return h('b', null, name);
}
