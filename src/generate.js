// src/generate.js — 4종 순차 생성 오케스트레이션 + 수정(revise: cafe·caption·carousel) + 재생성(regenerateSecondary)
//
// 생성 순서: (강의 지도 — 강좌면 강별 지도 → 강좌 지도) → cafe → caption → carousel → capture
// 강좌(2~4강 묶음, generateCourse): 강마다 자막 작업 행을 두고, 강좌 행은 강마다 30초 한 줄로 압축한 강좌 자막을 두 칸(compressed·full)에 같이 둔다.
// 자막 사용: cafe → compressed / 강의 지도·caption·carousel·capture → full
//   (2026-09-09: 캡션·캐러셀도 원본 자막을 받는다. 60분 넘는 강의는 압축본이 30초에 한 줄이라
//    강의가 무엇인지 알 수 없었고, 그게 "바지 수업에 오버록 후크"의 뿌리였다. 캡션·캐러셀·캡쳐가 같은
//    원본 블록을 쓰므로 캐시는 한 번만 만들어진다.)
// 프롬프트 캐싱: 동일 모델·동일 자막 블록이면 캐시 재사용 (anthropic.js가 처리)

import { callClaude, MODELS } from './anthropic.js';
import { getTranscript } from './vimeo.js';
import * as vimeo from './vimeo.js'; // resolveVideoId — 테스트의 가짜 vimeo.js에 없어도 링크 오류가 나지 않게 네임스페이스로
import { load as loadVoice } from './voice.js';
import {
  COMMON_HEADER,
  TYPE_LABELS,
  buildCafePrompt,
  buildCaptionPrompt,
  buildCarouselPrompt,
  buildCapturePrompt,
  buildLectureMapPrompt,
  buildCourseMapPrompt,
  buildRevisePrompt,
  buildRegeneratePrompt,
  buildCafeCaptureSyncPrompt,
  CAROUSEL_CUT_MIN,
  CAROUSEL_CUT_MAX,
  MAP_WHY_ITEM,
} from './prompts.js';
import { saveJob, saveContent, getJob, getContents, getLatestContent, findJobByVideoId, listJobs } from './db.js';
import { reviewCardCopy, cardTextByCut } from './copyedit.js';
import { loadAllLessons, learnFromEdit, editPairs, LESSON_TYPES } from './lessons.js';
import {
  COURSE_TYPE,
  COURSE_MAX_LECTURES,
  isCourseJob,
  parseCourse,
  deriveCourseName,
  buildCourseTranscript,
  newCourseVideoId,
  seriesOf,
} from './course.js';

// 강의 지도 — 원본 자막 전체를 읽어 "이 강의가 어떤 강의인지"(강의 한 줄·주인공 배움·덤·결과물…)를 정리한 것.
// 캡션·캐러셀의 첫 생성·수정·재생성이 전부 이 지도를 앞에 두고 쓴다. 작업당 한 번 만들고 contents에 저장한다
// (컨셉과 달리 사실 정리라 '전체 기획 다시하기'에서도 다시 만들지 않는다). 지도가 없는 옛 작업은 필요할 때 만들어 채운다.
export const LECTURE_MAP_TYPE = 'lecture_map';

/** 작업에 저장된 강의 지도 (없으면 undefined) */
export async function loadLectureMap(jobId) {
  const row = await getLatestContent(jobId, LECTURE_MAP_TYPE);
  const text = (row?.content || '').trim();
  return text || undefined;
}

/**
 * 다시 만들어야 하는 강의 지도인가 — 아래 둘 중 하나면 다음에 쓸 때 다시 만든다.
 *  (1) 끊긴 지도: 마지막 항목('검색어 후보')이 없다. 2026-11-04~11-16에 출력 한도가 사고 토큰에 먹혀 지도가 중간까지만
 *      저장됐고(anthropic.js MAX_OUTPUT_TOKENS 주석), 지도는 작업당 한 번만 만들어 계속 쓰므로 반쪽 지도가 이후 기획에 전부 실렸다.
 *  (2) 옛 형식 지도: '이렇게 만드는 이유' 항목이 없다(2026-11-16에 추가 — 캡션·캐러셀이 이 항목을 중심 재료로 쓴다).
 * 한 작업에서 두 번까지만 다시 만든다(끊김 한 번 + 형식 한 번) — 모델이 항목을 빠뜨려도 매번 새로 만드는 일이 없게.
 */
export function isStaleLectureMap(row) {
  const text = (row?.content || '').trim();
  if (!text) return false;
  const current = /검색어\s*후보/.test(text) && text.includes(MAP_WHY_ITEM);
  return !current && (row.version ?? 1) <= 2;
}

/** 강의 지도에서 '이렇게 만드는 이유' 항목의 내용만 떼어 낸다 — 항목이 없거나 "없음"이면 '' */
export function extractWhyItem(map) {
  const lines = String(map || '').split('\n');
  const start = lines.findIndex((l) => /^[-*•]\s/.test(l) && l.includes(MAP_WHY_ITEM));
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[-*•]\s/.test(lines[i])) { // 다음 항목(들여쓰기 없는 글머리)에서 끝
      end = i;
      break;
    }
  }
  const first = lines[start].slice(lines[start].indexOf(MAP_WHY_ITEM) + MAP_WHY_ITEM.length).replace(/^[\s*:：]+/, '');
  const body = [first, ...lines.slice(start + 1, end)].map((l) => l.trimEnd()).filter((l) => l.trim()).join('\n').trim();
  return !body || /^\W*없음/.test(body) ? '' : body;
}

// 같은 시리즈(제목의 시리즈 이름이 같고 회차가 다른 강의)의 다른 강에서 자야쌤이 밝힌 '이렇게 만드는 이유'를 가져온다.
// 이유는 강좌에서 한 번만 말한다 — "핸드메이드 코트에 왜 안감을 넣는지"는 4강에 있고, 안감을 마무리하는 5강에는 없다.
// 5강만 읽어서는 "왜 이렇게 만드는지"를 쓸 수 없어 만드는 방법만 늘어놓게 된다(2026-11-16).
// 가까운 회차부터 네 강까지 본다. 그 강의 지도가 옛 형식이면 그때 한 번 다시 만든다(강마다 모델 호출 1회 — 다음부터는 저장본).
const SERIES_SIBLING_MAX = 4;

/**
 * @returns {Promise<string>} 지도 뒤에 덧붙일 블록(없으면 ''). 실패해도 기획을 막지 않는다.
 */
