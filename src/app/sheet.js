// 歌曲庫底部面板：依專輯分組、快速跳轉、目前歌曲標示；返回鍵與下拉可關閉。
// 編輯模式：曲目列出現「移除連結的音訊」「移除匯入的歌詞」圖示按鈕。
import { h, reducedMotion } from './dom.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { coverNode } from './cover.js';
import { UNSORTED, albumLabel } from './library.js';
import { paintAdd } from './busy.js';
import { labelEl } from './lyrics.js';

export class LibrarySheet {
  // history：{ pushSheet(), popSheet() }，返回鍵的堆疊由呼叫端管理
  constructor({ dialog, list, jump, grab, closeBtn, editBtn, history, onPick, onClosed, onAdd, onRemoveAudio, onRemoveLyrics }) {
    this.onClosed = onClosed;
    this.dialog = dialog;
    this.panel = dialog.querySelector('.sheet-panel');
    this.list = list;
    this.jump = jump;
    this.grab = grab;
    this.editBtn = editBtn;
    this.history = history;
    this.onPick = onPick;
    this.onAdd = onAdd;
    this.onRemoveAudio = onRemoveAudio;
    this.onRemoveLyrics = onRemoveLyrics;
    this.isOpen = false;
    this.editing = false;
    this.rows = new Map();
    this.currentId = null;
    this.opener = null;
    this.closeTimer = 0;
    this.refocus = null;

    closeBtn.addEventListener('click', () => this.close());
    editBtn.addEventListener('click', () => this.setEditing(!this.editing));
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      this.close();
    });
    // Android 的返回鍵可能由瀏覽器直接關掉 modal dialog（cancel 不可取消時）：狀態跟著同步
    dialog.addEventListener('close', () => {
      if (this.isOpen) this.close();
    });
    // 點背景關閉
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) this.close();
    });
    list.addEventListener('click', (e) => {
      const act = e.target.closest('[data-edit]');
      if (act) {
        const id = act.dataset.id;
        // 移除後這個按鈕會消失：焦點移到同一列剩下的按鈕，或下一列
        this.refocus = { id, after: this.nextRowId(id) };
        if (act.dataset.edit === 'audio') this.onRemoveAudio(id);
        else this.onRemoveLyrics(id);
        return;
      }
      const row = e.target.closest('button.track');
      if (row) this.onPick(row.dataset.id);
    });
    jump.addEventListener('click', (e) => {
      const chip = e.target.closest('.jump-chip');
      if (!chip) return;
      // .sheet-list 是 position: relative，offsetTop 直接相對於清單
      const target = this.list.querySelector(`[data-album-index="${chip.dataset.index}"]`);
      if (target) this.scrollList(target.offsetTop, !reducedMotion());
    });
    this.setupDrag();
  }

  setEditing(on) {
    on = !!(on && this.library && this.library.hasRemovable());
    if (on === this.editing) return;
    this.editing = on;
    this.dialog.classList.toggle('is-editing', on);
    this.editBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (this.library) {
      const top = this.list.scrollTop;
      this.render(this.library, this.currentId);
      this.list.scrollTop = top;
    }
  }

  nextRowId(id) {
    const ids = [...this.rows.keys()];
    const i = ids.indexOf(id);
    return i >= 0 && i + 1 < ids.length ? ids[i + 1] : null;
  }

  render(library, currentId) {
    this.library = library;
    this.currentId = currentId;
    this.rows.clear();
    // 沒有可移除的東西時編輯按鈕停用；編輯中刪光了就自動結束編輯
    const removable = library.hasRemovable();
    this.editBtn.disabled = !removable;
    if (!removable && this.editing) {
      this.editing = false;
      this.dialog.classList.remove('is-editing');
      this.editBtn.setAttribute('aria-pressed', 'false');
    }
    const albums = library.albums;
    const hadFocus = this.list.contains(document.activeElement);
    const frag = document.createDocumentFragment();
    const sep = t('sep');

    if (!albums.length) frag.append(this.renderEmpty());

    albums.forEach((album, ai) => {
      const count = album.songs.length;
      const section = h('section', { class: 'album', 'data-album-index': String(ai), 'aria-labelledby': `album-${ai}` },
        h('div', { class: 'album-head' },
          h('div', { class: 'album-cover' }, coverNode(album)),
          h('div', null,
            h('h3', { class: 'album-name', id: `album-${ai}`, lang: album.title === UNSORTED ? null : 'ja' }, albumLabel(album.title)),
            album.artist ? h('p', { class: 'album-artist', lang: 'ja' }, album.artist) : null,
            h('p', { class: 'album-count' },
              icon('library'),
              h('span', { 'aria-hidden': 'true' }, String(count)),
              h('span', { class: 'sr-only' }, t('songCount', { n: count }))))));
      const ol = h('ol', { class: 'tracks' });
      for (const song of album.songs) {
        const no = h('span', { class: 'track-no' }, song.track != null ? String(song.track).padStart(2, '0') : '–');
        const title = h('span', { class: 'track-title', lang: 'ja' }, song.title);
        let row;
        if (this.editing) {
          row = h('div', { class: 'track track--edit', 'data-id': song.id }, no, title, this.editActions(library, song));
        } else {
          const hasAudio = library.hasAudio(song.id);
          const label = [song.title, hasAudio ? t('hasAudio') : t('noAudio')];
          const flags = h('span', { class: 'track-flags', 'aria-hidden': 'true' });
          flags.append(hasAudio ? h('span', { class: 'is-on' }, icon('audio')) : h('span'));
          if (song.audioOnly) {
            flags.append(h('span', { class: 'is-off' }, icon('noLyrics')));
            label.push(t('noLyricsShort'));
          } else if (song.timed) {
            flags.append(h('span', { class: 'is-on' }, icon('timed')));
            label.push(t('timed'));
          } else {
            flags.append(h('span', { class: 'is-off' }, icon('untimed')));
            label.push(t('untimedShort'));
          }
          row = h('button', {
            class: 'track press',
            type: 'button',
            'data-id': song.id,
            'aria-label': label.join(sep),
          }, no, title, flags);
        }
        this.rows.set(song.id, { row, no, track: song.track });
        ol.append(h('li', null, row));
      }
      section.append(ol);
      frag.append(section);
    });
    this.list.replaceChildren(frag);

    this.jump.hidden = albums.length < 2;
    this.jump.replaceChildren(...albums.map((a, i) => h('button', {
      class: 'jump-chip press', type: 'button', 'data-index': String(i), lang: a.title === UNSORTED ? null : 'ja',
    }, h('span', { class: 'jump-label' }, albumLabel(a.title)))));
    this.markCurrent(currentId);
    this.restoreFocus(hadFocus);
  }

  // 編輯模式的曲目按鈕：有連結的音訊才能移除音訊；顯示的是匯入版本才能移除歌詞
  editActions(library, song) {
    const box = h('span', { class: 'track-edit' });
    const add = (kind, name, key) => {
      const b = h('button', { class: 'edit-btn press', type: 'button', 'data-edit': kind, 'data-id': song.id }, icon(name));
      const label = t(key, { title: song.title });
      b.setAttribute('aria-label', label);
      b.dataset.tip = label;
      box.append(b);
    };
    if (library.canRemoveLyrics(song.id)) {
      add('lyrics', 'removeLyrics', library.hasEmbedded(song.id) ? 'removeLyricsRevert' : 'removeLyricsDrop');
    }
    if (library.canRemoveAudio(song.id)) add('audio', 'unlinkAudio', 'removeAudio');
    return box;
  }

  restoreFocus(hadFocus) {
    const hint = this.refocus;
    this.refocus = null;
    if (!hint || !hadFocus || !this.isOpen) return;
    const pick = (id) => id && this.list.querySelector(`[data-edit][data-id="${CSS.escape(id)}"]`);
    const el = pick(hint.id) || pick(hint.after) || this.list.querySelector('[data-edit]') || this.editBtn;
    try { el.focus({ preventScroll: false }); } catch { /* 忽略 */ }
  }

  // 歌曲庫是空的：圖示＋一句說明＋加入檔案
  renderEmpty() {
    const add = h('button', { class: 'round-btn round-btn--solid press', type: 'button', onclick: () => this.onAdd() }, icon('addFiles'));
    labelEl(add, 'addFiles');
    paintAdd(add);
    return h('div', { class: 'sheet-empty' },
      h('div', { class: 'empty-light', 'aria-hidden': 'true' }, icon('penlight')),
      h('p', { class: 'empty-body' }, t('empty')),
      add);
  }

  markCurrent(id) {
    const prev = this.rows.get(this.currentId);
    if (prev) {
      prev.row.classList.remove('is-current');
      prev.row.removeAttribute('aria-current');
      prev.no.replaceChildren(prev.track != null ? String(prev.track).padStart(2, '0') : '–');
    }
    this.currentId = id;
    const cur = this.rows.get(id);
    if (cur) {
      cur.row.classList.add('is-current');
      cur.row.setAttribute('aria-current', 'true');
      cur.no.replaceChildren(h('span', { class: 'eq', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')));
    }
    // 跳轉列標示目前專輯
    const section = cur && cur.row.closest('.album');
    const idx = section ? section.dataset.albumIndex : null;
    for (const chip of this.jump.children) chip.classList.toggle('is-current', chip.dataset.index === idx);
  }

  scrollList(y, smooth) {
    const max = this.list.scrollHeight - this.list.clientHeight;
    const to = Math.max(0, Math.min(max, y));
    if (smooth && this.list.scrollTo) this.list.scrollTo({ top: to, behavior: 'smooth' });
    else this.list.scrollTop = to;
  }

  open({ viaKeyboard = false } = {}) {
    if (this.isOpen) return;
    clearTimeout(this.closeTimer);
    this.isOpen = true;
    this.viaKeyboard = viaKeyboard;
    if (!this.dialog.open) this.opener = document.activeElement;
    if (!this.dialog.open) {
      try { this.dialog.showModal(); } catch { this.dialog.setAttribute('open', ''); }
    }
    // 捲到目前歌曲
    const cur = this.rows.get(this.currentId);
    if (cur) {
      const row = cur.row;
      const y = row.offsetTop - this.list.clientHeight * 0.35;
      this.scrollList(y, false);
    }
    // 鍵盤開啟時把焦點放在目前歌曲；觸控／滑鼠開啟時放在面板本身（不顯示焦點框）
    const focusTarget = viaKeyboard && cur ? cur.row : this.panel;
    try { focusTarget.focus({ preventScroll: true }); } catch { /* 忽略 */ }
    this.panel.style.transform = '';
    this.dialog.getBoundingClientRect();
    requestAnimationFrame(() => { if (this.isOpen) this.dialog.classList.add('is-open'); });
    this.history.pushSheet();
  }

  // fromHistory：由返回鍵關閉，history 已經退回，不要再動它
  close({ fromHistory = false } = {}) {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.dialog.classList.remove('is-open', 'is-dragging');
    this.panel.style.transform = '';
    const finish = () => {
      if (this.isOpen) return;
      try { this.dialog.close(); } catch { this.dialog.removeAttribute('open'); }
      // 下次打開時回到一般模式
      if (this.editing) this.setEditing(false);
      if (this.onClosed) this.onClosed();
      // 鍵盤使用者回到開啟面板的按鈕；觸控／滑鼠使用者不留焦點框
      const opener = this.opener;
      if (opener && opener.focus && opener !== document.body) {
        try {
          if (this.viaKeyboard) opener.focus({ preventScroll: true });
          else if (document.activeElement === opener) opener.blur();
        } catch { /* 忽略 */ }
      }
    };
    this.closeTimer = setTimeout(finish, reducedMotion() ? 200 : 360);
    if (!fromHistory) this.history.popSheet();
  }

  // 從把手／標頭往下拖可關閉
  setupDrag() {
    let start = null;
    this.grab.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button') || (e.pointerType === 'mouse' && e.button !== 0)) return;
      start = { y: e.clientY, t: performance.now(), id: e.pointerId, dy: 0 };
      try { this.grab.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
      this.dialog.classList.add('is-dragging');
    });
    this.grab.addEventListener('pointermove', (e) => {
      if (!start || e.pointerId !== start.id) return;
      start.dy = Math.max(0, e.clientY - start.y);
      this.panel.style.transform = `translateY(${start.dy}px)`;
    });
    const end = (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dy = start.dy;
      const v = dy / Math.max(1, performance.now() - start.t);
      start = null;
      this.dialog.classList.remove('is-dragging');
      if (dy > 120 || (dy > 40 && v > 0.6)) this.close();
      else this.panel.style.transform = '';
    };
    this.grab.addEventListener('pointerup', end);
    this.grab.addEventListener('pointercancel', end);
  }
}
