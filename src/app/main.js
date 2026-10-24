// 進入點：把歌曲庫、傳輸層、歌詞畫面、進度條、面板、保存層與 Android 整合接起來。
import { h, fmtTime, clamp } from './dom.js';
import { stanzaStarts, queryTimeline } from './core.js';
import { Library, UNSORTED } from './library.js';
import { Player } from './transport.js';
import { LyricsView, lastStartedLine } from './lyrics.js';
import { Follower } from './follow.js';
import { SeekBar } from './seekbar.js';
import { LibrarySheet } from './sheet.js';
import { coverNode, artworkFor } from './cover.js';
import { initToasts, notify, boldName } from './toast.js';
import { importFiles, attachAudio, restore, rematchOrphans, emptySummary, removeAudio, removeImportedLyrics } from './importer.js';
import { loadSettings, saveSettings, settingsAreDurable, requestPersistence } from './store.js';
import { setupMediaSession, setMediaTrackHandlers, setMediaMetadata, setMediaPlaying, setMediaPosition, ScreenWake } from './media.js';
import { icon } from './icons.js';
import { t, setLang, detectLang, applyStatic, onLangChange, LANGS } from './i18n.js';
import { initTooltips, hide as hideTip } from './tooltip.js';
import { BackGuard } from './backguard.js';
import { TabSync } from './tabsync.js';
import { isImporting, setImportProgress } from './busy.js';

const byId = (id) => document.getElementById(id);
const root = document.documentElement;
const els = {
  hall: byId('hall'),
  scroller: byId('scroller'),
  column: byId('column'),
  fadeTop: byId('fade-top'),
  topband: byId('topband'),
  coverBtn: byId('cover-btn'),
  coverThumb: byId('cover-thumb'),
  miniTitle: byId('mini-title'),
  recenter: byId('recenter'),
  toasts: byId('toasts'),
  dock: byId('dock'),
  timeNow: byId('time-now-val'),
  timeEnd: byId('time-end'),
  play: byId('btn-play'),
  prev: byId('btn-prev'),
  next: byId('btn-next'),
  lib: byId('btn-lib'),
  call: byId('btn-call'),
  sheet: byId('sheet'),
  add: byId('btn-add'),
  edit: byId('sheet-edit'),
  sizeDown: byId('size-down'),
  sizeUp: byId('size-up'),
  sizeVal: byId('size-val'),
  wake: byId('wake-switch'),
  fileInput: byId('file-input'),
  audioInput: byId('audio-input'),
  audio: byId('audio'),
  langGroup: byId('lang-group'),
};

// 靜態 HTML 裡的 <i data-icon> 換成 SVG 圖示
for (const el of document.querySelectorAll('i[data-icon]')) el.replaceWith(icon(el.dataset.icon, el.dataset.cls));

const SCALES = [0.85, 0.92, 1, 1.08, 1.16, 1.24, 1.3];
const FOLLOW_LEAD = 0.25;
// 離開這麼久（ms）才回到前景時，追蹤直接定位，不慢慢捲過去
const AWAY_SNAP = 2000;
const UNDO_FOR = 5000;

const settings = loadSettings();
setLang(LANGS.some((l) => l.code === settings.lang) ? settings.lang : detectLang());
applyStatic();
const library = new Library();
const player = new Player(els.audio);
const wake = new ScreenWake(() => hideWake());

let current = null;
let status = { hasAudio: false, error: null };
let selectToken = 0;
let raf = 0;
let lastFollow = -2;
let lastSec = -1;
let storageNoticeShown = false;
// 換來源（連結音訊、重新匯入）時，載入期間畫面停在這個時間，不先跳回開頭
let holdAt = null;

// ───────────── 元件 ─────────────

const view = new LyricsView({
  column: els.column,
  scroller: els.scroller,
  onLineClick: (i) => jumpToLine(i),
  onAction: (action) => {
    if (action === 'link-audio') openAudioPicker();
    else if (action === 'add-files') openFilePicker();
  },
  onLayout: () => scheduleRealign(),
  // 上方淡出區；小標題出現時還多一條不透明帶，取較高的
  topClear: () => Math.max(els.fadeTop.offsetHeight, root.classList.contains('is-head-out') ? els.topband.offsetHeight : 0),
});

// 版面變動後若仍在追蹤，把目前行放回 38% 的位置（補間進行中就交給補間）
let realignQueued = false;
function scheduleRealign() {
  if (realignQueued) return;
  realignQueued = true;
  requestAnimationFrame(() => {
    realignQueued = false;
    if (current && current.timed && follower.following && !follower.raf) goToCurrent({ instant: true });
  });
}

const follower = new Follower(els.scroller, () => updateRecenter());