export async function seriesWhyBlock(job) {
  if (process.env.JAYA_NO_SERIES) return ''; // 가짜 모델로 도는 개발 서버(test/mock-server.mjs)가 실제 작업의 지도를 건드리지 않게
  if (!job || isCourseJob(job)) return ''; // 강좌 작업은 강좌 지도가 이미 모든 강의 이유를 모은다
  const me = seriesOf(job.video_title);
  if (!me) return '';
  try {
    const byN = new Map(); // 회차 → 가장 최근 작업 (listJobs는 최신순)
    for (const j of await listJobs(300)) {
      if (j.id === job.id || j.kind === 'course') continue;
      const s = seriesOf(j.video_title);
      if (!s || s.key !== me.key || s.n === me.n || byN.has(s.n)) continue;
      byN.set(s.n, j);
    }
    const picked = [...byN.entries()]
      .sort((a, b) => Math.abs(a[0] - me.n) - Math.abs(b[0] - me.n) || a[0] - b[0])
      .slice(0, SERIES_SIBLING_MAX);
    if (picked.length === 0) return '';

    const found = [];
    for (let i = 0; i < picked.length; i += 2) { // 두 강씩 — 긴 자막 호출을 한꺼번에 쏘지 않는다
      const pair = await Promise.all(
        picked.slice(i, i + 2).map(async ([n, lite]) => {
          try {
            const sibling = await getJob(lite.id);
            if (!sibling?.transcript_full) return null;
            const why = extractWhyItem(await ensureLectureMap(sibling));
            return why ? { n, title: sibling.video_title, why } : null;
          } catch (err) {
            console.warn(`시리즈 이유: ${n}강 지도를 읽지 못해 건너뜁니다 — ${err.message}`);
            return null;
          }
        })
      );
      found.push(...pair.filter(Boolean));
    }
    if (found.length === 0) return '';
    found.sort((a, b) => a.n - b.n);
    console.log(`시리즈 이유: ${me.name} ${found.map((f) => `${f.n}강`).join('·')}에서 '${MAP_WHY_ITEM}'를 가져왔습니다`);
    return `

[같은 시리즈의 다른 강에서 밝힌 이유 — 이 강의 자막에는 없지만, 같은 수업(${me.name})의 다른 강에서 자야쌤이 직접 말한 '${MAP_WHY_ITEM}'다]
${found.map((f) => `▸ ${f.n}강 · ${f.title}\n${f.why}`).join('\n')}
- 같은 옷을 여러 강에 걸쳐 만드는 수업이면, 위 이유들은 이 강의가 완성해 가는 **바로 그 옷**을 왜 이렇게 만드는지다. 입는 사람이 공감할 이유를 골라
  "${me.name} 수업에서는 ~"처럼 수업 전체의 이야기로 쓴다. 이 강의에서 하는 작업과 이어지는 이유(이 강의에서 안감을 마무리한다면 '안감을 넣는 이유')를 먼저 쓴다.
- 강마다 다른 옷을 만드는 수업이면(위 강 제목이 서로 다른 옷이면) 다른 옷의 이유는 끌어오지 않는다.
- 여기 적힌 시각은 다른 강의 것이다. 이 강의의 실사캡쳐 시각으로 쓰지 않는다.`;
  } catch (err) {
    console.warn(`시리즈 이유: 같은 시리즈의 다른 강을 찾지 못했습니다 — ${err.message}`);
    return '';
  }
}

/**
 * 강의 지도를 읽고, 없으면(또는 끊긴 채 저장돼 있으면) 원본 자막으로 만들어 저장한 뒤 돌려준다.
 * 강좌 작업이면 강별 지도(강 작업마다 1회)를 먼저 갖춘 뒤 그 위에 '강좌 지도'를 만들어 같은 타입으로 저장한다 —
 * 4종·수정·재생성은 강의 지도 자리에 강좌 지도를 그대로 받는다.
 * @param {object} job
 * @param {(payload: object) => void} [onProgress] 단계 알림(강별 지도·강좌 지도)
 */
export async function ensureLectureMap(job, onProgress = () => {}) {
  const row = await getLatestContent(job.id, LECTURE_MAP_TYPE);
  const saved = (row?.content || '').trim();
  if (saved && !isStaleLectureMap(row)) return saved;
  if (saved) console.warn(`강의 파악: 저장된 강의 지도가 끊겼거나 옛 형식이라 다시 만듭니다 (${saved.length}자, 작업 ${job.id})`);
  if (isCourseJob(job)) return buildCourseMap(job, onProgress);
  if (!job.transcript_full) throw new Error('강의 파악: 이 작업에는 저장된 원본 자막이 없습니다.');
  console.log('강의 파악 중... (원본 자막 전체를 읽어 강의 지도 작성)');
  const map = await callClaude({
    model: MODELS.CAROUSEL,
    system: COMMON_HEADER,
    prompt: buildLectureMapPrompt({ topic: job.topic || undefined, title: job.video_title || undefined }),
    transcript: job.transcript_full,
    step: '강의 파악',
  });
  await saveContent(job.id, LECTURE_MAP_TYPE, map);
  console.log(`강의 파악 완료 (${map.length}자)`);
  return map;
}

/** 강좌 작업의 구성(contents 'course' 타입, JSON) — 강좌가 아니면 undefined */
export async function loadCourse(jobId) {
  const row = await getLatestContent(jobId, COURSE_TYPE);
  return row ? parseCourse(row.content) : undefined;
}

/** 강좌 지도 — 강별 강의 지도를 갖춘 뒤(없는 강은 여기서 만든다) 강좌 자막과 함께 읽어 강좌 전체를 정리하고 저장한다 */
async function buildCourseMap(job, onProgress) {
  const course = await loadCourse(job.id);
  if (!course) throw new Error('강좌 파악: 이 작업의 강좌 구성(course)이 저장돼 있지 않습니다.');
  const lectures = [];
  for (const lec of course.lectures) {
    const child = await getJob(lec.jobId);
    if (!child) throw new Error(`강좌 파악: ${lec.n}강 작업(${lec.jobId})을 찾을 수 없습니다.`);
    onProgress({ type: 'stage', stage: 'lecture_map', n: lec.n, label: `${lec.n}강 강의 지도` });
    const map = await ensureLectureMap(child);
    lectures.push({ n: lec.n, title: lec.title, map });
  }
  onProgress({ type: 'stage', stage: 'course_map', label: '강좌 지도' });
  console.log(`강좌 파악 중... (강별 지도 ${lectures.length}개 + 강좌 자막으로 강좌 지도 작성)`);
  const map = await callClaude({
    model: MODELS.CAROUSEL,
    system: COMMON_HEADER,
    prompt: buildCourseMapPrompt({ name: course.name, lectures }),
    transcript: job.transcript_full,
    step: '강좌 파악',
  });
  await saveContent(job.id, LECTURE_MAP_TYPE, map);
  console.log(`강좌 파악 완료 (${map.length}자)`);
  return map;
}

// 기획 컨셉은 jobs 테이블에 칸이 없어 contents의 'concept' 타입으로 버전 저장한다(첫 생성·전체 다시하기마다 새 버전).
// 수정(revise)·재생성·컷 수 조정처럼 나중에 도는 모델 호출은 전부 여기서 최신 컨셉을 읽어 프롬프트에 싣는다 —
// 안 그러면 컨셉이 첫 생성에만 적용되고 후크 안을 바꾸는 순간 빠진다(2026-09-05 발견).
export const CONCEPT_TYPE = 'concept';

async function saveConcept(jobId, concept) {
  const text = (concept || '').trim();
  if (!text) return null;
  return saveContent(jobId, CONCEPT_TYPE, text);
}

/** 작업에 저장된 최신 기획 컨셉 (없으면 undefined) */
export async function loadConcept(jobId) {
  const row = await getLatestContent(jobId, CONCEPT_TYPE);
  const text = (row?.content || '').trim();
  return text || undefined;
}

