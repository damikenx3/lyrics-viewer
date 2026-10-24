// 歌詞畫面：標題區 + 歌詞行；依播放時間切換亮／未唱／已唱，只動有變化的行。
import { h, animate, reducedMotion } from './dom.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { queryTimeline, segmentLit } from './core.js';
import { UNSORTED } from './library.js';
import { formatAudioError } from './transport.js';
import { paintAdd } from './busy.js';

const FUTURE = 0;
const LIT = 1;
const PAST = 2;

export class LyricsView {
  // topClear()：上方淡出區（含小標題的底帶）的高度，同時亮的較早行要停在它下面
  constructor({ column, scroller, onLineClick, onAction, onLayout, topClear }) {
    this.column = column;
    this.onLayout = onLayout;
    this.topClear = topClear || (() => 0);
    this.scroller = scroller;
    this.onLineClick = onLineClick;
    this.onAction = onAction;
    this.song = null;
    this.lineEls = [];
    this.state = null;
    this.timedLines = [];
    this.inlineLines = new Set();
    this.segEls = [];
    this.tops = null;
    this.rowHalf = 0;
    this.head = null;
    this.titleEl = null;
    this.statusEl = null;
    this.out = null;       // 進行中（或已完成）的淡出：{ target, promise }

    column.addEventListener('click', (e) => {
      const li = e.target.closest('.ln[data-seek]');
      if (li && this.song) this.onLineClick(Number(li.dataset.i));
    });

    // 版面變了（視窗大小、字型載入、字級、狀態列）：位置要重量，並讓呼叫端重新對位
    const invalidate = () => {
      this.tops = null;
      if (this.onLayout) this.onLayout();
    };
    if (typeof ResizeObserver === 'function') new ResizeObserver(invalidate).observe(column);
    window.addEventListener('resize', invalidate);
    if (document.fonts && document.fonts.addEventListener) {
      document.fonts.addEventListener('loadingdone', invalidate);
    }
  }

  // ───────────── 繪製 ─────────────

  renderEmpty(onAdd) {
    this.song = null;
    this.lineEls = [];
    this.timedLines = [];
    this.state = null;
    this.tops = null;
    this.head = null;
    this.titleEl = null;
    this.statusEl = null;
    this.out = null;
    const add = h('button', { class: 'round-btn round-btn--solid press', type: 'button', onclick: onAdd }, icon('addFiles'));
    labelEl(add, 'addFiles');
    paintAdd(add);
    this.emptyBody = h('p', { class: 'empty-body' }, t('empty'));
    this.column.replaceChildren(
      h('section', { class: 'empty' },
        h('div', { class: 'empty-light', 'aria-hidden': 'true' }, icon('penlight')),
        this.emptyBody,
        add));
  }

  // 語言切換後重繪需要文字的部分
  relabel(status) {
    if (!this.song) {
      if (this.emptyBody) this.emptyBody.textContent = t('empty');
      for (const el of this.column.querySelectorAll('[data-i18n-label]')) labelEl(el, el.dataset.i18nLabel);
      return;
    }
    this.setStatus(status);
  }

  render(song, { album, status }) {
    this.song = song;
    this.tops = null;
    this.out = null;

    const head = h('header', { class: 'head' });
    if (song.track != null) head.append(h('p', { class: 'head-no' }, String(song.track).padStart(2, '0')));
    this.titleEl = h('h1', { class: 'head-title', lang: 'ja', id: 'song-title' }, song.title);
    head.append(h('div', { class: 'head-mask' }, this.titleEl));

    const artist = song.artist || (album && album.artist) || null;
    const albumName = song.album && song.album !== UNSORTED ? song.album : null;
    if (artist || albumName) {
      head.append(h('p', { class: 'head-album', lang: 'ja' },
        artist || '', albumName ? `『${albumName}』` : ''));
    }
    if (song.credits && song.credits.length) {
      head.append(h('ul', { class: 'head-credits', lang: 'ja' }, song.credits.map((c) => h('li', null, c))));
    }
    this.statusEl = h('div', { class: 'head-status' });
    head.append(this.statusEl);
    this.head = head;

    const list = h('ol', { class: 'lyrics', lang: 'ja' });
    const n = song.lines.length;
    this.lineEls = new Array(n);
    this.segEls = new Array(n);
    this.state = new Int8Array(n);
    this.timedLines = [];
    this.inlineLines = new Set();
    let hasRuby = false;

    for (let i = 0; i < n; i++) {
      const line = song.lines[i];
      if (line.blank) {
        const li = h('li', { class: 'ln ln--blank', 'aria-hidden': 'true' });
        this.lineEls[i] = li;
        list.append(li);
        continue;
      }
      const textLayer = h('span', { class: 'ln-text' });
      const glowLayer = h('span', { class: 'ln-glow', 'aria-hidden': 'true' });
      const segs = [];
      let hasInline = false;
      line.segments.forEach((seg) => {
        const waits = seg.at != null;
        if (waits) hasInline = true;
        const cls = 'sg' + (seg.call ? ' sg--call' : '') + (waits ? ' is-wait' : '');
        if (seg.ruby) hasRuby = true;
        const a = h('span', { class: cls }, segContent(seg));
        const b = h('span', { class: cls }, segContent(seg));
        textLayer.append(a);
        glowLayer.append(b);
        segs.push([a, b]);
      });
      const timed = line.times && line.times.length > 0;
      const li = h('li', {
        class: 'ln',
        dataset: timed ? { i: String(i), seek: '' } : { i: String(i) },
      },
      h('span', { class: 'ln-body' }, glowLayer, textLayer));
      this.lineEls[i] = li;
      this.segEls[i] = segs;
      if (timed) this.timedLines.push(i);
      if (hasInline) this.inlineLines.add(i);
      list.append(li);
    }

    if (!n) list.hidden = true;
    const wrap = h('div', { class: 'song' + (hasRuby ? ' song--ruby' : '') }, head, list);
    this.column.replaceChildren(wrap);
    this.list = list;
    this.setStatus(status);
  }