const seek = new SeekBar({
  root: byId('seekbar'),
  fill: byId('seek-fill'),
  buffer: byId('seek-buffer'),
  thumb: byId('seek-thumb'),
  ticks: byId('seek-ticks'),
  bubble: byId('seek-bubble'),
  bubbleTime: byId('bubble-time'),
  bubbleLyric: byId('bubble-lyric'),
  onSeek: (t) => seekTo(t),
  lyricAt: (t) => view.lyricAt(t),
});

const sheet = new LibrarySheet({
  dialog: els.sheet,
  list: byId('sheet-list'),
  jump: byId('album-jump'),
  grab: byId('sheet-grab'),
  closeBtn: byId('sheet-close'),
  editBtn: els.edit,
  history: { pushSheet: () => guard.pushSheet(), popSheet: () => guard.popSheet() },
  // 面板關閉後，提示與 tooltip 回到頁面上
  onClosed: () => {
    if (els.toasts.parentNode !== document.body) document.body.append(els.toasts);
    measureToastDock();
    hideTip();
  },
  onPick: (id) => {
    sheet.close();
    if (current && id === current.id) {
      if (player.paused && player.canPlay) player.play();
      return;
    }
    selectSong(id, { autoplay: true });
  },
  onAdd: () => openFilePicker(),
  onRemoveAudio: (id) => removeWithUndo(id, 'audio'),
  onRemoveLyrics: (id) => removeWithUndo(id, 'lyrics'),
});

// 返回鍵：面板開著時關面板；沒開時提示「再按一次離開」
const guard = new BackGuard({
  isSheetOpen: () => sheet.isOpen,
  closeSheet: () => sheet.close({ fromHistory: true }),
  warn: () => notify([t('backAgain')], { icon: 'leave', duration: 2000 }),
});

// 另一個分頁開始播放：這裡暫停
const tabs = new TabSync(() => {
  if (!player.paused) player.pause();
});

const overlayHost = () => (sheet.isOpen ? els.sheet : document.body);
initToasts(els.toasts, overlayHost);
initTooltips(overlayHost);

// 提示貼在控制列（面板開著時是面板底部設定列）上方；兩者高度隨橫直向與換行改變，量好交給 CSS。
// 頁面上有提示時，「回到目前位置」鈕往上讓出提示的高度。
const sheetFoot = els.sheet.querySelector('.sheet-foot');
function measureToastDock() {
  root.style.setProperty('--dock-h', `${els.dock.offsetHeight}px`);
  if (sheetFoot.offsetHeight) root.style.setProperty('--foot-h', `${sheetFoot.offsetHeight}px`);
  const lift = els.toasts.parentNode === document.body ? els.toasts.offsetHeight : 0;
  root.style.setProperty('--toast-lift', `${lift ? lift + 8 : 0}px`);
}
if (typeof ResizeObserver === 'function') {
  const ro = new ResizeObserver(measureToastDock);
  for (const el of [els.dock, sheetFoot, els.toasts]) ro.observe(el);
}

const headObserver = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((entries) => {
    for (const e of entries) root.classList.toggle('is-head-out', !e.isIntersecting);
  }, { root: els.scroller, rootMargin: '-56px 0px 0px 0px' })
  : null;

// ───────────── 播放迴圈（只在播放中運作） ─────────────

function kick() {
  if (!raf) raf = requestAnimationFrame(frame);
}

// 畫面上的「現在」：換來源載入中時停在原本的時間（此時 player.currentTime 還是 0）
function nowTime() {
  return holdAt != null ? holdAt : player.currentTime;
}

function frame() {
  raf = 0;
  player.tick();
  renderTime(nowTime());
  if (!player.paused && document.visibilityState === 'visible') raf = requestAnimationFrame(frame);
}

function renderTime(t) {
  view.update(t);
  seek.setTime(t);
  const sec = Math.floor(t);
  if (sec !== lastSec) {
    lastSec = sec;
    els.timeNow.textContent = fmtTime(t);
  }
  followCheck(t);
}

// 同時亮著的行裡最早的一行（給 scrollTopFor 避開上方淡出區）
function firstActive(q) {
  let first = -1;
  for (const a of q.active) if (first < 0 || a.line < first) first = a.line;
  return first;
}

function followCheck(t) {
  if (!current || !current.timed) return;
  const q = queryTimeline(current, t + FOLLOW_LEAD);
  const target = q.latest;
  if (target === lastFollow) return;
  lastFollow = target;
  // 沒有亮行時維持目前位置
  if (target >= 0 && follower.following) follower.scrollTo(view.scrollTopFor(target, 0.38, firstActive(q)));
  if (!follower.following) updateRecenter();
}

// 「目前位置」：最新亮行；間奏中就是最後唱到的行；開頭之前是頂端
function anchorLine(t) {
  if (!current || !current.timed) return -1;
  const q = queryTimeline(current, t + FOLLOW_LEAD);
  return q.latest >= 0 ? q.latest : lastStartedLine(current, t + FOLLOW_LEAD);
}

