// src/course.js — 강좌(여러 강 묶음) 순수 헬퍼: 강좌 이름 추출·자막 압축·강좌 자막 조립.
//
// 2026-11-04: 강의는 보통 3~4강으로 올라가는데 작업은 영상 하나씩이라, 1~4강을 아우르는 소개글(카페의 강별 안내,
// 강좌 전체를 아는 캐러셀·캡션)을 만들 길이 없었다. 강좌 작업은 jobs 행 하나(video_id 'course-…')에
// 강별 작업(jobs 행)을 contents 'course' 타입(JSON)으로 묶는다. 자막 4개를 원본째 싣지 않고(25~30만 자),
// 강마다 30초 한 줄로 압축한 '강좌 자막'을 쓴다 — 강의의 정체는 강별 강의 지도 → 강좌 지도가 쥔다.
// 외부 모듈을 끌어오지 않는다(테스트가 vimeo.js를 가짜로 바꿔도 이 파일은 그대로 돈다).

import { formatTimestamp } from './timestamp.js';

/** contents에 강좌 구성을 저장하는 타입 — { name, lectures: [{ n, jobId, videoId, title, duration, url }] } */
export const COURSE_TYPE = 'course';
export const COURSE_ID_PREFIX = 'course-';
export const COURSE_MAX_LECTURES = 4;
/** 강좌 자막은 강마다 이 간격으로 한 줄만 남긴다 (60분 넘는 단일 강의의 압축본과 같은 간격) */
export const COURSE_COMPRESS_SEC = 30;

export function isCourseJob(job) {
  return typeof job?.video_id === 'string' && job.video_id.startsWith(COURSE_ID_PREFIX);
}

/** contents의 'course' 행 내용(JSON 문자열) → 객체. 깨졌으면 undefined */
export function parseCourse(text) {
  try {
    const o = JSON.parse(text);
    return o && Array.isArray(o.lectures) && o.lectures.length ? o : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 강 제목들에서 강좌 이름을 뽑는다 — "1강-크롭데님쟈켓(OT+…)" / "2강-크롭데님쟈켓(몸판…)" → "크롭데님쟈켓",
 * "후드 벌룬 하프 트렌치코트 1강-재단 및 심지" → "후드 벌룬 하프 트렌치코트".
 * 회차 표기를 떼고 공통 앞머리를 취한다. 못 찾으면 첫 제목을 다듬어 쓴다.
 */
export function deriveCourseName(titles) {
  const cleaned = (titles || [])
    .map((t) => String(t || '').trim())
    .filter(Boolean)
    .map((t) =>
      t
        .replace(/^\s*(?:제\s*)?\d+\s*(?:강|회|차|주차)\s*[-–—:·.)\]]*\s*/u, '') // 앞머리 "1강-"
        .replace(/\s*[-–—:·(\[]?\s*(?:제\s*)?\d+\s*(?:강|회|차|주차)(?![가-힣]).*$/u, '') // 꼬리 "… 1강-재단 및 …", "초급정규8강-…" → "초급정규"
        .trim()
    )
    .filter(Boolean);
  if (cleaned.length === 0) return '';
  let prefix = cleaned[0];
  for (const t of cleaned.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < t.length && prefix[i] === t[i]) i++;
    prefix = prefix.slice(0, i);
  }
  const trimmed = prefix.replace(/[\s\-–—:·(\[/+,]+$/u, '').trim();
  // 공통 부분이 너무 짧으면(두 글자 이하) 공통이 없다고 보고 첫 제목을 쓴다
  return trimmed.length >= 3 ? trimmed : cleaned[0].replace(/[\s\-–—:·(\[/+,]+$/u, '').trim();
}

/** 저장된 자막 텍스트("[MM:SS] 말") → 간격마다 첫 줄만 남긴 압축본. 시각 줄이 아닌 줄은 버린다 */
export function compressTranscriptText(text, intervalSec = COURSE_COMPRESS_SEC) {
  const out = [];
  let lastBucket = -1;
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\[(\d+):(\d{2})\]\s*(.*)$/);
    if (!m) continue;
    const start = Number(m[1]) * 60 + Number(m[2]);
    const bucket = Math.floor(start / intervalSec);
    if (bucket === lastBucket) continue;
    lastBucket = bucket;
    out.push({ start, text: m[3] });
  }
  return out;
}

/**
 * 강좌 자막 조립 — 강마다 머리줄을 두고, 줄마다 "[n강 MM:SS]"로 시각에 회차를 박는다.
 * 모델이 캡쳐 자리·장면 후보에 "[2강 12:30]"처럼 쓰게 되는 근거가 이 표기다.
 * @param {Array<{ n: number, title: string, duration?: number, transcript_full?: string, transcript_compressed?: string }>} lectures
 */
export function buildCourseTranscript(lectures) {
  return lectures
    .map((lec) => {
      const cues = compressTranscriptText(lec.transcript_full || lec.transcript_compressed || '');
      const mins = lec.duration ? ` (${Math.round(lec.duration / 60)}분)` : '';
      const head = `=== ${lec.n}강 · ${lec.title || '제목 없음'}${mins} ===`;
      const lines = cues.map((c) => `[${lec.n}강 ${formatTimestamp(c.start)}] ${c.text}`);
      return [head, ...lines].join('\n');
    })
    .join('\n\n');
}

/** 강좌 작업의 video_id — 영상 하나가 아니므로 고유 접두어 + 짧은 난수 */
export function newCourseVideoId() {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${COURSE_ID_PREFIX}${rand}`;
}
