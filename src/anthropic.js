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
//   전부 한 모델 — 모델이 하나라 자막 캐시 블록이 지도·4종 호출 전부에서 재사용된다.
//   2026-09-04 캐러셀·캡쳐도 sonnet-4-6 → opus-4-8로 올림(기획 품질 우선). 2026-11-04 opus-4-8 → opus-5-5
//   (후속 모델이고 더 싸다: 입력 $4/출력 $20 per 1M vs $5/$25). 모델 ID는 코드에 박혀 있어 저절로 바뀌지 않는다 —
//   새 모델이 나오면 .env의 CLAUDE_MODEL(Render 환경변수)로 배포 없이 바꾸거나 아래 기본값을 올린다.
//   CLAUDE_MODEL=auto 면 서버가 켜질 때 모델 목록 API에서 가장 새 Opus를 골라 쓴다(resolveModel).
//   고정 모드에서도 켜질 때 목록을 한 번 보고, 더 새 Opus가 있으면 화면 상태줄에 알린다(저절로 바꾸지는 않는다 —
//   세대가 바뀌면 API 규칙·값·글 결이 같이 바뀔 수 있어 한 강 돌려 보고 바꾸는 게 안전하다).
// 사고 깊이 — Opus 5.5는 사고(thinking)가 항상 켜져 있고 effort로만 조절한다(기본 medium).
// 기획·글쓰기라 high로 둔다. CLAUDE_EFFORT=low|medium|high|xhigh|max 로 바꿀 수 있다.
const EFFORT = process.env.CLAUDE_EFFORT || 'high';

export const PINNED_MODEL = 'claude-opus-5-5';
const CONFIGURED_MODEL = (process.env.CLAUDE_MODEL || '').trim() || PINNED_MODEL;
let activeModel = CONFIGURED_MODEL === 'auto' ? PINNED_MODEL : CONFIGURED_MODEL;
export const MODELS = {
  get VOICE() { return activeModel; },
  get CAFE() { return activeModel; },
  get CAPTION() { return activeModel; },
  get CAROUSEL() { return activeModel; },
  get CAPTURE() { return activeModel; },
};

/** 모델 목록 API에서 받은 모델들 중 가장 새 Opus — 없으면 null. (Fable·Sonnet은 값·용도가 달라 후보에 넣지 않는다) */
export function latestOpus(models) {
  const opus = (models || []).filter((m) => typeof m?.id === 'string' && /^claude-opus-\d/.test(m.id) && m.created_at);
  if (opus.length === 0) return null;
  return opus.reduce((a, b) => (new Date(b.created_at) > new Date(a.created_at) ? b : a));
}

/**
 * 설정과 모델 목록으로 "무엇을 쓸지·알릴 것이 있는지"를 정한다 — 순수 함수(테스트용).
 * @returns {{ model: string, mode: 'auto'|'pinned', latest: object|null, newer: object|null }}
 *   newer: 고정 모드에서 지금 쓰는 것보다 새 Opus가 있으면 그 모델(알림용), 아니면 null
 */
export function pickModel({ configured, models }) {
  const latest = latestOpus(models);
  if (configured === 'auto') {
    return { model: latest?.id || PINNED_MODEL, mode: 'auto', latest, newer: null };
  }
  const current = (models || []).find((m) => m.id === configured);
  const newer =
    latest && latest.id !== configured && (!current?.created_at || new Date(latest.created_at) > new Date(current.created_at))
      ? latest
      : null;
  return { model: configured, mode: 'pinned', latest, newer };
}

let modelStatus = { model: activeModel, mode: CONFIGURED_MODEL === 'auto' ? 'auto' : 'pinned', latest: null, newer: null, checked: false, error: null };

/** 지금 쓰는 모델·모드·새 모델 알림 — /api/status가 화면에 내려 준다 (모델 객체는 id·이름·날짜만) */
export function getModelStatus() {
  const lite = (m) => (m ? { id: m.id, display_name: m.display_name, created_at: m.created_at } : null);
  return { ...modelStatus, latest: lite(modelStatus.latest), newer: lite(modelStatus.newer), effort: EFFORT };
}

/**
 * 서버 시작 때 한 번 — 모델 목록 API(토큰 0)를 보고 auto면 가장 새 Opus로 바꾸고, 고정이면 새 Opus가 있는지만 적어 둔다.
 * 목록 조회가 실패해도 생성은 막지 않는다(설정된 모델 그대로).
 */
export async function resolveModel() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return getModelStatus();
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': API_VERSION },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { data } = await res.json();
    const picked = pickModel({ configured: CONFIGURED_MODEL, models: data });
    activeModel = picked.model;
    modelStatus = { ...picked, checked: true, error: null };
    if (picked.mode === 'auto') console.log(`모델: 자동 선택 — 가장 새 Opus ${picked.model} (${picked.latest?.created_at?.slice(0, 10) || '날짜 미상'})`);
    else if (picked.newer) console.log(`모델: ${picked.model} 사용 중 — 더 새 Opus ${picked.newer.id}(${picked.newer.created_at.slice(0, 10)})가 있습니다. CLAUDE_MODEL로 바꿀 수 있어요.`);
    else console.log(`모델: ${picked.model} (가장 새 Opus)`);
  } catch (err) {
    modelStatus = { ...modelStatus, checked: false, error: err.message };
    console.warn(`모델 목록 조회 실패(${err.message}) — 설정된 모델 ${activeModel} 그대로 씁니다.`);
  }
  return getModelStatus();
}

/**
 * Claude 호출.
 * @param {object} opts
 * @param {string} opts.model      - 모델 ID
 * @param {string} [opts.system]   - system 프롬프트 (공통 헤더)
 * @param {string} opts.prompt     - 작업 지시 프롬프트 (user 메시지의 마지막 블록)
 * @param {string} [opts.transcript] - 자막 텍스트. 있으면 캐시 블록으로 분리 삽입.
 * @param {number} [opts.maxTokens]  - 기본 8000 (한국어 출력이 길어 4000 이상 권장)
 * @param {number} [opts.timeoutMs]  - 응답 대기 한도. 미지정 시 maxTokens에 비례해 자동 산정.
 *                                     (캐러셀처럼 maxTokens 16000짜리 호출은 120초로는 모자란다)
 * @param {string} [opts.step]       - 에러 메시지에 붙일 단계명
 * @returns {Promise<string>} 응답 텍스트
 */
export async function callClaude({ model, system, prompt, transcript, maxTokens = 8000, timeoutMs, step = 'Claude 생성' }) {
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
    output_config: { effort: EFFORT },
    messages: [{ role: 'user', content }],
  };
  if (system) {
    body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  }

  // 출력이 길수록 오래 걸린다. 대략 1000 토큰당 20초 + 여유 60초, 최소 120초.
  const limitMs = timeoutMs ?? Math.max(120_000, 60_000 + (maxTokens / 1000) * 20_000);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), limitMs);

  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error(`${step}: Anthropic API 응답 시간 초과 (${Math.round(limitMs / 1000)}초). 잠시 후 다시 시도하세요.`);
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