// 時間 t 的追蹤位置（scrollTop）
function followTop(t) {
  if (!current || !current.timed) return 0;
  const q = queryTimeline(current, t + FOLLOW_LEAD);
  const i = q.latest >= 0 ? q.latest : lastStartedLine(current, t + FOLLOW_LEAD);
  return i >= 0 ? view.scrollTopFor(i, 0.38, q.latest >= 0 ? firstActive(q) : -1) : 0;
}

function goToCurrent({ instant = false, at = null } = {}) {
  if (!current) return;
  const t = at != null ? at : nowTime();
  lastFollow = current.timed ? queryTimeline(current, t + FOLLOW_LEAD).latest : -1;
  follower.scrollTo(followTop(t), { instant });
}

function resumeFollow(opts) {
  follower.resume();
  goToCurrent(opts);
}

function updateRecenter() {
  const show = !!(current && current.timed && !follower.following);
  els.recenter.hidden = !show;
  if (!show) return;
  const i = anchorLine(nowTime());
  const y = i >= 0 ? view.lineViewportY(i) : -1;
  const up = y == null || y < els.scroller.clientHeight * 0.38;
  els.recenter.classList.toggle('is-up', up);
}

let scrollQueued = false;
els.scroller.addEventListener('scroll', () => {
  if (follower.following || scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    updateRecenter();
  });
}, { passive: true });

els.recenter.addEventListener('click', () => resumeFollow());

// ───────────── 時間操作 ─────────────

function seekTo(t) {
  if (!player.canPlay) return;
  player.seek(clamp(t, 0, Math.max(0, player.duration - 0.05)));
  follower.resume();
  renderTime(player.currentTime);
  goToCurrent();
  setMediaPosition(player.duration, player.currentTime);
  kick();
}

function skip(delta) {
  seekTo(player.currentTime + delta);
}

function jumpToLine(i) {
  if (!current || !player.canPlay) return;
  const times = current.lines[i] && current.lines[i].times;
  if (!times || !times.length) return;
  // 重複的行：取最接近目前時間的那次
  const now = player.currentTime;
  let best = times[0];
  for (const t of times) if (Math.abs(t - now) < Math.abs(best - now)) best = t;
  seekTo(best);
}

function stepLine(dir) {
  if (!current || !current.timed || !player.canPlay) return;
  const spans = current.spans;
  const t = player.currentTime + 0.05;
  let idx = -1;
  for (let k = 0; k < spans.length; k++) {
    if (spans[k].start <= t) idx = k;
    else break;
  }
  // 同一個開始時間的多行（例如 call 與主歌詞同時）視為一行
  let to;
  if (dir > 0) {
    let k = idx + 1;
    if (idx >= 0) while (k < spans.length && spans[k].start <= spans[idx].start + 0.001) k++;
    to = spans[Math.min(spans.length - 1, Math.max(0, k))];
  } else if (idx < 0) {
    to = spans[0];
  } else {
    let k = idx;
    while (k > 0 && spans[k - 1].start >= spans[idx].start - 0.001) k--;
    to = spans[Math.max(0, k - 1)];
  }
  if (to) seekTo(to.start);
}

function togglePlay() {
  if (!player.canPlay) return;
  player.toggle();
}

// ───────────── 換歌 ─────────────

function neighbor(dir) {
  if (!current) return null;
  return library.neighbor(current.id, dir);
}

// 換歌進行中（淡出動畫、載入中）時記住目標，連按「下一首」才會一路往下
let pending = null;

// App 內的上一首／下一首：走全部歌曲
function changeSong(dir) {
  const baseId = pending ? pending.id : current && current.id;
  if (!baseId) return;
  const s = library.neighbor(baseId, dir);
  if (s) selectSong(s.id, { autoplay: pending ? pending.autoplay : !player.paused });
}

// 媒體鍵（通知列、鎖定畫面、藍牙）：只在有音訊的歌之間移動。
// 換到沒有音訊的歌時 Android 會收掉媒體控制，之後就按不回來了。
function changeAudioSong(dir) {
  const baseId = pending ? pending.id : current && current.id;
  if (!baseId) return;
  const s = library.neighborWithAudio(baseId, dir);
  if (s) selectSong(s.id, { autoplay: pending ? pending.autoplay : !player.paused });
}

// 前後沒有可去的歌時把 handler 設成 null，通知列就不顯示那個按鈕
function updateTrackHandlers() {
  const id = pending ? pending.id : current && current.id;
  const can = (dir) => !!(id && library.neighborWithAudio(id, dir));
  setMediaTrackHandlers({
    prev: can(-1) ? () => changeAudioSong(-1) : null,
    next: can(1) ? () => changeAudioSong(1) : null,
  });
}

