// core 對外 API（規格第 3 節）。依打包慣例：先 import，再以 export const 重新包一層。
import { parseLibraryFile as parseLibraryFileImpl } from './parse.js';
import { queryTimeline as queryTimelineImpl, segmentLit as segmentLitImpl, stanzaStarts as stanzaStartsImpl } from './timeline.js';
import { normalizeTitle as normalizeTitleImpl, songId as songIdImpl } from './normalize.js';
import { matchAudio as matchAudioImpl } from './match.js';
import { readTags as readTagsImpl } from './tags.js';
import { formatTime as formatTimeImpl } from './time.js';

export const parseLibraryFile = parseLibraryFileImpl;
export const queryTimeline = queryTimelineImpl;
export const segmentLit = segmentLitImpl;
export const stanzaStarts = stanzaStartsImpl;
export const normalizeTitle = normalizeTitleImpl;
export const songId = songIdImpl;
export const matchAudio = matchAudioImpl;
export const readTags = readTagsImpl;
// 規格外：秒 → "mm:ss.xx"，給介面顯示時間用。
export const formatTime = formatTimeImpl;
