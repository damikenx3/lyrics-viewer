// app 與 core 之間的轉接層：app 只從這裡取用 core。
// 若 core 的實作細節與規格不同，在這裡吸收，不讓差異擴散到介面程式。
import {
  parseLibraryFile as coreParseLibraryFile,
  queryTimeline as coreQueryTimeline,
  segmentLit as coreSegmentLit,
  stanzaStarts as coreStanzaStarts,
  songId as coreSongId,
  matchAudio as coreMatchAudio,
  readTags as coreReadTags,
} from '../core/index.js';

export const parseLibraryFile = coreParseLibraryFile;
export const queryTimeline = coreQueryTimeline;
export const segmentLit = coreSegmentLit;
export const stanzaStarts = coreStanzaStarts;
export const songId = coreSongId;
export const matchAudio = coreMatchAudio;
export const readTags = coreReadTags;