// 歌曲內容的簽章：重新解析後內容相同就不必重載
function songSignature(song) {
  if (!song) return '';
  const lines = song.lines.map((l) => l.segments.map((g) => `${g.call ? '(' : ''}${g.text}${g.ruby ? `《${g.ruby}》` : ''}@${g.at ?? ''}`).join('')).join('\n');
  const spans = song.spans.map((sp) => `${sp.line}:${sp.start}-${sp.end}`).join(',');
  return `${song.title}|${song.album}|${song.track}|${(song.credits || []).join('/')}|${lines}|${spans}`;
}

function sourceKey(src) {
  if (!src) return 'none';
  return src.kind === 'blob' ? `blob:${src.name}:${src.blob.size}` : `url:${src.url}`;
}

let currentSourceKey = 'none';

async function selectSong(id, { autoplay = false, animate = true, reveal = true, startAt = 0 } = {}) {
  const song = library.byId.get(id);
  if (!song) return;
  const token = ++selectToken;
  pending = { id, autoplay };
  updateTrackHandlers();
  player.pause();
  // 背景中（螢幕關閉時用媒體鍵換歌）不跑動畫：隱藏的頁面不推進動畫，會卡住
  if (animate && current && document.visibilityState === 'visible') await view.animateOut();
  if (token !== selectToken) return;

  current = song;
  status = { hasAudio: library.hasAudio(id), error: null };
  view.render(song, { album: library.albumOf(song), status });
  follower.quiet(600);
  follower.resume();
  lastFollow = -2;
  lastSec = -1;
  if (headObserver) {
    headObserver.disconnect();
    if (view.titleEl) headObserver.observe(view.titleEl);
  }
  root.classList.remove('is-head-out');
  // 播放中換來源：載入前就停在原本的時間與位置，不先跳回開頭再跳回來
  holdAt = startAt > 0 ? startAt : null;
  if (holdAt != null && song.timed) {
    follower.jump(followTop(holdAt));
    lastFollow = queryTimeline(song, holdAt + FOLLOW_LEAD).latest;
  } else {
    follower.jump(0);
  }
  renderTime(holdAt != null ? holdAt : 0);
  updateChrome();
  if (reveal && document.visibilityState === 'visible') view.animateIn();
  else els.column.classList.remove('is-swapping');
  seek.setTicks(song.timed ? stanzaStarts(song) : []);
  settings.lastSong = id;
  persistSettings();

  const source = library.audioSourceFor(id);
  currentSourceKey = sourceKey(source);
  const res = await player.load(song, source);
  if (res.stale || token !== selectToken) return;
  pending = null;
  if (!res.ok) {
    if (source && source.kind === 'url') {
      // 內嵌路徑提示失效：安靜退回「沒有音訊」
      library.hintFailed.add(id);
      status.hasAudio = false;
      sheet.render(library, id);
    } else {
      status.error = res.error;
    }
    view.setStatus(status);
  }
  if (startAt > 0 && player.canPlay) player.seek(startAt);
  holdAt = null;
  renderTime(player.currentTime);
  if (startAt > 0) goToCurrent({ instant: true });
  updateRecenter();
  updateTrackHandlers();
  updateMedia();
  if (autoplay && player.canPlay) player.play();
}

function updateChrome() {
  const song = current;
  const album = library.albumOf(song);
  els.coverThumb.classList.remove('cover-thumb--blank');
  els.coverThumb.replaceChildren(coverNode(album, { mono: true }));
  els.miniTitle.textContent = song ? song.title : '';
  document.title = song ? song.title : 'lyrics-viewer';
  sheet.markCurrent(song ? song.id : null);
  els.prev.disabled = !neighbor(-1);
  els.next.disabled = !neighbor(1);
  updateTrackHandlers();
}

async function updateMedia() {
  const song = current;
  if (!song) return;
  const album = library.albumOf(song);
  const base = {
    title: song.title,
    artist: song.artist || (album && album.artist) || '',
    album: song.album && song.album !== UNSORTED ? song.album : t('unsorted'),
  };
  setMediaMetadata(base);
  const artwork = await artworkFor(album);
  if (song === current && artwork.length) setMediaMetadata({ ...base, artwork });
}

// ───────────── 傳輸事件 ─────────────

function updatePlayLabel() {
  const key = player.paused ? 'play' : 'pause';
  els.play.dataset.i18nLabel = key;
  els.play.setAttribute('aria-label', t(key));
  els.play.dataset.tip = t(key);
}

