// 匯入中的忙碌狀態：所有「加入檔案」按鈕（data-add）一起顯示轉圈與「已處理/總數」，並暫停接受點擊。
import { h } from './dom.js';
import { icon } from './icons.js';
import { t } from './i18n.js';

let progress = null; // { done, total }

export function isImporting() {
  return !!progress;
}

// total 為 0 代表結束
export function setImportProgress(done, total) {
  progress = total > 0 ? { done: Math.min(done, total), total } : null;
  for (const btn of document.querySelectorAll('[data-add]')) paintAdd(btn);
}

// 新建立的加入檔案按鈕也要套上目前狀態
export function paintAdd(btn) {
  btn.dataset.add = '';
  const on = !!progress;
  btn.classList.toggle('is-busy', on);
  let box = btn.querySelector('.busy');
  if (on && !box) {
    box = h('span', { class: 'busy', 'aria-hidden': 'true' }, icon('busy', 'busy-ico'), h('span', { class: 'busy-count' }));
    btn.append(box);
  }
  const key = btn.dataset.i18nLabel;
  if (on) {
    box.lastChild.textContent = `${progress.done}/${progress.total}`;
    const label = t('importing', { done: progress.done, total: progress.total });
    btn.setAttribute('aria-label', label);
    btn.dataset.tip = label;
    btn.setAttribute('aria-disabled', 'true');
    btn.setAttribute('aria-busy', 'true');
  } else {
    if (key) {
      btn.setAttribute('aria-label', t(key));
      btn.dataset.tip = t(key);
    }
    btn.removeAttribute('aria-disabled');
    btn.removeAttribute('aria-busy');
  }
}