  // 標題區的狀態：以圖示表達（沒有音訊／尚未對時／沒有歌詞），附下一步的圖示按鈕；錯誤才用文字
  setStatus(status) {
    if (!this.statusEl || !this.song) return;
    const song = this.song;
    const box = this.statusEl;
    box.replaceChildren();
    // 連結音訊、加入歌詞都是加入檔案：匯入中一起顯示忙碌
    const button = (name, key, action) => {
      const b = h('button', { class: 'round-btn press', type: 'button', onclick: () => this.onAction(action) }, icon(name));
      labelEl(b, key);
      paintAdd(b);
      return b;
    };
    const state = (name, key) => {
      const el = h('span', { class: 'status-ico', role: 'img', 'data-tip-tap': '' }, icon(name));
      labelEl(el, key);
      return el;
    };

    if (status.error) {
      // 錯誤說明在上、下一步的按鈕在下並對齊文字，手機與桌機排列一致
      const err = formatAudioError(status.error, { timed: song.timed });
      box.append(h('div', { class: 'head-error' },
        icon('warning'),
        h('p', { class: 'head-error-text' },
          h('strong', null, err.title),
          h('span', null, err.body)),
        h('div', { class: 'head-error-next' }, button('linkAudio', 'linkOtherAudio', 'link-audio'))));
      return;
    }
    if (song.audioOnly) {
      box.append(state('noLyrics', 'noLyrics'), button('addFiles', 'addLyrics', 'add-files'));
      return;
    }
    if (!song.timed) box.append(state('untimed', 'untimed'));
    if (!status.hasAudio) box.append(button('linkAudio', 'linkAudio', 'link-audio'));
  }

  // ───────────── 換歌動畫 ─────────────