let wasPlaying = false;
player.addEventListener('state', () => {
  const playing = !player.paused;
  root.classList.toggle('is-playing', playing);
  updatePlayLabel();
  setMediaPlaying(playing);
  setMediaPosition(player.duration, player.currentTime);
  wake.setPlaying(playing);
  // 開始播放的那一刻通知其他分頁暫停
  if (playing && !wasPlaying) tabs.announcePlay();
  wasPlaying = playing;
  kick();
});
player.addEventListener('seek', () => kick());
player.addEventListener('ended', () => {
  renderTime(player.currentTime);
  setMediaPosition(player.duration, player.currentTime);
});
player.addEventListener('duration', () => {
  const d = player.duration;
  seek.setDuration(d);
  els.timeEnd.textContent = fmtTime(d);
  setMediaPosition(d, player.currentTime);
  seek.setBuffered(player.buffered(), player.currentTime);
});
// 換來源時也會收到一次（buffered() 為空），緩衝條就會歸零，不沿用上一首
player.addEventListener('buffer', () => seek.setBuffered(player.buffered(), player.currentTime));
player.addEventListener('kind', () => {
  root.dataset.player = player.kind;
  els.play.disabled = !player.canPlay;
  seek.setEnabled(player.canPlay);
});
player.addEventListener('error', (e) => {
  if (!current) return;
  if (e.detail && e.detail.silent) {
    // 內嵌路徑提示晚一步才失敗：安靜退回「沒有音訊」
    library.hintFailed.add(current.id);
    status.hasAudio = false;
    sheet.render(library, current.id);
    updateTrackHandlers();
  } else {
    status.error = e.detail;
  }
  view.setStatus(status);
});
player.addEventListener('blocked', () => {
  notify(t('blocked'));
});

let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now();
    // 頁面可能就此被關掉：等待中的刪除現在就執行
    flushRemovals();
    return;
  }
  const away = hiddenAt ? Date.now() - hiddenAt : 0;
  hiddenAt = 0;
  // 離開一陣子再回來，目前行可能已經差很遠：直接定位，不慢慢捲過去
  if (away > AWAY_SNAP && current && current.timed && follower.following) goToCurrent({ instant: true });
  kick();
});
window.addEventListener('pagehide', () => flushRemovals());

// ───────────── 控制列 ─────────────

els.play.addEventListener('click', () => togglePlay());
els.prev.addEventListener('click', () => changeSong(-1));
els.next.addEventListener('click', () => changeSong(1));
// detail===0 代表由鍵盤（Enter／Space）觸發的 click
els.lib.addEventListener('click', (e) => sheet.open({ viaKeyboard: e.detail === 0 }));
els.coverBtn.addEventListener('click', (e) => sheet.open({ viaKeyboard: e.detail === 0 }));
els.call.addEventListener('click', () => toggleCalls());

function toggleCalls() {
  settings.calls = !settings.calls;
  applyCalls();
  persistSettings();
}

function applyCalls() {
  root.classList.toggle('calls-on', !!settings.calls);
  els.call.setAttribute('aria-pressed', settings.calls ? 'true' : 'false');
}

function applyScale(keepPlace) {
  let i = SCALES.indexOf(settings.scale);
  if (i < 0) {
    i = SCALES.reduce((best, s, k) => (Math.abs(s - settings.scale) < Math.abs(SCALES[best] - settings.scale) ? k : best), 2);
    settings.scale = SCALES[i];
  }
  root.style.setProperty('--lyric-scale', String(settings.scale));
  els.sizeVal.textContent = `${Math.round(settings.scale * 100)}%`;
  els.sizeDown.disabled = i === 0;
  els.sizeUp.disabled = i === SCALES.length - 1;
  view.tops = null;
  follower.quiet(600);
  if (keepPlace && current && follower.following) goToCurrent({ instant: true });
}

function stepScale(dir) {
  const i = SCALES.indexOf(settings.scale);
  const j = clamp(i + dir, 0, SCALES.length - 1);
  if (j === i) return;
  settings.scale = SCALES[j];
  applyScale(true);
  persistSettings();
}

els.sizeDown.addEventListener('click', () => stepScale(-1));
els.sizeUp.addEventListener('click', () => stepScale(1));

function applyWake() {
  els.wake.setAttribute('aria-checked', settings.wakeLock && !wake.unavailable ? 'true' : 'false');
  wake.setEnabled(!!settings.wakeLock);
}

// 瀏覽器不允許保持螢幕常亮（例如從檔案管理員開啟、區網 http）：開關永遠用不了，整個隱藏
function hideWake() {
  els.wake.hidden = true;
  els.wake.setAttribute('aria-checked', 'false');
}

// ───────────── 語言 ─────────────

function updateLangButtons() {
  for (const b of els.langGroup.querySelectorAll('.lang-btn')) {
    b.setAttribute('aria-pressed', b.dataset.lang === settings.lang || (!settings.lang && b.dataset.lang === currentLangCode()) ? 'true' : 'false');
  }
}

function currentLangCode() {
  const tag = document.documentElement.lang;
  return tag.startsWith('ja') ? 'ja' : tag.startsWith('zh') ? 'zh' : 'en';
}

els.langGroup.addEventListener('click', (e) => {
  const b = e.target.closest('.lang-btn');
  if (!b) return;
  settings.lang = b.dataset.lang;
  persistSettings();
  setLang(settings.lang);
});

