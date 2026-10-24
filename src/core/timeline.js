// 時間軸：由各行的開始／結束時間算出 Span（含隱含結束時間），以及播放時的查詢。
import { TIME_EPSILON, roundTime } from './time.js';

// 最後一行之後沒有任何時間點時，預設亮 5 秒（規格第 1 節）。
export const DEFAULT_LAST_DURATION = 5;

function sortedUnique(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const out = [];
  for (const v of sorted) if (!out.length || v - out[out.length - 1] > TIME_EPSILON) out.push(v);
  return out;
}

// 嚴格大於 t 的最小時間點；沒有就回傳 null。
function nextPoint(points, t) {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid] > t + TIME_EPSILON) hi = mid;
    else lo = mid + 1;
  }
  return lo < points.length ? points[lo] : null;
}

// 隱含結束時間的「時間點」只包含各 span 的開始與結束標記行。
// 刻意不把其他行明確寫出的結束時間算進來：[a-b] 的 b 只屬於那一行，
// 若也會截斷別的行，一行重疊的 call 就會讓主旋律提早熄滅。
export function implicitEnd(points, start) {
  const next = nextPoint(points, start);
  return next == null ? roundTime(start + DEFAULT_LAST_DURATION) : next;
}

// entries: [{ line, start, end|null }]；markers: 結束標記行的時間。
// 回傳依 start（同時間依行序）排序的 Span[]。
export function buildSpans(entries, markers = []) {
  const points = sortedUnique([...entries.map((e) => e.start), ...markers]);
  const spans = entries.map((e) => ({
    start: e.start,
    end: e.end != null && e.end > e.start + TIME_EPSILON ? e.end : implicitEnd(points, e.start),
    line: e.line,
  }));
  spans.sort((a, b) => a.start - b.start || a.line - b.line);
  return spans;
}

// 依 spans 更新各行的 times，並回傳歌曲層級欄位。
export function timelineFields(lines, spans) {
  for (const line of lines) line.times = [];
  for (const s of spans) lines[s.line].times.push(s.start);
  for (const line of lines) line.times.sort((a, b) => a - b);
  let duration = null;
  for (const s of spans) if (duration == null || s.end > duration) duration = s.end;
  return { spans, timed: spans.length > 0, duration };
}

// 播放查詢。active 依 start 排序；latest 取最晚開始的亮行（同時開始取前面那行，
// 一個 cue 對到多行時畫面會停在第一行，下一行自然在下方可見）。
export function queryTimeline(song, t) {
  const active = [];
  let latest = -1;
  let latestStart = -Infinity;
  let next = -1;
  let nextStart = Infinity;
  for (const s of song.spans) {
    if (s.start <= t && t < s.end) {
      active.push({ line: s.line, start: s.start, end: s.end });
      if (s.start > latestStart || (s.start === latestStart && s.line < latest)) {
        latestStart = s.start;
        latest = s.line;
      }
    } else if (s.start > t && (s.start < nextStart || (s.start === nextStart && s.line < next))) {
      nextStart = s.start;
      next = s.line;
    }
  }
  return { active, latest, next };
}

// 片段是否亮著：所在行亮著，且（沒有行內標記，或已過了行內標記時間）。
// 同一行有多個行首標記（LRC 重複行）時，行內標記視為相對於第一次出現的時間，
// 每次重複都同樣位移，讓重複的副歌也能逐段亮起。
export function segmentLit(song, lineIndex, segIndex, t) {
  const line = song.lines[lineIndex];
  if (!line || line.blank) return false;
  const seg = line.segments[segIndex];
  if (!seg) return false;
  let current = null;
  for (const s of song.spans) {
    if (s.line !== lineIndex) continue;
    if (s.start <= t && t < s.end && (current == null || s.start > current.start)) current = s;
  }
  if (!current) return false;
  if (seg.at == null) return true;
  const base = line.times.length ? line.times[0] : current.start;
  return t >= seg.at - base + current.start - TIME_EPSILON;
}

// 每段（空行隔開的一組行）第一個有時間的行的開始時間。該行有多個開始時間時全部列入。
export function stanzaStarts(song) {
  const out = [];
  let looking = true;
  for (const line of song.lines) {
    if (line.blank) {
      looking = true;
      continue;
    }
    if (looking && line.times.length) {
      out.push(...line.times);
      looking = false;
    }
  }
  return sortedUnique(out);
}
