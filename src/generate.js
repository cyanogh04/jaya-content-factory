// src/generate.js — 4종 순차 생성 오케스트레이션 + 수정(revise) + 재생성(regenerateSecondary)
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
} from './prompts.js';
import { saveJob, saveContent, getJob, getLatestContent } from './db.js';

/** 섹션별 호출 사양 구성 */
function buildSectionSpecs({ voice, topic, compressed, full }) {
  return [
    {
      type: 'cafe',
      model: MODELS.CAFE,
      transcript: compressed,
      prompt: buildCafePrompt({ voice, topic }),
    },
    {
      type: 'caption',
      model: MODELS.CAPTION,
      transcript: compressed,
      prompt: buildCaptionPrompt({ voice, topic }),
    },
    {
      type: 'carousel',
      model: MODELS.CAROUSEL,
      transcript: compressed,
      prompt: buildCarouselPrompt({ voice, topic }),
      maxTokens: 16000, // 장면 지시서 형식이라 출력이 길다 — 잘림 방지
    },
    {
      type: 'capture',
      model: MODELS.CAPTURE,
      transcript: full,
      prompt: buildCapturePrompt(),
    },
  ];
}

/**
 * 메인 플로우: URL → 자막 수집 → 4종 순차 생성.
 * 각 섹션 완료(또는 실패) 시 onProgress 콜백 호출. 한 섹션이 실패해도 다음 섹션은 계속 진행.
 *
 * @param {object} opts
 * @param {string} opts.url - 비메오 URL
 * @param {string} [opts.topic] - 강의 주제 (선택)
 * @param {(payload: {type: string, content?: string, error?: string}) => void} opts.onProgress
 * @returns {Promise<{jobId: string, results: object, failed: string[]}>}
 */
export async function generateAll({ url, topic, onProgress = () => {} }) {
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

  const specs = buildSectionSpecs({
    voice,
    topic,
    compressed: transcript.compressed,
    full: transcript.full,
  });

  const results = {};
  const failed = [];

  for (const spec of specs) {
    const label = TYPE_LABELS[spec.type];
    console.log(`${label} 생성 중...`);
    try {
      const content = await callClaude({
        model: spec.model,
        system: COMMON_HEADER,
        prompt: spec.prompt,
        transcript: spec.transcript,
        maxTokens: spec.maxTokens || 8000,
        step: `${label} 생성`,
      });
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

  return { jobId: job.id, results, failed };
}

/**
 * 개별 수정 재생성 — 카페 서머리('cafe') 또는 인스타 캡션('caption')만 가능.
 * 원본 내용 + 수정 지시 + 보이스 + 자막 기반으로 해당 섹션만 재생성 후 새 버전 저장.
 *
 * @returns {Promise<{content: string, version: number}>}
 */
export async function revise({ jobId, type, instruction }) {
  const step = '수정 재생성';
  if (type !== 'cafe' && type !== 'caption') {
    throw new Error(`${step}: 수정은 카페 서머리(cafe)와 인스타 캡션(caption)만 가능합니다 — 요청 타입: ${type}`);
  }
  if (!instruction || !instruction.trim()) {
    throw new Error(`${step}: 수정 지시가 비어 있습니다.`);
  }

  const job = await getJob(jobId);
  if (!job) throw new Error(`${step}: 작업(${jobId})을 찾을 수 없습니다.`);

  const latest = await getLatestContent(jobId, type);
  if (!latest) throw new Error(`${step}: 수정할 ${TYPE_LABELS[type]} 원본이 없습니다. 먼저 생성을 완료하세요.`);

  const voice = await loadVoice();

  const label = TYPE_LABELS[type];
  console.log(`${label} 수정 재생성 중... (지시: ${instruction.slice(0, 50)})`);
  const content = await callClaude({
    model: type === 'cafe' ? MODELS.CAFE : MODELS.CAPTION,
    system: COMMON_HEADER,
    prompt: buildRevisePrompt({ type, original: latest.content, instruction, voice }),
    transcript: job.transcript_compressed,
    maxTokens: 8000,
    step: `${label} 수정`,
  });

  const row = await saveContent(jobId, type, content);
  console.log(`${label} 수정 완료 (버전 ${row.version})`);
  return { content, version: row.version };
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
  const carousel = await callClaude({
    model: MODELS.CAROUSEL,
    system: COMMON_HEADER,
    prompt: buildRegeneratePrompt({ type: 'carousel', ...context, voice }),
    transcript: job.transcript_compressed,
    maxTokens: 16000,
    step: '캐러셀 기획 재생성',
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