onLangChange(() => {
  hideTip();
  applyStatic();
  updatePlayLabel();
  view.relabel(status);
  sheet.render(library, current && current.id);
  setImportProgress(busy.done, busy.total);
  seek.lastSec = -1;
  seek.render();
  updateLangButtons();
  // 「未分類」與生成封面上的字依語言而定
  updateMedia();
});
els.wake.addEventListener('click', () => {
  settings.wakeLock = !settings.wakeLock;
  applyWake();
  persistSettings();
});

function persistSettings() {
  if (!saveSettings(settings)) storageNotice();
}

function storageNotice() {
  if (storageNoticeShown) return;
  storageNoticeShown = true;
  notify(t('storageVolatile'), { duration: 6000 });
}

// ───────────── 匯入 ─────────────

// 匯入中不再打開選檔（避免同一批被選兩次）；已經選好的檔案照樣排進佇列
function openFilePicker() {
  if (isImporting()) return;
  els.fileInput.value = '';
  els.fileInput.click();
}
function openAudioPicker() {
  if (isImporting()) return;
  els.audioInput.value = '';
  els.audioInput.click();
}
els.add.addEventListener('click', () => openFilePicker());

// 匯入依序排隊執行，忙碌時選的檔案不會被丟掉；所有「加入檔案」按鈕顯示「已處理/總數」
let importChain = Promise.resolve();
let queued = 0;
const busy = { done: 0, total: 0 };
function enqueue(count, task) {
  queued++;
  busy.total += count;
  setImportProgress(busy.done, busy.total);
  const run = async () => {
    const base = busy.done;
    try {
      await task((done) => {
        busy.done = base + done;
        setImportProgress(busy.done, busy.total);
      });
    } catch (err) {
      console.error('[lyrics-viewer]', err);
    } finally {
      busy.done = base + count;
      queued--;
      if (!queued) {
        busy.done = 0;
        busy.total = 0;
      }
      setImportProgress(busy.done, busy.total);
    }
  };
  importChain = importChain.then(run);
  return importChain;
}

els.fileInput.addEventListener('change', () => {
  const files = [...(els.fileInput.files || [])];
  els.fileInput.value = '';
  if (!files.length) return;
  enqueue(files.length, async (progress) => {
    const summary = await importFiles(files, { library, audioEl: els.audio }, progress);
    afterLibraryChange({ moved: summary.moved });
    reportImport(summary);
  });
});

els.audioInput.addEventListener('change', () => {
  const file = els.audioInput.files && els.audioInput.files[0];
  els.audioInput.value = '';
  if (!file || !current) return;
  const target = current;
  enqueue(1, async () => {
    const summary = emptySummary();
    const id = await attachAudio(file, target, { library, audioEl: els.audio }, summary);
    library.rebuild();
    sheet.render(library, current && current.id);
    if (id && current && current.id === target.id) {
      // 保留目前位置與播放狀態，換成真正的音訊
      const startAt = player.currentTime;
      const wasOn = !player.paused;
      await selectSong(target.id, { animate: false, reveal: false, startAt, autoplay: wasOn });
      if (!status.error) notify([boldName(file.name), h('span', { class: 'sr-only' }, t('linked', { name: file.name }))], { icon: 'check' });
    }
    reportImport({ ...summary, audio: [] });
  });
});

// 歌曲庫變了之後同步畫面。preferId：目前的歌被移除時改選這首；keepPlaying=false 時重載後不自動播放；
// moved：只有音訊的歌配上了匯入的歌詞、id 換了（舊 id → 新 id），目前的歌跟著換過去並接著播
function afterLibraryChange({ preferId = null, keepPlaying = true, moved = null } = {}) {
  // 換歌進行中就以目標歌曲為準，不打斷使用者的切換
  const activeId = pending ? pending.id : current && current.id;
  const movedTo = activeId && moved && moved.get(activeId);
  if (movedTo && library.byId.has(movedTo)) {
    if (settings.lastSong === activeId) settings.lastSong = movedTo;
    sheet.render(library, movedTo);
    if (pending) selectSong(movedTo, { autoplay: pending.autoplay });
    else selectSong(movedTo, { animate: false, reveal: false, startAt: player.currentTime, autoplay: keepPlaying && !player.paused });
    return;
  }
  sheet.render(library, activeId);
  if (!library.songs.length) {
    if (current) {
      selectToken++;
      pending = null;
      player.load(null, null);
      showEmpty();
    }
    return;
  }
  if (!activeId || !library.byId.has(activeId)) {
    const next = preferId && library.byId.has(preferId) ? preferId : library.songs[0].id;
    selectSong(next, { animate: !!current });
    return;
  }
  if (pending) return;
  const fresh = library.byId.get(current.id);
  const contentChanged = songSignature(fresh) !== songSignature(current);
  const sourceChanged = sourceKey(library.audioSourceFor(current.id)) !== currentSourceKey;
  if (contentChanged || sourceChanged) {
    selectSong(current.id, { animate: false, reveal: false, startAt: player.currentTime, autoplay: keepPlaying && !player.paused });
  } else {
    // 內容相同：只換成新的物件參照，播放不中斷
    current = fresh;
    view.song = fresh;
    updateChrome();
  }
}

