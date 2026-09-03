// src/generate.js — 4종 순차 생성 오케스트레이션 + 수정(revise: cafe·caption·carousel) + 재생성(regenerateSecondary)
//
// 생성 순서: cafe → caption → carousel → capture
// 자막 사용: cafe·caption·carousel → compressed / capture → full (타임스탬프 정확도)
// 프롬프트 캐싱: 동일 모델·동일 자막 블록이면 캐시 재사용 (anthropic.js가 처리)

import { callClaude, MODELS } from './anthropic.js';
import { getTranscript } from './vimeo.js';
import { load as loadVoice } from './voice.js';
import {
  COMMON_HEADER,
  TYPE_LABELS,
  buildCafePrompt,
  buildCaptionPrompt,
  buildCarouselPrompt,
  buildCapturePrompt,
  buildRevisePrompt,
  buildRegeneratePrompt,
  CAROUSEL_CUT_MIN,
  CAROUSEL_CUT_MAX,
} from './prompts.js';
import { saveJob, saveContent, getJob, getLatestContent } from './db.js';

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
 *
 * @param {object} o
 * @param {string} o.content 모델이 낸 기획안
 * @param {object} o.job 작업 행(transcript_compressed·topic 사용)
 * @param {object} o.voice 보이스 프로파일
 * @param {string} [o.cafe] 확정 카페 서머리(있으면 컨텍스트)
 * @param {string} [o.caption] 확정 인스타 캡션(있으면 컨텍스트)
 * @param {string} o.label 로그 접두어
 * @returns {Promise<string>} 최종 기획안
 */
export async function finalizeCarousel({ content, job, voice, cafe, caption, label }) {
  let { content: fixed, count } = normalizeCarouselCuts(content, label);
  const inRange = (n) => n >= CAROUSEL_CUT_MIN && n <= CAROUSEL_CUT_MAX;
  if (count === 0 || inRange(count)) return fixed;

  const target = count > CAROUSEL_CUT_MAX ? CAROUSEL_CUT_MAX : CAROUSEL_CUT_MIN;
  const how =
    count > CAROUSEL_CUT_MAX
      ? `detail·proof·empathy 구간에서 가장 약한 컷을 버려 ${target}컷으로 줄인다. 버린 detail 항목은 solution 목록의 항목명으로만 남긴다.`
      : `empathy·detail·proof·objection·result 확장 구간에서 자막 근거가 있는 컷을 보태 ${target}컷으로 늘린다. 같은 말을 반복하는 컷은 넣지 않는다.`;
  const instruction =
    `현재 기획안은 총 ${count}컷으로 [컷 수 공통 규칙](${CAROUSEL_CUT_MIN}~${CAROUSEL_CUT_MAX}컷)을 어긴다. ${how} ` +
    `hook·audience·turn·solution·urgency·cta 고정 컷과 역할 순서, 후크 후보, audience/solution 표기 형식은 그대로 두고, ` +
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
      cafe,
      caption,
    }),
    transcript: job.transcript_compressed,
    maxTokens: 16000,
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
function buildSectionSpecs({ voice, topic, concept, compressed, full }) {
  return [
    {
      type: 'cafe',
      model: MODELS.CAFE,
      transcript: compressed,
      prompt: buildCafePrompt({ voice, topic, concept }),
    },
    {
      type: 'caption',
      model: MODELS.CAPTION,
      transcript: compressed,
      prompt: buildCaptionPrompt({ voice, topic, concept }),
    },
    {
      type: 'carousel',
      model: MODELS.CAROUSEL,
      transcript: compressed,
      prompt: buildCarouselPrompt({ voice, topic, concept }),
      maxTokens: 16000, // 장면 지시서 형식이라 출력이 길다 — 잘림 방지
    },
    {
      type: 'capture',
      model: MODELS.CAPTURE,
      transcript: full,
      prompt: buildCapturePrompt({ concept }),
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
  const specs = buildSectionSpecs({
    voice,
    topic,
    concept,
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
      const prompt = spec.type === 'capture' ? buildCapturePrompt({ cafe: results.cafe, concept }) : spec.prompt;
      let content = await callClaude({
        model: spec.model,
        system: COMMON_HEADER,
        prompt,
        transcript: spec.transcript,
        maxTokens: spec.maxTokens || 8000,
        step: `${label} 생성`,
      });
      if (spec.type === 'carousel') {
        content = await finalizeCarousel({ content, job, voice, cafe: results.cafe, caption: results.caption, label });
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

  // 클라이언트에 작업 ID를 즉시 전달 — 콘텐츠 생성 완료 전에도 수정 요청 가능하게 함
  onProgress({ type: 'job_created', jobId: job.id });

  const { results, failed } = await runSections({ job, voice, topic, concept, onProgress });
  return { jobId: job.id, results, failed };
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
 * @returns {Promise<{content: string, version: number}>}
 */
export async function revise({ jobId, type, instruction }) {
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
    prompt: buildRevisePrompt({ type, original: latest.content, instruction, voice, ...extra }),
    transcript: job.transcript_compressed,
    maxTokens: type === 'carousel' ? 16000 : 8000, // 캐러셀은 장면 지시서 형식이라 출력이 길다
    step: `${label} 수정`,
  });
  if (type === 'carousel') {
    content = await finalizeCarousel({ content, job, voice, cafe: extra.cafe, caption: extra.caption, label: `${label} 수정` });
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
        prompt: buildCapturePrompt({ cafe: content }),
        transcript: job.transcript_full, // 타임스탬프 정확도를 위해 원본 자막
        maxTokens: 8000,
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
  return { content, version: row.version, capture };
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
  const context = { cafe: cafeRow.content, caption: captionRow.content, topic: job.topic || undefined };

  console.log('캐러셀 기획 재생성 중...');
  let carousel = await callClaude({
    model: MODELS.CAROUSEL,
    system: COMMON_HEADER,
    prompt: buildRegeneratePrompt({ type: 'carousel', ...context, voice }),
    transcript: job.transcript_compressed,
    maxTokens: 16000,
    step: '캐러셀 기획 재생성',
  });
  carousel = await finalizeCarousel({
    content: carousel, job, voice, cafe: context.cafe, caption: context.caption, label: '캐러셀 기획 재생성',
  });
  await saveContent(jobId, 'carousel', carousel);
  console.log('캐러셀 기획 재생성 완료');

  console.log('캡쳐 가이드 재생성 중...');
  const capture = await callClaude({
    model: MODELS.CAPTURE,
    system: COMMON_HEADER,
    prompt: buildRegeneratePrompt({ type: 'capture', ...context }),
    transcript: job.transcript_full, // 캡쳐는 타임스탬프 정확도를 위해 원본 자막 사용
    maxTokens: 8000,
    step: '캡쳐 가이드 재생성',
  });
  await saveContent(jobId, 'capture', capture);
  console.log('캡쳐 가이드 재생성 완료');

  return { carousel, capture };
}