  // 連按換歌時會在淡出途中再被呼叫：同一份內容沿用同一個淡出，不從不透明重來
  animateOut() {
    const target = this.column.firstElementChild;
    if (!target) return Promise.resolve();
    if (this.out && this.out.target === target) return this.out.promise;
    this.column.classList.add('is-swapping');
    // 只給終點，起點取目前的值（換歌動畫的淡入還沒跑完時也能接著淡出）
    const promise = reducedMotion()
      ? animate(target, [{ opacity: 0 }], { duration: 160, easing: 'linear', fill: 'forwards' })
      : animate(target, [{ opacity: 0, transform: 'translateY(-24px)' }], { duration: 200, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' });
    this.out = { target, promise };
    return promise;
  }

  animateIn() {
    this.column.classList.remove('is-swapping');
    const root = this.column.firstElementChild;
    if (!root) return;
    if (reducedMotion()) {
      animate(root, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'linear' });
      return;
    }
    if (!this.head) {
      animate(root, [{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' });
      return;
    }
    const ease = 'cubic-bezier(.22, 1, .36, 1)';
    // 1) 歌名從遮罩下方升起
    animate(this.titleEl, [
      { transform: 'translateY(105%)' },
      { transform: 'translateY(0)' },
    ], { duration: 420, easing: ease, fill: 'backwards' });
    // 曲序、專輯、credits 與狀態跟著淡入
    const companions = [...this.head.children].filter((el) => !el.classList.contains('head-mask'));
    companions.forEach((el, k) => {
      animate(el, [{ opacity: 0 }, { opacity: 1 }], {
        duration: 320, delay: k === 0 ? 0 : 180 + k * 40, easing: 'ease-out', fill: 'backwards',
      });
    });
    // 2) 前 12 行以 30ms 間隔淡入，其餘直接出現
    let k = 0;
    for (const li of this.lineEls) {
      if (!li || li.classList.contains('ln--blank')) continue;
      if (k >= 12) break;
      animate(li, [
        { opacity: 0, transform: 'translateY(10px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ], { duration: 380, delay: 300 + k * 30, easing: ease, fill: 'backwards' });
      k++;
    }
  }

  // ───────────── 時間更新 ─────────────

  // 回傳 latest（目前最晚開始的亮行），給呼叫端判斷
  update(t) {
    const song = this.song;
    if (!song || !song.timed || !this.state) return -1;
    const q = queryTimeline(song, t);
    const active = new Map();
    for (const a of q.active) {
      const cur = active.get(a.line);
      if (!cur || a.start > cur.start) active.set(a.line, a);
    }

    for (const i of this.timedLines) {
      const times = song.lines[i].times;
      const st = active.has(i) ? LIT : times[0] <= t ? PAST : FUTURE;
      if (st !== this.state[i]) {
        const li = this.lineEls[i];
        li.classList.toggle('is-lit', st === LIT);
        li.classList.toggle('is-past', st === PAST);
        if (st === LIT) li.setAttribute('aria-current', 'true');
        else li.removeAttribute('aria-current');
        this.state[i] = st;
      }
    }

    for (const i of active.keys()) {
      if (this.inlineLines.has(i)) this.updateSegments(i, t);
    }
    return q.latest;
  }

  updateSegments(i, t) {
    const segs = this.segEls[i];
    const line = this.song.lines[i];
    for (let s = 0; s < segs.length; s++) {
      if (line.segments[s].at == null) continue;
      const lit = segmentLit(this.song, i, s, t);
      const [a, b] = segs[s];
      if (a.classList.contains('is-wait') === lit) {
        a.classList.toggle('is-wait', !lit);
        b.classList.toggle('is-wait', !lit);
      }
    }
  }

  // 某個時間點的歌詞（給進度條泡泡）
  lyricAt(t) {
    const song = this.song;
    if (!song || !song.timed) return null;
    const q = queryTimeline(song, t);
    let li = q.latest;
    if (li < 0) li = lastStartedLine(song, t);
    if (li < 0) return null;
    const line = song.lines[li];
    const text = line.segments.map((s) => s.text).join('').trim();
    if (!text) return null;
    return { text, call: line.segments.every((s) => s.call || !s.text.trim()) };
  }

  // ───────────── 位置 ─────────────

  measure() {
    if (this.tops) return;
    const n = this.lineEls.length;
    this.tops = new Float32Array(n);
    const base = this.column.offsetTop;
    for (let i = 0; i < n; i++) {
      const el = this.lineEls[i];
      this.tops[i] = el ? base + el.offsetTop : 0;
    }
    const fs = parseFloat(getComputedStyle(this.column).fontSize) || 22;
    this.rowHalf = fs * (1.55 / 2 + 0.09);
    // 尾端留白：讓最後一行也能停在 38% 的位置
    if (this.list) this.list.style.setProperty('--tail', `${Math.round(this.scroller.clientHeight * 0.62)}px`);
  }

  // 讓第 i 行停在可視區 38% 的 scrollTop。
  // first：同時亮著、比 i 早的行；它不能被推進上方淡出區（橫向手機可視高度小時特別明顯），
  // 但只在第 i 行仍停在可視區上方四分之三以內時才遷就它（很長的背景行不該拖住捲動）。
  scrollTopFor(i, at = 0.38, first = -1) {
    this.measure();
    if (!this.tops || i < 0 || i >= this.tops.length) return 0;
    const vh = this.scroller.clientHeight;
    const y = this.tops[i] + this.rowHalf - vh * at;
    if (first < 0 || first >= i) return y;
    const fit = Math.min(y, this.tops[first] - this.topClear() - 2);
    return this.tops[i] + this.rowHalf - fit <= vh * 0.75 ? fit : y;
  }

  // 第 i 行相對於可視區的 y（中心）
  lineViewportY(i) {
    this.measure();
    if (!this.tops || i < 0) return null;
    return this.tops[i] + this.rowHalf - this.scroller.scrollTop;
  }
}

// t 之前最後一個開始的行（含已結束的）
export function lastStartedLine(song, t) {
  const spans = song.spans;
  let lo = 0;
  let hi = spans.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid].start <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found >= 0 ? spans[found].line : -1;
}

function segContent(seg) {
  if (!seg.ruby) return seg.text;
  return h('ruby', null, seg.text, h('rt', null, seg.ruby));
}

// aria-label 與 tooltip 用同一句；data-i18n-label 讓語言切換時能重套
export function labelEl(el, key) {
  const s = t(key);
  el.dataset.i18nLabel = key;
  el.setAttribute('aria-label', s);
  el.dataset.tip = s;
  return el;
}
