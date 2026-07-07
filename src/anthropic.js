// src/anthropic.js — Anthropic Messages API 래퍼 (Node 18+ 내장 fetch, 프롬프트 캐싱 지원)
//
// 프롬프트 캐싱 전략:
//   - 자막(transcript)은 user 메시지의 마지막 content 블록 "직전"에 별도 블록으로 넣고
//     cache_control: {type: "ephemeral"} 을 적용한다.
//   - system(공통 헤더)과 자막 블록이 바이트 단위로 동일하면 같은 모델의 다음 호출에서
//     캐시가 읽혀 자막 입력 토큰이 재과금되지 않는다 (4종 순차 호출 시 절감).

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

// 모델 선택 (CLAUDE.md 기준):
//   말투가 중요한 섹션(cafe, caption, voice) → opus / 구조 위주(carousel, capture) → sonnet
export const MODELS = {
  VOICE: 'claude-opus-4-8',
  CAFE: 'claude-opus-4-8',
  CAPTION: 'claude-opus-4-8',
  CAROUSEL: 'claude-sonnet-4-6',
  CAPTURE: 'claude-sonnet-4-6',
};

/**
 * Claude 호출.
 * @param {object} opts
 * @param {string} opts.model      - 모델 ID
 * @param {string} [opts.system]   - system 프롬프트 (공통 헤더)
 * @param {string} opts.prompt     - 작업 지시 프롬프트 (user 메시지의 마지막 블록)
 * @param {string} [opts.transcript] - 자막 텍스트. 있으면 캐시 블록으로 분리 삽입.
 * @param {number} [opts.maxTokens]  - 기본 8000 (한국어 출력이 길어 4000 이상 권장)
 * @param {string} [opts.step]       - 에러 메시지에 붙일 단계명
 * @returns {Promise<string>} 응답 텍스트
 */
export async function callClaude({ model, system, prompt, transcript, maxTokens = 8000, step = 'Claude 생성' }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(`${step}: ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다. .env 파일을 확인하세요.`);
  }

  // user content 블록 구성: [자막(캐시), 작업 지시] — 자막 블록이 마지막 블록 직전에 위치
  const content = [];
  if (transcript) {
    content.push({
      type: 'text',
      text: `[강의 자막]\n${transcript}`,
      cache_control: { type: 'ephemeral' },
    });
  }
  content.push({ type: 'text', text: prompt });

  const body = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content }],
  };
  if (system) {
    body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error(`${step}: Anthropic API 응답 시간 초과 (120초). 잠시 후 다시 시도하세요.`);
    }
    throw new Error(`${step}: Anthropic API 네트워크 오류 — ${err.message}`);
  }
  clearTimeout(timeout);

  if (!res.ok) {
    let detail = '';
    try {
      const errJson = await res.json();
      detail = errJson?.error?.message ? ` — ${errJson.error.message}` : '';
    } catch {
      /* 본문 파싱 실패 시 상태코드만 표시 */
    }
    if (res.status === 401) {
      throw new Error(`${step}: Anthropic API 인증 실패 (HTTP 401). ANTHROPIC_API_KEY가 올바른지 확인하세요.${detail}`);
    }
    if (res.status === 429) {
      throw new Error(`${step}: Anthropic API 요청 한도 초과 (HTTP 429). 잠시 후 다시 시도하세요.${detail}`);
    }
    if (res.status >= 500) {
      throw new Error(`${step}: Anthropic API 서버 오류 (HTTP ${res.status}). 잠시 후 다시 시도하세요.${detail}`);
    }
    throw new Error(`${step}: Anthropic API 오류 (HTTP ${res.status})${detail}`);
  }

  const data = await res.json();

  // 캐시 동작 확인용 로그 (토큰 절감 검증)
  const usage = data.usage || {};
  console.log(
    `  [${step}] 토큰 — 입력 ${usage.input_tokens ?? 0}` +
    `, 캐시생성 ${usage.cache_creation_input_tokens ?? 0}` +
    `, 캐시읽기 ${usage.cache_read_input_tokens ?? 0}` +
    `, 출력 ${usage.output_tokens ?? 0}`
  );

  if (data.stop_reason === 'refusal') {
    throw new Error(`${step}: 모델이 요청을 거절했습니다 (stop_reason: refusal). 입력 내용을 확인하세요.`);
  }
  if (data.stop_reason === 'max_tokens') {
    console.warn(`  [${step}] 경고: 출력이 max_tokens(${maxTokens})에 도달해 잘렸을 수 있습니다.`);
  }

  const text = (data.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  if (!text) {
    throw new Error(`${step}: Anthropic 응답에 텍스트가 없습니다 (stop_reason: ${data.stop_reason}).`);
  }
  return text;
}