/**
 * 캐러셀 컷 수 공통 규칙 검증 — 기획안은 그대로 캐러셀 공장에서 카드로 만들어지므로
 * (1) 실제 CUT 개수가 CAROUSEL_CUT_MIN~MAX 안인지, (2) CUT 번호가 1부터 빠짐없이 이어지는지 확인하고
 * (3) 개요의 "총 컷 수" 숫자가 실제 CUT 개수와 다르면 실제 개수로 바로잡는다(모델이 가장 자주 틀리는 지점).
 * 컷을 늘리거나 잘라내는 건 코드가 판단할 일이 아니라 경고만 남긴다.
 *
 * @param {string} content 캐러셀 기획안 원문
 * @param {string} [label] 로그 접두어
 * @returns {{ content: string, count: number, warnings: string[] }}
 */
export function normalizeCarouselCuts(content, label = '캐러셀 기획') {
  const warnings = [];
  const nums = [...content.matchAll(/^##\s*CUT\s*(\d+)\b/gm)].map((m) => Number(m[1]));
  const count = nums.length;

  if (count === 0) {
    warnings.push('CUT 헤더(## CUT n)를 하나도 찾지 못했습니다 — 출력 형식이 깨졌을 수 있습니다.');
  } else {
    if (count < CAROUSEL_CUT_MIN || count > CAROUSEL_CUT_MAX) {
      warnings.push(`컷 수 ${count}개 — 공통 규칙(${CAROUSEL_CUT_MIN}~${CAROUSEL_CUT_MAX}컷) 밖입니다.`);
    }
    const sequential = nums.every((n, i) => n === i + 1);
    if (!sequential) warnings.push(`CUT 번호가 1부터 이어지지 않습니다: ${nums.join(', ')}`);
  }

  let fixed = content;
  if (count > 0) {
    // 예: "- **총 컷 수**: 13컷 (…)" → 실제 개수로 교정
    fixed = content.replace(/(\*\*총 컷 수\*\*\s*[:：]\s*)(\d+)(\s*컷)/, (whole, pre, num, post) => {
      if (Number(num) === count) return whole;
      warnings.push(`개요의 총 컷 수 ${num}컷 → 실제 CUT 개수 ${count}컷으로 교정했습니다.`);
      return `${pre}${count}${post}`;
    });
  }

  warnings.forEach((w) => console.warn(`${label} 컷 수 검증: ${w}`));
  return { content: fixed, count, warnings };
}

/**
 * 캐러셀 기획안 마무리 — 컷 수 검증·교정을 하고, 컷 수가 공통 규칙 밖이면 **한 번만** 모델에 되돌려 맞춘다.
 * (14컷 초과·10컷 미만은 카드 제작 자체가 막히므로 경고로 끝내지 않는다. 그래도 안 맞으면 경고와 함께 그대로 저장.)
 * 그다음 카드 카피 교정(copyedit.js)을 한 번 거친다 — 수정(previous가 있을 때)이면 카드 텍스트가 바뀐 컷만.
 *
 * @param {object} o
 * @param {string} o.content 모델이 낸 기획안
 * @param {object} o.job 작업 행(transcript_compressed·topic 사용)
 * @param {object} o.voice 보이스 프로파일
 * @param {string} [o.cafe] 확정 카페 서머리(있으면 컨텍스트)
 * @param {string} [o.caption] 확정 인스타 캡션(있으면 컨텍스트)
 * @param {string} [o.concept] 기획 컨셉(있으면 재요청 프롬프트에도 싣는다)
 * @param {string} [o.lectureMap] 강의 지도(있으면 재요청 프롬프트에도 싣는다)
 * @param {string} o.label 로그 접두어
 * @returns {Promise<string>} 최종 기획안
 */
export async function finalizeCarousel({ content, job, voice, cafe, caption, concept, lectureMap, course, lessons, label, previous, instruction }) {
  const fitted = await fitCutCount({ content, job, voice, cafe, caption, concept, lectureMap, course, lessons, label });
  // 카드 텍스트는 캐러셀 공장이 그대로 카드에 찍는다 — 마지막 교정자 한 번(수정이면 바뀐 컷만)
  return reviewCardCopy({ content: fitted, lectureMap, previous, instruction, lessons, label });
}

async function fitCutCount({ content, job, voice, cafe, caption, concept, lectureMap, course, lessons, label }) {
  let { content: fixed, count } = normalizeCarouselCuts(content, label);
  const inRange = (n) => n >= CAROUSEL_CUT_MIN && n <= CAROUSEL_CUT_MAX;
  if (count === 0 || inRange(count)) return fixed;

  const target = count > CAROUSEL_CUT_MAX ? CAROUSEL_CUT_MAX : CAROUSEL_CUT_MIN;
  const how =
    count > CAROUSEL_CUT_MAX
      ? `learn·bonus 구간에서 가장 약한 컷을 버려 ${target}컷으로 줄인다. 버린 소재는 solution 목록의 이름으로만 남긴다.`
      : `learn·bonus 확장 구간에서 자막 근거가 있는 배움·덤을 한 컷에 하나씩 보태 ${target}컷으로 늘린다. 이미 나온 소재를 되풀이하는 컷은 넣지 않는다.`;
  const instruction =
    `현재 기획안은 총 ${count}컷으로 [컷 수 공통 규칙](${CAROUSEL_CUT_MIN}~${CAROUSEL_CUT_MAX}컷)을 어긴다. ${how} ` +
    `hook·promise·solution·result·together·cta 고정 컷과 역할 순서, 후크 후보, solution 표기 형식은 그대로 두고, ` +
    `개요의 총 컷 수·감정 곡선·CUT 번호를 실제 개수에 맞춘다.`;

  console.warn(`${label}: 컷 수 ${count}개 → ${target}컷으로 맞추는 재요청 1회`);
  const retried = await callClaude({
    model: MODELS.CAROUSEL,
    system: COMMON_HEADER,
    prompt: buildRevisePrompt({
      type: 'carousel',
      original: fixed,
      instruction,
      voice,
      topic: job.topic || undefined,
      concept,
      cafe,
      caption,
      lectureMap,
      course,
      lessons,
    }),
    transcript: job.transcript_full || job.transcript_compressed,
    step: `${label} 컷 수 조정`,
  });
  const second = normalizeCarouselCuts(retried, `${label} 컷 수 조정`);
  if (second.count > 0 && inRange(second.count)) {
    console.log(`${label}: 컷 수 ${second.count}컷으로 조정 완료`);
    return second.content;
  }
  console.warn(`${label}: 재요청 후에도 컷 수 ${second.count}개 — 규칙 밖 상태로 저장합니다. 화면에서 수정 요청으로 맞춰 주세요.`);
  return second.count > 0 ? second.content : fixed;
}

/** 섹션별 호출 사양 구성 */
function buildSectionSpecs({ voice, topic, concept, lectureMap, planMap, course, lessons, compressed, full }) {
  return [
    {
      type: 'cafe',
      model: MODELS.CAFE,
      transcript: compressed,
      prompt: buildCafePrompt({ voice, topic, concept, course, lectureMap, lessons: lessons.cafe }),
    },
    {
      type: 'caption',
      model: MODELS.CAPTION,
      transcript: full, // 강의 정체를 잡아야 하므로 원본 자막 (지도와 함께)
      prompt: buildCaptionPrompt({ voice, topic, concept, lectureMap: planMap, course, lessons: lessons.caption }),
    },
    {
      type: 'carousel',
      model: MODELS.CAROUSEL,
      transcript: full,
      prompt: buildCarouselPrompt({ voice, topic, concept, lectureMap: planMap, course, lessons: lessons.carousel }),
    },
    {
      type: 'capture',
      model: MODELS.CAPTURE,
      transcript: full,
      prompt: buildCapturePrompt({ concept, course, lectureMap }),
    },
  ];
}

/**
 * 4종 순차 생성 공통 루프 — 첫 생성(generateAll)과 전체 재기획(regenerateAll)이 함께 쓴다.
 * 각 섹션 완료(또는 실패) 시 onProgress 호출. 한 섹션이 실패해도 다음 섹션은 계속 진행.
 *
 * @returns {Promise<{results: object, failed: string[]}>}
 */
async function runSections({ job, voice, topic, concept, onProgress }) {
  // 강의 지도가 먼저다 — 캡션·캐러셀은 이걸 없이 쓰면 강의 전체를 모른 채 눈에 띄는 문장부터 잡는다.
  // 지도 작성이 실패하면 4종 전체를 멈춘다(지도 없는 캡션·캐러셀은 예전 실패로 돌아가는 것이라 의미가 없다).
  const lectureMap = await ensureLectureMap(job, onProgress);
  // 캡션·캐러셀은 같은 시리즈 다른 강의 '이렇게 만드는 이유'까지 붙인 지도를 받는다(카페·캡쳐는 이전 그대로)
  const planMap = lectureMap + (await seriesWhyBlock(job));
  const course = await loadCourse(job.id); // 강좌 작업이면 4종 전부에 강좌 블록을 싣는다
  const lessons = await loadAllLessons(); // 자야쌤이 지난 기획들을 손으로 고친 것에서 배운 것(카페·캡션·캐러셀)

  const specs = buildSectionSpecs({
    voice,
    topic,
    concept,
    lectureMap,
    planMap,
    course,
    lessons,
    compressed: job.transcript_compressed,
    full: job.transcript_full,
  });

  const results = {};
  const failed = [];

  for (const spec of specs) {
    const label = TYPE_LABELS[spec.type];
    console.log(`${label} 생성 중...`);
    try {
      // 캡쳐 가이드는 카페 서머리의 "📷 캡쳐 n" 자리와 맞물려야 하므로, 앞서 생성된 카페 글을 넘긴다
      // 캐러셀은 먼저 쓴 캡션의 이야기를 장마다 끊어 보여준다(같은 게시물, 같은 줄거리) — 캡션 결과를 넘긴다
      const prompt =
        spec.type === 'capture'
          ? buildCapturePrompt({ cafe: results.cafe, concept, course, lectureMap })
          : spec.type === 'carousel'
            ? buildCarouselPrompt({ voice, topic, concept, lectureMap: planMap, caption: results.caption, course, lessons: lessons.carousel })
            : spec.prompt;
      let content = await callClaude({
        model: spec.model,
        system: COMMON_HEADER,
        prompt,
        transcript: spec.transcript,
        step: `${label} 생성`,
      });
      if (spec.type === 'carousel') {
        content = await finalizeCarousel({
          content, job, voice, cafe: results.cafe, caption: results.caption, concept, lectureMap: planMap, course, lessons: lessons.carousel, label,
        });
      }
      await saveContent(job.id, spec.type, content);
      results[spec.type] = content;
      console.log(`${label} 생성 완료 (${content.length}자)`);
      onProgress({ type: spec.type, content });
    } catch (err) {
      // 한 섹션 실패가 전체를 중단시키지 않는다 — 해당 섹션만 실패 알림 후 계속
      console.error(`${label} 생성 실패: ${err.message}`);
      failed.push(spec.type);
      onProgress({ type: spec.type, error: err.message });
    }
  }

  return { results, failed };
}

/**
 * 캐러셀 기획안 개요에서 채택된 후크 안을 읽는다 — { key: 'A'|'B'|'C', kind: '공감형'|'참여유도형'|'반전형'|'위기형', head }.
 * (프론트 parseHookCandidates와 같은 표기 규약: "· A안 [갈래] 헤드카피 → 근거" / "· 채택: A안 → 이유".
 *  갈래 이름은 대괄호 안 짧은 낱말이면 무엇이든 받는다 — 갈래를 늘려도 파서를 고치지 않아도 되게.)
 * 후크 안이 실제로 바뀌었는지 판단해 캡션을 따라 고칠지 정하는 데 쓴다.
 */
export function adoptedHook(planText) {
  if (!planText) return null;
  const cutIdx = planText.search(/^##\s*CUT\s*\d+/m);
  const overview = cutIdx > 0 ? planText.slice(0, cutIdx) : planText;
  const adoptM = overview.match(/^\s*[·•\-*]?\s*\**채택\**\s*[:：]?\s*\**\s*([ABC])안/m);
  if (!adoptM) return null;
  const key = adoptM[1];
  const candRe = new RegExp(`^\\s*[·•\\-*]?\\s*\\**${key}안\\**\\s*[\\[［(（]\\s*([^\\]］)）\\s]{1,12})\\s*[\\]］)）]\\s*[:：]?\\s*(.+)$`, 'm');
  const candM = overview.match(candRe);
  if (!candM) return { key, kind: null, head: null };
  const head = candM[2].split(/\s*(?:→|—|\||--)\s*/)[0].replace(/\*\*/g, '').replace(/^["“「『']+|["”」』']+$/g, '').trim();
  return { key, kind: candM[1], head };
}

/**
 * 캡쳐 가이드가 따라가는 카페 글의 "📷 캡쳐 n [MM:SS] …" 자리표시 줄만 뽑는다.
 * 카페 수정 전후로 이 줄들이 달라졌으면 캡쳐 가이드도 다시 만들어야 한다.
 */
function captureMarkers(cafeText) {
  return ((cafeText || '').match(/📷[^\n]*/g) || []).map((s) => s.trim()).join('\n');
}

/**
 * 메인 플로우: URL → 자막 수집 → 4종 순차 생성.
 * 각 섹션 완료(또는 실패) 시 onProgress 콜백 호출. 한 섹션이 실패해도 다음 섹션은 계속 진행.
 *
 * @param {object} opts
 * @param {string} opts.url - 비메오 URL
 * @param {string} [opts.topic] - 강의 주제 (선택)
 * @param {string} [opts.concept] - 기획 컨셉: 4종을 관통하는 방향 (선택)
 * @param {(payload: {type: string, content?: string, error?: string}) => void} opts.onProgress
 * @returns {Promise<{jobId: string, results: object, failed: string[]}>}
 */
export async function generateAll({ url, topic, concept, onProgress = () => {} }) {
  // 절대 규칙 1: 보이스 프로파일이 없으면 생성 자체를 시작하지 않는다
  const voice = await loadVoice();
  console.log('보이스 프로파일 로드 완료');

  console.log('자막 수집 시작...');
  const transcript = await getTranscript(url);

  const job = await saveJob({
    video_id: transcript.videoId,
    video_title: transcript.title,
    vimeo_url: url,
    topic: topic || null,
    transcript_compressed: transcript.compressed,
    transcript_full: transcript.full,
  });
  console.log(`작업 생성: ${job.id} (${transcript.title})`);
  await saveConcept(job.id, concept);

  // 클라이언트에 작업 ID를 즉시 전달 — 콘텐츠 생성 완료 전에도 수정 요청 가능하게 함
  onProgress({ type: 'job_created', jobId: job.id });

  const { results, failed } = await runSections({ job, voice, topic, concept, onProgress });
  return { jobId: job.id, results, failed };
}

/**
 * 강좌 기획 — 2~4강을 묶어 강좌 하나의 4종을 만든다.
 * 강마다 자막을 갖춘 '강 작업'(jobs 행)을 두고(새 URL은 수집, 이미 수집한 영상·지난 작업은 그대로 씀),
 * 강좌 작업 행에는 강마다 30초 한 줄로 압축한 '강좌 자막'을 저장한다. 강좌 지도는 runSections → ensureLectureMap이 만든다.
 *
 * @param {object} opts
 * @param {Array<{ url?: string, jobId?: string }>} opts.lectures 강 순서대로(1강부터). URL 또는 지난 작업 ID
 * @param {string} [opts.name] 강좌 이름(비우면 강 제목들의 공통 부분)
 * @param {string} [opts.topic]
 * @param {string} [opts.concept]
 * @param {(payload: object) => void} [opts.onProgress]
 */
export async function generateCourse({ lectures, name, topic, concept, onProgress = () => {} }) {
  const step = '강좌 기획';
  const items = (lectures || []).filter((l) => l && ((l.url && l.url.trim()) || l.jobId));
  if (items.length < 2 || items.length > COURSE_MAX_LECTURES) {
    throw new Error(`${step}: 강좌는 2~${COURSE_MAX_LECTURES}강으로 묶습니다 (지금 ${items.length}강).`);
  }

  const voice = await loadVoice();
  console.log('보이스 프로파일 로드 완료');

  // 1) 강마다 자막이 있는 작업 행을 갖춘다
  const children = [];
  for (let i = 0; i < items.length; i++) {
    const n = i + 1;
    const item = items[i];
    onProgress({ type: 'stage', stage: 'transcript', n, label: `${n}강 자막` });
    let child = null;
    if (item.jobId) {
      child = await getJob(item.jobId);
      if (!child) throw new Error(`${step}: ${n}강으로 고른 지난 작업(${item.jobId})을 찾을 수 없습니다.`);
      if (isCourseJob(child)) throw new Error(`${step}: ${n}강 자리에는 강좌 작업이 아니라 강의 하나짜리 작업을 골라 주세요.`);
      if (!child.transcript_full) throw new Error(`${step}: ${n}강으로 고른 작업에는 저장된 자막이 없습니다.`);
      console.log(`${n}강: 지난 작업 재사용 — ${child.video_title}`);
    } else {
      const url = item.url.trim();
      // 같은 영상을 이미 수집했으면 비메오를 다시 부르지 않는다
      let existing = null;
      try {
        const videoId = vimeo.resolveVideoId ? await vimeo.resolveVideoId(url) : null;
        existing = videoId ? await findJobByVideoId(videoId) : null;
      } catch {
        existing = null; // 해석 실패는 아래 수집에서 제대로 된 오류로 드러난다
      }
      if (existing && !isCourseJob(existing)) {
        child = existing;
        console.log(`${n}강: 이미 수집한 자막 재사용 — ${child.video_title}`);
      } else {
        console.log(`${n}강 자막 수집 시작...`);
        let transcript;
        try {
          transcript = await getTranscript(url);
        } catch (err) {
          throw new Error(`${n}강 ${err.message}`);
        }
        child = await saveJob({
          video_id: transcript.videoId,
          video_title: transcript.title,
          vimeo_url: url,
          topic: null,
          transcript_compressed: transcript.compressed,
          transcript_full: transcript.full,
        });
        if (transcript.duration) child.duration = transcript.duration;
        console.log(`${n}강 작업 생성: ${child.id} (${transcript.title})`);
      }
    }
    children.push({ n, job: child });
  }

  // 2) 강좌 작업 행 — 강좌 자막(강마다 30초 한 줄, 시각에 회차) + 구성 JSON
  const courseName = (name || '').trim() || deriveCourseName(children.map((c) => c.job.video_title)) || '강좌';
  const courseTranscript = buildCourseTranscript(
    children.map((c) => ({
      n: c.n,
      title: c.job.video_title,
      duration: c.job.duration,
      transcript_full: c.job.transcript_full,
      transcript_compressed: c.job.transcript_compressed,
    }))
  );
  const job = await saveJob({
    video_id: newCourseVideoId(),
    video_title: courseName,
    vimeo_url: children.map((c) => c.job.vimeo_url).join('\n'),
    topic: topic || null,
    transcript_compressed: courseTranscript,
    transcript_full: courseTranscript, // 강좌는 원본 자막을 통째로 싣지 않는다 — 두 칸 다 강좌 자막
  });
  const courseMeta = {
    name: courseName,
    lectures: children.map((c) => ({
      n: c.n,
      jobId: c.job.id,
      videoId: c.job.video_id,
      title: c.job.video_title,
      duration: c.job.duration || null,
      url: c.job.vimeo_url,
    })),
  };
  await saveContent(job.id, COURSE_TYPE, JSON.stringify(courseMeta));
  await saveConcept(job.id, concept);
  console.log(`강좌 작업 생성: ${job.id} (${courseName}, ${children.length}강, 강좌 자막 ${courseTranscript.length}자)`);

  onProgress({ type: 'job_created', jobId: job.id, course: courseMeta });

  const { results, failed } = await runSections({ job, voice, topic, concept, onProgress });
  return { jobId: job.id, results, failed, course: courseMeta };
}

/**
 * 전체 기획 다시하기 — 컨셉이 통째로 어긋났을 때. 기존 작업의 자막을 그대로 쓰고,
 * 사용자가 적은 [기획 컨셉]을 4종 프롬프트 전부에 넣어 cafe → caption → carousel → capture를 다시 생성한다.
 * 각 섹션은 새 버전으로 저장된다(이전 버전은 이력에 남음).
 *
 * @returns {Promise<{jobId: string, results: object, failed: string[]}>}
 */
export async function regenerateAll({ jobId, concept, onProgress = () => {} }) {
  const step = '전체 기획 다시하기';
  if (!concept || !concept.trim()) throw new Error(`${step}: 기획 컨셉이 비어 있습니다. 4종을 관통할 방향을 적어 주세요.`);

  const job = await getJob(jobId);
  if (!job) throw new Error(`${step}: 작업(${jobId})을 찾을 수 없습니다.`);
  if (!job.transcript_compressed || !job.transcript_full) {
    throw new Error(`${step}: 이 작업에는 저장된 자막이 없어 다시 기획할 수 없습니다.`);
  }

  const voice = await loadVoice();
  console.log(`${step} 시작 (컨셉: ${concept.trim().slice(0, 60)})`);
  await saveConcept(job.id, concept);
  const { results, failed } = await runSections({
    job,
    voice,
    topic: job.topic || undefined,
    concept: concept.trim(),
    onProgress,
  });
  console.log(`${step} 완료 (실패: ${failed.length ? failed.join(', ') : '없음'})`);
  return { jobId: job.id, results, failed };
}

const REVISABLE_TYPES = ['cafe', 'caption', 'carousel'];
const REVISE_MODELS = { cafe: MODELS.CAFE, caption: MODELS.CAPTION, carousel: MODELS.CAROUSEL };

/**
 * 개별 수정 재생성 — 카페 서머리('cafe') / 인스타 캡션('caption') / 캐러셀 기획('carousel').
 * 원본 내용 + 수정 지시 + 보이스 + 자막 기반으로 해당 섹션만 재생성 후 새 버전 저장.
 * 캐러셀은 확정된 카페·캡션이 있으면 컨텍스트로 함께 넣어 메시지 일관성을 유지한다
 * (대표 사용처: 1컷 후크를 A안→B안으로 바꿔 다시 기획).
 * 캡쳐 가이드는 카페 글의 📷 자리 번호에 종속돼 있어 여기서 수정하지 않는다 — [캐러셀·캡쳐 재생성] 버튼 사용.
 *
 * 캐러셀 수정으로 후크 채택안이 바뀌면(alignCaption=true일 때) 짝꿍인 인스타 캡션의 첫 두 줄도 같은 갈래로 따라 고쳐 함께 돌려준다.
 *
 * @returns {Promise<{content: string, version: number, capture?: string|null, caption?: string|null}>}
 */
export async function revise({ jobId, type, instruction, alignCaption = true }) {
  const step = '수정 재생성';
  if (!REVISABLE_TYPES.includes(type)) {
    throw new Error(`${step}: 수정은 카페 서머리(cafe)·인스타 캡션(caption)·캐러셀 기획(carousel)만 가능합니다 — 요청 타입: ${type}`);
  }
  if (!instruction || !instruction.trim()) {
    throw new Error(`${step}: 수정 지시가 비어 있습니다.`);
  }

  const job = await getJob(jobId);
  if (!job) throw new Error(`${step}: 작업(${jobId})을 찾을 수 없습니다.`);

  const latest = await getLatestContent(jobId, type);
  if (!latest) throw new Error(`${step}: 수정할 ${TYPE_LABELS[type]} 원본이 없습니다. 먼저 생성을 완료하세요.`);

  const voice = await loadVoice();
  const concept = await loadConcept(jobId);
  const course = await loadCourse(jobId);
  // 캡션·캐러셀 수정은 강의 지도와 원본 자막을 쓴다(옛 작업이면 여기서 지도를 만들어 채운다). 카페는 이전 그대로 —
  // 단, 강좌 작업의 카페 글은 강별 안내가 지도에서 오므로 강좌 지도를 싣는다.
  const usesMap = type === 'caption' || type === 'carousel' || !!course;
  const lectureMap = usesMap ? (await ensureLectureMap(job)) + (type === 'cafe' ? '' : await seriesWhyBlock(job)) : undefined;
  const transcript = usesMap ? job.transcript_full || job.transcript_compressed : job.transcript_compressed;
  const lessons = await loadAllLessons();

  // 캐러셀 수정은 확정된 카페·캡션을 컨텍스트로 넣는다(없으면 자막만으로 진행).
  let extra = {};
  if (type === 'carousel') {
    const [cafeRow, captionRow] = await Promise.all([
      getLatestContent(jobId, 'cafe'),
      getLatestContent(jobId, 'caption'),
    ]);
    extra = { topic: job.topic || undefined, cafe: cafeRow?.content, caption: captionRow?.content };
  }

  const label = TYPE_LABELS[type];
  console.log(`${label} 수정 재생성 중... (지시: ${instruction.slice(0, 50)})`);
  let content = await callClaude({
    model: REVISE_MODELS[type],
    system: COMMON_HEADER,
    prompt: buildRevisePrompt({ type, original: latest.content, instruction, voice, concept, lectureMap, course, lessons: lessons[type], ...extra }),
    transcript,
    step: `${label} 수정`,
  });
  if (type === 'carousel') {
    content = await finalizeCarousel({
      content, job, voice, cafe: extra.cafe, caption: extra.caption, concept, lectureMap, course, lessons: lessons.carousel, label: `${label} 수정`,
      previous: latest.content, instruction,
    });
  }

  const row = await saveContent(jobId, type, content);
  console.log(`${label} 수정 완료 (버전 ${row.version})`);

  // 카페 글이 바뀌어 "📷 캡쳐 n" 자리가 달라졌으면 캡쳐 가이드도 따라 바뀌어야 한다 — 이전 자리를 물고 있으면 안 된다.
  let capture = null;
  if (type === 'cafe' && captureMarkers(latest.content) !== captureMarkers(content)) {
    console.log('카페 캡쳐 자리가 바뀜 → 캡쳐 가이드 갱신 중...');
    try {
      capture = await callClaude({
        model: MODELS.CAPTURE,
        system: COMMON_HEADER,
        prompt: buildCapturePrompt({ cafe: content, concept, course, lectureMap }),
        transcript: job.transcript_full, // 타임스탬프 정확도를 위해 원본 자막
        step: '캡쳐 가이드 갱신',
      });
      await saveContent(jobId, 'capture', capture);
      console.log('캡쳐 가이드 갱신 완료');
    } catch (err) {
      // 카페 수정 자체는 성공했으므로 실패를 통째로 던지지 않고 알림만 넘긴다
      console.error(`캡쳐 가이드 갱신 실패: ${err.message}`);
      return { content, version: row.version, capture: null, captureError: err.message };
    }
  }

  // 캐러셀 후크 채택안이 바뀌었으면 짝꿍 캡션의 첫 두 줄도 같은 갈래로 맞춘다 (사용자가 끄면 건너뜀)
  let captionOut = null;
  let captionError = null;
  let hookChanged = false;
  if (type === 'carousel' && alignCaption) {
    const before = adoptedHook(latest.content);
    const after = adoptedHook(content);
    hookChanged = !!after && (!before || before.key !== after.key || (after.head && before.head !== after.head));
    const captionRow = hookChanged ? await getLatestContent(jobId, 'caption') : null;
    if (hookChanged && captionRow) {
      const hookDesc = `${after.key}안(${after.kind || '갈래 미표기'})${after.head ? ` "${after.head}"` : ''}`;
      console.log(`캐러셀 후크가 ${hookDesc}로 바뀜 → 인스타 캡션 결 맞추기 중...`);
      try {
        const alignInstruction =
          `짝꿍 캐러셀의 1컷 후크가 ${hookDesc}로 바뀌었다. 캡션의 첫 두 줄('…더 보기' 전)을 이 안과 같은 갈래·같은 소재·같은 감정으로 다시 쓰고, ` +
          `바로 이어지는 문단이 그 첫 줄을 자연스럽게 받게 손본다. 새 첫 줄이 꺼낸 이야기를 다음 문단들이 이어받도록 이야기 순서도 맞춘다. ` +
          `자야쌤의 이야기·배움·덤·같이 만들어요·CTA의 내용은 유지하되, 새 첫 줄과 어긋나거나 이음새가 끊기는 문장만 고친다. ` +
          `채택 헤드카피를 그대로 베끼지 않는다.`;
        captionOut = await callClaude({
          model: MODELS.CAPTION,
          system: COMMON_HEADER,
          prompt: buildRevisePrompt({
            type: 'caption',
            original: captionRow.content,
            instruction: alignInstruction,
            voice,
            concept,
            lectureMap,
            course,
            carousel: content,
            lessons: lessons.caption,
          }),
          transcript,
          step: '인스타 캡션 결 맞추기',
        });
        await saveContent(jobId, 'caption', captionOut);
        console.log('인스타 캡션 결 맞추기 완료');
      } catch (err) {
        console.error(`인스타 캡션 결 맞추기 실패: ${err.message}`);
        captionError = err.message;
      }
    }
  }
  return { content, version: row.version, capture, caption: captionOut, captionError, hookChanged };
}

/**
 * 캐러셀·캡쳐 가이드 재생성 — 확정된 cafe·caption 최신 버전을 컨텍스트로 포함.
 * carousel → capture 순서로 재생성 후 저장.
 *
 * @returns {Promise<{carousel: string, capture: string}>}
 */
export async function regenerateSecondary({ jobId }) {
  const step = '캐러셀·캡쳐 재생성';

  const job = await getJob(jobId);
  if (!job) throw new Error(`${step}: 작업(${jobId})을 찾을 수 없습니다.`);

  const cafeRow = await getLatestContent(jobId, 'cafe');
  const captionRow = await getLatestContent(jobId, 'caption');
  if (!cafeRow || !captionRow) {
    throw new Error(`${step}: 확정된 카페 서머리와 인스타 캡션이 모두 필요합니다. 먼저 두 콘텐츠를 생성/수정 완료하세요.`);
  }

  const voice = await loadVoice();
  const concept = await loadConcept(jobId);
  const lectureMap = await ensureLectureMap(job);
  const planMap = lectureMap + (await seriesWhyBlock(job));
  const course = await loadCourse(jobId);
  const lessons = await loadAllLessons();
  const context = { cafe: cafeRow.content, caption: captionRow.content, topic: job.topic || undefined, concept, course };

  console.log('캐러셀 기획 재생성 중...');
  let carousel = await callClaude({
    model: MODELS.CAROUSEL,
    system: COMMON_HEADER,
    prompt: buildRegeneratePrompt({ type: 'carousel', ...context, voice, lectureMap: planMap, lessons: lessons.carousel }),
    transcript: job.transcript_full || job.transcript_compressed,
    step: '캐러셀 기획 재생성',
  });
  carousel = await finalizeCarousel({
    content: carousel, job, voice, cafe: context.cafe, caption: context.caption, concept, lectureMap: planMap, course, lessons: lessons.carousel, label: '캐러셀 기획 재생성',
  });
  await saveContent(jobId, 'carousel', carousel);
  console.log('캐러셀 기획 재생성 완료');

  console.log('캡쳐 가이드 재생성 중...');
  const capture = await callClaude({
    model: MODELS.CAPTURE,
    system: COMMON_HEADER,
    prompt: buildRegeneratePrompt({ type: 'capture', ...context, lectureMap }),
    transcript: job.transcript_full, // 캡쳐는 타임스탬프 정확도를 위해 원본 자막 사용
    step: '캡쳐 가이드 재생성',
  });
  await saveContent(jobId, 'capture', capture);
  console.log('캡쳐 가이드 재생성 완료');

  return { carousel, capture };
}

// ───────────────────────── 손으로 고친 글 저장 (2026-11-17) ─────────────────────────
// 기획안은 대부분 그대로 못 쓰고 고쳐 쓴다. 전에는 화면에서 고칠 수도, 고친 것을 저장할 수도 없어 문서로 옮겨 고친 뒤 그대로 흩어졌다.
// 이제 화면에서 고쳐 저장하면 (1) 새 버전으로 남고 (2) 짝이 따라온다 — 캐러셀을 고치면 캡션이 그 내용에 맞게 다시 써지고,
// 카페 글을 고치면 📷 캡쳐 자리와 캡쳐 가이드가 본문에 맞게 바뀐다 (3) 고친 방향을 배워 다음 기획에 싣는다(lessons.js).

const EDITABLE_TYPES = ['cafe', 'caption', 'carousel', 'capture'];

/** 📷 줄을 뺀 본문 — 캡쳐 자리 말고 본문이 바뀌었는지 볼 때 쓴다 */
function withoutMarkers(text) {
  return String(text || '').split('\n').filter((l) => !l.includes('📷')).map((l) => l.trim()).filter(Boolean).join('\n');
}

/** 캡쳐 자리 맞추기 응답(JSON 배열)을 읽는다. 형식이 깨졌으면 빈 배열 */
export function parseMarkerSync(raw) {
  const m = String(raw || '').match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    return (Array.isArray(arr) ? arr : []).filter((e) => e && typeof e.before === 'string' && typeof e.after === 'string' && e.before.trim());
  } catch {
    return [];
  }
}

/**
 * 모델이 고치자고 한 📷 줄만 카페 글에 끼운다 — 본문은 자야쌤이 고친 그대로 둔다.
 * before가 글 속 📷 줄과 글자 그대로 같을 때만, after가 📷 줄이고 그 시각이 자막에 실제로 있을 때만 바꾼다(빈 after는 그 줄을 지운다).
 * @returns {{ content: string, applied: Array<{ before: string, after: string }> }}
 */
export function applyMarkerSync(cafe, edits, transcript) {
  const lines = String(cafe || '').split('\n');
  const applied = [];
  for (const e of edits) {
    const before = e.before.trim();
    const after = e.after.trim();
    if (!before.includes('📷') || before === after) continue;
    const idx = lines.findIndex((l) => l.trim() === before);
    if (idx < 0) continue;
    if (!after) {
      lines.splice(idx, 1);
      if (lines[idx - 1] !== undefined && lines[idx] !== undefined && !lines[idx - 1].trim() && !lines[idx].trim()) lines.splice(idx, 1); // 빈 줄이 겹치지 않게
      applied.push({ before, after: '' });
      continue;
    }
    const stamp = after.match(/\[((?:\d+강\s*)?\d{1,3}:\d{2})\]/);
    if (!after.includes('📷') || !stamp || !String(transcript || '').includes(`[${stamp[1]}]`)) continue; // 자막에 없는 시각은 받지 않는다
    lines[idx] = lines[idx].replace(before, after);
    applied.push({ before, after });
  }
  return { content: lines.join('\n'), applied };
}

/**
 * 화면에서 손으로 고친 글을 새 버전으로 저장하고, 짝을 맞추고, 고친 방향을 배운다.
 *
 * @param {object} o
 * @param {string} o.jobId
 * @param {'cafe'|'caption'|'carousel'|'capture'} o.type
 * @param {string} o.content 고친 글 전문
 * @param {number} [o.baseVersion] 고치기 시작한 버전(옛 버전을 열어 고쳤을 수 있다). 없으면 최신
 * @param {boolean} [o.alignCaption=true] 캐러셀을 고쳤을 때 캡션도 그 내용에 맞게 다시 쓸지
 * @returns {Promise<{ content: string, version: number, unchanged?: boolean, caption?: string|null, captionError?: string|null,
 *   capture?: string|null, captureError?: string|null, markersMoved?: number, learning?: boolean }>}
 */
export async function saveManualEdit({ jobId, type, content, baseVersion, alignCaption = true }) {
  const step = '직접 수정 저장';
  if (!EDITABLE_TYPES.includes(type)) throw new Error(`${step}: 고칠 수 있는 글이 아닙니다 — ${type}`);
  let text = String(content || '').replace(/\r\n/g, '\n').trim();
  if (!text) throw new Error(`${step}: 내용이 비어 있습니다. 글을 통째로 지우려던 게 아니라면 취소하고 다시 열어 주세요.`);

  const job = await getJob(jobId);
  if (!job) throw new Error(`${step}: 작업(${jobId})을 찾을 수 없습니다.`);
  const rows = (await getContents(jobId)).filter((c) => c.type === type);
  if (rows.length === 0) throw new Error(`${step}: 아직 만들지 않은 ${TYPE_LABELS[type]}입니다. 먼저 생성을 완료하세요.`);
  const latest = rows.reduce((a, b) => (a.version >= b.version ? a : b));
  const base = rows.find((c) => c.version === baseVersion) || latest; // 자야쌤이 고치기 시작한 글 — 무엇을 고쳤는지는 이것과 견준다
  const label = TYPE_LABELS[type];

  if (text === latest.content.trim()) return { content: latest.content, version: latest.version, unchanged: true };

  const edited = text; // 자야쌤이 쓴 그대로 — 배우기는 이 글로 한다(아래에서 코드·모델이 손댄 것은 배우지 않는다)
  if (type === 'carousel') text = normalizeCarouselCuts(text, `${label} 직접 수정`).content; // 컷을 지우거나 보탰으면 개요의 총 컷 수만 맞춘다

  const voice = type === 'carousel' || type === 'cafe' ? await loadVoice() : null;
  const concept = await loadConcept(jobId);
  const course = await loadCourse(jobId);
  const out = { caption: null, captionError: null, capture: null, captureError: null, markersMoved: 0 };

  // ── 카페 글: 본문을 고쳤으면 📷 캡쳐 자리가 아직 본문과 맞는지 보고, 안 맞는 줄만 옮긴다 ──
  if (type === 'cafe' && text.includes('📷') && withoutMarkers(text) !== withoutMarkers(base.content)) {
    console.log('카페 글 직접 수정 → 📷 캡쳐 자리가 본문과 맞는지 확인 중...');
    try {
      const transcript = job.transcript_full || job.transcript_compressed;
      const raw = await callClaude({
        model: MODELS.CAPTURE,
        system: COMMON_HEADER,
        prompt: buildCafeCaptureSyncPrompt({ cafe: text, pairs: editPairs('cafe', withoutMarkers(base.content), withoutMarkers(text)), course }),
        transcript,
        step: '캡쳐 자리 맞추기',
      });
      const synced = applyMarkerSync(text, parseMarkerSync(raw), transcript);
      synced.applied.forEach((e) => console.log(`  ${e.before} → ${e.after || '(지움)'}`));
      text = synced.content;
      out.markersMoved = synced.applied.length;
    } catch (err) {
      // 고친 글 저장이 먼저다 — 캡쳐 자리 확인이 실패해도 글은 저장한다
      console.error(`캡쳐 자리 맞추기 실패: ${err.message}`);
      out.captureError = err.message;
    }
  }

  const row = await saveContent(jobId, type, text);
  console.log(`${label} 직접 수정 저장 (버전 ${row.version})`);

  // ── 카페 글: 📷 자리가 달라졌으면(자야쌤이 옮겼든 위에서 맞췄든) 캡쳐 가이드를 다시 맞춘다 ──
  if (type === 'cafe' && captureMarkers(latest.content) !== captureMarkers(text) && (await getLatestContent(jobId, 'capture'))) {
    console.log('카페 캡쳐 자리가 바뀜 → 캡쳐 가이드 갱신 중...');
    try {
      const lectureMap = course ? await ensureLectureMap(job) : undefined;
      out.capture = await callClaude({
        model: MODELS.CAPTURE,
        system: COMMON_HEADER,
        prompt: buildCapturePrompt({ cafe: text, concept, course, lectureMap }),
        transcript: job.transcript_full,
        step: '캡쳐 가이드 갱신',
      });
      await saveContent(jobId, 'capture', out.capture);
      console.log('캡쳐 가이드 갱신 완료');
    } catch (err) {
      console.error(`캡쳐 가이드 갱신 실패: ${err.message}`);
      out.captureError = err.message;
    }
  }

  // ── 캐러셀: 카드에 찍히는 글이나 후크 채택안을 고쳤으면 짝 캡션을 그 내용에 맞게 다시 쓴다 ──
  if (type === 'carousel' && alignCaption) {
    const cardsBefore = [...cardTextByCut(latest.content).values()].join('\n');
    const cardsAfter = [...cardTextByCut(text).values()].join('\n');
    const hookBefore = adoptedHook(latest.content);
    const hookAfter = adoptedHook(text);
    const changed = cardsBefore !== cardsAfter || hookBefore?.key !== hookAfter?.key;
    const captionRow = changed ? await getLatestContent(jobId, 'caption') : null;
    if (captionRow) {
      console.log('캐러셀 직접 수정 → 인스타 캡션을 고친 내용에 맞추는 중...');
      try {
        const pairs = editPairs('carousel', latest.content, text);
        const lessons = await loadAllLessons();
        const lectureMap = (await ensureLectureMap(job)) + (await seriesWhyBlock(job));
        const instruction =
          '자야쌤이 짝꿍 캐러셀 기획안을 손으로 고쳤다. 이 캡션은 그 카드와 같은 게시물에 실리니, 고친 카드와 어긋나는 곳을 맞춘다.\n' +
          '- 카드에서 뺀 이야기는 캡션에서도 빼고, 카드에 새로 넣은 이야기는 캡션에도 넣는다. 카드에서 바꾼 표현·바꾼 순서를 캡션이 따라간다.\n' +
          '- 자야쌤이 카드에서 고친 말의 방향(더 쉬운 말, 더 짧은 문장 등)이 보이면 캡션도 같은 방향으로 고친다. 캡션은 자야쌤이 직접 말하는 글이라 말투는 캡션의 말투 그대로.\n' +
          '- 1컷 후크가 바뀌었으면 첫 두 줄을 같은 소재·같은 감정으로 다시 쓰고, 이어지는 문단이 그 첫 줄을 받게 손본다. 헤드카피를 그대로 베끼지 않는다.\n' +
          '- 고친 카드와 어긋나지 않는 문단은 그대로 둔다.\n' +
          '[자야쌤이 카드에서 고친 곳]\n' +
          (pairs.map((p, i) => `${i + 1}. ${p.where ? `[${p.where}] ` : ''}전: ${p.before}\n   후: ${p.after}`).join('\n') || '(개요의 후크 채택안을 바꿈)');
        out.caption = await callClaude({
          model: MODELS.CAPTION,
          system: COMMON_HEADER,
          prompt: buildRevisePrompt({
            type: 'caption', original: captionRow.content, instruction, voice, concept, lectureMap, course, carousel: text, lessons: lessons.caption,
          }),
          transcript: job.transcript_full || job.transcript_compressed,
          step: '인스타 캡션 결 맞추기',
        });
        await saveContent(jobId, 'caption', out.caption);
        console.log('인스타 캡션 결 맞추기 완료');
      } catch (err) {
        console.error(`인스타 캡션 결 맞추기 실패: ${err.message}`);
        out.captionError = err.message;
      }
    }
  }

  // ── 고친 방향 배우기 — 응답을 기다리게 하지 않고 뒤에서 돈다 ──
  const learning = LESSON_TYPES.includes(type) && editPairs(type, base.content, edited).length > 0;
  if (learning) learnFromEdit({ type, before: base.content, after: edited }).catch(() => {});

  return { content: text, version: row.version, ...out, learning };
}