// 匯入結果：每類一行「圖示＋歌名（最多兩首）＋ +n」；歌名是內容，不算介面文字
function titleLine(name, titles) {
  const uniq = [...new Set(titles.filter(Boolean))];
  const shown = uniq.slice(0, 2);
  const more = uniq.length - shown.length;
  return h('span', { class: 'tally' },
    icon(name),
    h('span', { class: 'tally-titles', lang: 'ja' }, shown.map((x) => h('b', null, `「${x}」`))),
    more > 0 ? h('span', { class: 'tally-more' }, `+${more}`) : null);
}

function reportImport(s) {
  const warnings = [];
  for (const u of s.unsupported) warnings.push(t('importFailed', { name: u.name, why: t('errFormat', { fmt: u.fmt }) }));
  for (const f of s.failed) warnings.push(t('importFailed', { name: f.name, why: t(f.why, { msg: f.msg }) }));
  for (const d of s.duplicates || []) warnings.push(t('importSkippedDup', { name: d.name, kept: d.kept }));
  if (s.skipped.length) warnings.push(t('importSkipped', { n: s.skipped.length }));

  const lines = [];
  if (s.lyricFiles) lines.push(titleLine('lyricFile', s.lyricTitles || []));
  // 配對到既有歌曲的排前面，新建的「只有音訊」歌排後面
  if (s.audio.length) lines.push(titleLine('audioFile', [...s.audio].sort((a, b) => a.created - b.created).map((a) => a.title)));
  if (warnings.length) {
    lines.push(h('span', { class: 'tally tally--warn', 'aria-hidden': 'true' }, icon('warning'), h('span', { class: 'tally-num' }, String(warnings.length))));
  }
  if (lines.length) {
    const spoken = t('importSummary', { lyrics: s.lyricFiles, audio: s.audio.length });
    notify(h('span', { class: 'tally-list' }, h('span', { class: 'sr-only' }, spoken), lines), { duration: 5200 });
  }
  // 原因只能用文字說明
  for (const w of warnings) notify(w, { duration: 8000, icon: 'warning' });
  if (s.quota) notify(t('storageQuota'), { duration: 8000 });
  else if (s.volatile) storageNotice();
}

// ───────────── 編輯模式：移除與復原 ─────────────

// 等待中的刪除：提示消失（或頁面被藏起來）時才真的寫入 IndexedDB
const pendingRemovals = new Set();

function flushRemovals() {
  for (const p of [...pendingRemovals]) p.dismiss();
}

function removeWithUndo(id, kind) {
  const song = library.byId.get(id);
  if (!song) return;
  const title = song.title;
  // 目前的歌整首消失時，改選它的下一首（沒有就上一首）
  const after = library.neighbor(id, 1) || library.neighbor(id, -1);
  const op = kind === 'audio' ? removeAudio(library, id) : removeImportedLyrics(library, id);
  if (!op) return;
  afterLibraryChange({ preferId: after && after.id, keepPlaying: false });

  const entry = { dismiss: () => {} };
  pendingRemovals.add(entry);
  entry.dismiss = notify(
    [h('b', { lang: 'ja' }, `「${title}」`), h('span', { class: 'sr-only' }, t(kind === 'audio' ? 'removedAudio' : 'removedLyrics', { title }))],
    {
      icon: kind === 'audio' ? 'unlinkAudio' : 'removeLyrics',
      duration: UNDO_FOR,
      action: {
        icon: 'undo',
        label: t('undo'),
        onClick: () => {
          if (op.undo()) afterLibraryChange({ keepPlaying: false });
        },
      },
      onClose: (reason) => {
        pendingRemovals.delete(entry);
        if (reason !== 'action') op.commit().catch((err) => console.error('[lyrics-viewer]', err));
      },
    },
  );
}

// ───────────── 鍵盤 ─────────────

