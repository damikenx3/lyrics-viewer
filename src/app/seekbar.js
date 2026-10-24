// 進度條：可點、可拖曳；拖曳時軌道變粗、拇指上方出現泡泡（目標時間＋該時間點的歌詞）。
import { h, fmtTime, spokenTime, clamp } from './dom.js';
import { t as tr } from './i18n.js';

export class SeekBar {
  constructor({ root, fill, buffer, thumb, ticks, bubble, bubbleTime, bubbleLyric, onSeek, lyricAt }) {
    this.root = root;
    this.rail = root.querySelector('.seek-rail');
    this.fill = fill;
    this.buffer = buffer;
    this.thumb = thumb;
    this.ticksEl = ticks;
    this.bubble = bubble;
    this.bubbleTime = bubbleTime;
    this.bubbleLyric = bubbleLyric;
    this.onSeek = onSeek;
    this.lyricAt = lyricAt;
    this.duration = 0;
    this.time = 0;
    this.enabled = false;
    this.dragging = false;
    this.target = 0;
    this.width = 0;
    this.lastP = -1;
    this.lastSec = -1;
    this.ticks = [];
    this.lastLyric = null;

    root.addEventListener('pointerdown', (e) => this.down(e));
    root.addEventListener('pointermove', (e) => this.move(e));
    root.addEventListener('pointerup', (e) => this.up(e, true));
    root.addEventListener('pointercancel', (e) => this.up(e, false));
    root.addEventListener('lostpointercapture', () => { if (this.dragging) this.finish(false); });
    // ←→↑↓（±5 秒）由全域鍵盤處理；這裡是聚焦在進度條時才有的鍵
    root.addEventListener('keydown', (e) => {
      if (!this.enabled || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Home') { e.preventDefault(); this.onSeek(0); }
      else if (e.key === 'End') { e.preventDefault(); this.onSeek(Math.max(0, this.duration - 0.5)); }
      else if (e.key === 'PageUp') { e.preventDefault(); this.onSeek(this.time + 30); }
      else if (e.key === 'PageDown') { e.preventDefault(); this.onSeek(Math.max(0, this.time - 30)); }
    });

    const remeasure = () => { this.width = 0; this.lastP = -1; this.render(); };
    if (typeof ResizeObserver === 'function') new ResizeObserver(remeasure).observe(this.rail);
    else window.addEventListener('resize', remeasure);
  }

  setEnabled(on) {
    this.enabled = on;
    this.root.classList.toggle('is-disabled', !on);
    this.root.setAttribute('aria-disabled', on ? 'false' : 'true');
    this.root.tabIndex = on ? 0 : -1;
  }

  setDuration(d) {
    this.duration = d > 0 ? d : 0;
    this.root.setAttribute('aria-valuemax', String(Math.round(this.duration)));
    this.lastP = -1;
    this.layoutTicks();
    this.render();
  }

  setTicks(times) {
    this.ticks = times || [];
    this.layoutTicks();
  }

  layoutTicks() {
    const d = this.duration;
    this.ticksEl.replaceChildren();
    if (!(d > 0)) return;
    for (const t of this.ticks) {
      if (t <= 0.5 || t >= d - 0.5) continue;
      this.ticksEl.append(h('span', { class: 'seek-tick', style: { left: `${(t / d) * 100}%` } }));
    }
  }

  setTime(t) {
    this.time = t;
    if (!this.dragging) this.render();
  }

  setBuffered(ranges, t) {
    const d = this.duration;
    if (!(d > 0) || !ranges.length) {
      this.buffer.style.transform = 'scaleX(0)';
      return;
    }
    // 顯示包含目前時間的那一段
    let r = ranges.find((x) => x.start <= t + 0.5 && x.end >= t) || ranges[ranges.length - 1];
    const a = clamp(r.start / d, 0, 1);
    const b = clamp(r.end / d, 0, 1);
    this.buffer.style.transform = `translateX(${(a * 100).toFixed(3)}%) scaleX(${(b - a).toFixed(4)})`;
  }

  measure() {
    if (!this.width) this.width = this.rail.getBoundingClientRect().width;
    return this.width;
  }

  render() {
    const t = this.dragging ? this.target : this.time;
    const d = this.duration;
    const p = d > 0 ? clamp(t / d, 0, 1) : 0;
    if (Math.abs(p - this.lastP) > 0.0004) {
      this.fill.style.transform = `scaleX(${p.toFixed(5)})`;
      this.thumb.style.transform = `translateX(${(p * this.measure()).toFixed(2)}px)`;
      this.lastP = p;
    }
    const sec = Math.floor(t);
    if (sec !== this.lastSec) {
      this.lastSec = sec;
      this.root.setAttribute('aria-valuenow', String(sec));
      this.root.setAttribute('aria-valuetext', tr('seekValue', { t: spokenTime(t), d: spokenTime(d) }));
    }
  }

  timeAt(clientX) {
    const r = this.rail.getBoundingClientRect();
    this.width = r.width;
    const p = r.width > 0 ? clamp((clientX - r.left) / r.width, 0, 1) : 0;
    return p * this.duration;
  }

  down(e) {
    if (!this.enabled || !(this.duration > 0)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try { this.root.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    this.dragging = true;
    this.pointerId = e.pointerId;
    this.root.classList.add('is-dragging');
    this.target = this.timeAt(e.clientX);
    this.render();
    this.updateBubble();
  }

  move(e) {
    if (!this.dragging || e.pointerId !== this.pointerId) return;
    this.target = this.timeAt(e.clientX);
    this.render();
    this.updateBubble();
  }

  up(e, commit) {
    if (!this.dragging || e.pointerId !== this.pointerId) return;
    if (commit) this.target = this.timeAt(e.clientX);
    this.finish(commit);
  }

  finish(commit) {
    this.dragging = false;
    this.root.classList.remove('is-dragging');
    if (commit) {
      this.time = this.target;
      this.onSeek(this.target);
    }
    this.lastP = -1;
    this.render();
  }

  updateBubble() {
    const t = this.target;
    this.bubbleTime.textContent = fmtTime(t);
    const ly = this.lyricAt ? this.lyricAt(t) : null;
    const key = ly ? ly.text : '';
    if (key !== this.lastLyric) {
      this.bubbleLyric.textContent = key;
      this.bubbleLyric.classList.toggle('is-call', !!(ly && ly.call));
      this.lastLyric = key;
    }
    // 泡泡置中於拇指，但不超出畫面
    const rail = this.rail.getBoundingClientRect();
    const host = this.root.getBoundingClientRect();
    const bw = this.bubble.offsetWidth;
    const p = this.duration > 0 ? t / this.duration : 0;
    const cx = rail.left + p * rail.width;
    const margin = 8;
    const left = clamp(cx - bw / 2, margin, window.innerWidth - bw - margin);
    this.bubble.style.transform = `translateX(${(left - host.left).toFixed(1)}px)`;
  }
}