const SCROLL_KEYS = { ArrowUp: -1, ArrowDown: 1, PageUp: -2, PageDown: 2, Home: -3, End: 3 };

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.isComposing) return;
  const target = e.target;
  if (target && target.closest && target.closest('input, textarea, select, [contenteditable="true"]')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const key = e.key;

  if (sheet.isOpen) {
    if (key === 'l' || key === 'L') {
      e.preventDefault();
      sheet.close();
    }
    return; // Esc 由 dialog 的 cancel 處理
  }

  const onOtherButton = target && target.closest && target.closest('button') && target.closest('button').id !== 'btn-play';
  switch (key) {
    case ' ':
    case 'Spacebar':
      if (onOtherButton) return; // 讓聚焦中的按鈕自己處理
      e.preventDefault();
      togglePlay();
      return;
    case 'ArrowLeft':
    case 'ArrowRight': {
      e.preventDefault();
      const dir = key === 'ArrowLeft' ? -1 : 1;
      if (e.shiftKey) stepLine(dir);
      else skip(dir * 5);
      return;
    }
    case 'n':
    case 'N':
      e.preventDefault();
      changeSong(1);
      return;
    case 'p':
    case 'P':
      e.preventDefault();
      changeSong(-1);
      return;
    case 'c':
    case 'C':
      e.preventDefault();
      toggleCalls();
      return;
    case 'l':
    case 'L':
      e.preventDefault();
      sheet.open({ viaKeyboard: true });
      return;
    default:
      break;
  }

  if (target && target.id === 'seekbar' && (key === 'ArrowUp' || key === 'ArrowDown')) {
    e.preventDefault();
    skip(key === 'ArrowUp' ? 5 : -5);
    return;
  }
  if (key in SCROLL_KEYS && current) {
    e.preventDefault();
    const sc = els.scroller;
    const step = SCROLL_KEYS[key];
    follower.release();
    if (Math.abs(step) === 3) sc.scrollTop = step < 0 ? 0 : sc.scrollHeight;
    else sc.scrollBy({ top: step * (Math.abs(step) === 2 ? sc.clientHeight * 0.8 : 64), behavior: 'auto' });
  }
});

// ───────────── Media Session ─────────────

// 上一首／下一首由 updateTrackHandlers 依目前位置設定
setupMediaSession({
  play: () => { if (player.canPlay) player.play(); },
  pause: () => player.pause(),
  seek: (t) => seekTo(t),
  skip: (d) => skip(d),
});

// ───────────── 啟動 ─────────────

function readEmbedded() {
  let data = null;
  try {
    const el = byId('lv-library');
    data = JSON.parse((el && el.textContent) || '{}');
  } catch {
    notify(t('embeddedBroken'), { duration: 8000 });
  }
  // 與匯入的 addedAt 比新舊：同一首歌以較新的版本為準
  const built = data && data.builtAt ? Date.parse(data.builtAt) : NaN;
  library.builtAt = Number.isFinite(built) ? built : 0;
  const files = (data && Array.isArray(data.files) && data.files) || [];
  files.forEach((f, i) => {
    if (!f || typeof f.text !== 'string') return;
    library.setSource({ key: `embedded:${f.path || i}`, path: f.path || `file-${i}.md`, text: f.text, cover: f.cover || null, origin: 'embedded' });
  });
  // 從檔案管理員開啟（content://）時 <audio> 讀不到相對路徑，提示一定失效，直接略過
  const audio = (data && data.audio && location.protocol !== 'content:') ? data.audio : {};
  for (const id of Object.keys(audio)) {
    if (typeof audio[id] === 'string' && audio[id]) library.hints.set(id, audio[id]);
  }
}

function showEmpty() {
  current = null;
  holdAt = null;
  view.renderEmpty(() => openFilePicker());
  root.dataset.player = 'none';
  root.classList.remove('is-head-out');
  els.play.disabled = true;
  els.prev.disabled = true;
  els.next.disabled = true;
  seek.setEnabled(false);
  seek.setDuration(0);
  seek.setTicks([]);
  seek.setBuffered([], 0);
  els.timeNow.textContent = fmtTime(0);
  els.timeEnd.textContent = fmtTime(0);
  els.coverThumb.replaceChildren(icon('library'));
  els.coverThumb.classList.add('cover-thumb--blank');
  els.miniTitle.textContent = '';
  document.title = 'lyrics-viewer';
  updateRecenter();
  updateTrackHandlers();
}

async function start() {
  updateLangButtons();
  updatePlayLabel();
  applyCalls();
  applyScale(false);
  applyWake();
  root.dataset.player = 'none';
  seek.setEnabled(false);
  readEmbedded();
  const restored = await restore(library);
  library.rebuild();
  // 歌名或專輯改過、id 對不到的音訊：重新配對，配不上就以「只有音訊」的歌顯示
  if (restored) {
    const moved = await rematchOrphans(library, emptySummary());
    if (moved.has(settings.lastSong)) settings.lastSong = moved.get(settings.lastSong);
  }
  for (const w of library.warnings) console.warn('[lyrics-viewer]', w);
  sheet.render(library, null);
  if (!restored || !settingsAreDurable()) storageNotice();
  else requestPersistence();
  if (!library.songs.length) {
    showEmpty();
    return;
  }
  const id = settings.lastSong && library.byId.has(settings.lastSong) ? settings.lastSong : library.songs[0].id;
  await selectSong(id, { animate: false });
}

start();
