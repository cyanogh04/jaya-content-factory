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

// 출력 한도(max_tokens) — **사고(thinking) + 본문**을 합친 한도다. Opus 5.5는 사고를 끌 수 없고(effort로만 조절),
// 사고에 쓴 토큰도 이 한도에서 빠진다. 2026-11-04에 모델을 올리면서 한도는 본문 길이에 맞춘 4000~16000 그대로 둬서,
// 사고가 길어진 호출은 본문이 중간에 끊긴 채 저장됐다(2026-11-11·11-16 — 강의 지도·카페 글·캐러셀. 끊긴 강의 지도는
// 그 뒤 기획에도 계속 실렸다). 한도는 "넘으면 자르는 선"일 뿐 모델에게 보이지 않고 요금은 실제로 쓴 토큰만 내므로
// 넉넉히 한 값으로 둔다. 이만큼 길면 한 번에 받는 요청은 응답 대기 시간 제한에 걸리므로 스트리밍으로 받는다.
export const MAX_OUTPUT_TOKENS = 64000;
const IDLE_TIMEOUT_MS = 180_000; // 스트림에서 이만큼 아무것도 안 오면 끊긴 것으로 본다(사고 중에도 ping은 온다)
const TOTAL_TIMEOUT_MS = 20 * 60_000;

/**
 * 스트리밍 응답(SSE)을 끝까지 읽어 한 메시지로 모은다 — 본문 텍스트·끝난 이유·토큰 사용량.
 * @param {Response} res
 * @param {() => void} onActivity 조각이 올 때마다 부른다(무응답 타이머 초기화)
 * @returns {Promise<{ text: string, stopReason: string|null, finished: boolean, usage: object }>}
 */
async function readMessageStream(res, onActivity) {
  const texts = []; // content block index → 텍스트 (사고 블록은 모으지 않는다)
  const out = { stopReason: null, finished: false, usage: {} };

  const handle = (rawEvent) => {
    const data = rawEvent
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    let ev;
    try {
      ev = JSON.parse(data);
    } catch {
      return; // 형식이 깨진 조각은 건너뛴다 — 본문이 빠졌으면 아래 '끝까지 받았는지' 검사에서 드러난다
    }
    if (ev.type === 'message_start') {
      Object.assign(out.usage, ev.message?.usage || {});
    } else if (ev.type === 'content_block_start') {
      if (ev.content_block?.type === 'text') texts[ev.index] = ev.content_block.text || '';
    } else if (ev.type === 'content_block_delta') {
      if (ev.delta?.type === 'text_delta') texts[ev.index] = (texts[ev.index] || '') + ev.delta.text;
    } else if (ev.type === 'message_delta') {
      if (ev.delta?.stop_reason) out.stopReason = ev.delta.stop_reason;
      Object.assign(out.usage, ev.usage || {});
    } else if (ev.type === 'message_stop') {
      out.finished = true;
    } else if (ev.type === 'error') {
      const err = new Error(ev.error?.message || '알 수 없는 오류');
      err.streamErrorType = ev.error?.type || 'error';
      throw err;
    }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onActivity();
    buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
    let cut;
    while ((cut = buf.indexOf('\n\n')) !== -1) {
      handle(buf.slice(0, cut));
      buf = buf.slice(cut + 2);
    }
  }
  if (buf.trim()) handle(buf);

  const text = texts.filter((t) => typeof t === 'string').join('\n').trim();
  return { text, ...out };
}

/**
 * Claude 호출 — 스트리밍으로 받아 끝까지 온 글만 돌려준다. 중간에 끊긴 글(출력 한도 도달·연결 끊김)은
 * 돌려주지 않고 오류로 던진다 — 끊긴 글이 완성본처럼 저장되면 안 된다.
 * @param {object} opts
 * @param {string} opts.model      - 모델 ID
 * @param {string} [opts.system]   - system 프롬프트 (공통 헤더)
 * @param {string} opts.prompt     - 작업 지시 프롬프트 (user 메시지의 마지막 블록)
 * @param {string} [opts.transcript] - 자막 텍스트. 있으면 캐시 블록으로 분리 삽입.
 * @param {number} [opts.maxTokens]  - 사고 + 본문 합계 한도. 기본 MAX_OUTPUT_TOKENS — 본문 길이에 맞춰 줄이지 않는다.
 * @param {number} [opts.timeoutMs]  - 전체 대기 한도(기본 20분). 이와 별개로 3분 동안 아무것도 안 오면 끊는다.
 * @param {string} [opts.step]       - 에러 메시지에 붙일 단계명
 * @returns {Promise<string>} 응답 텍스트
 */
export async function callClaude({ model, system, prompt, transcript, maxTokens = MAX_OUTPUT_TOKENS, timeoutMs = TOTAL_TIMEOUT_MS, step = 'Claude 생성' }) {
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
    stream: true,
    output_config: { effort: EFFORT },
    messages: [{ role: 'user', content }],
  };
  if (system) {
    body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  }

  // 시간 제한 둘: 전체 한도(timeoutMs)와 무응답 한도(조각이 올 때마다 다시 잰다)
  const controller = new AbortController();
  let timedOut = null;
  const abortWith = (why) => () => { timedOut = why; controller.abort(); };
  const idleWhy = `${IDLE_TIMEOUT_MS / 1000}초 동안 무응답`;
  const totalTimer = setTimeout(abortWith(`전체 ${Math.round(timeoutMs / 1000)}초`), timeoutMs);
  let idleTimer = setTimeout(abortWith(idleWhy), IDLE_TIMEOUT_MS);
  const onActivity = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(abortWith(idleWhy), IDLE_TIMEOUT_MS);
  };
  const stopTimers = () => { clearTimeout(totalTimer); clearTimeout(idleTimer); };
  const timeoutError = () => new Error(`${step}: Anthropic API 응답 시간 초과 (${timedOut}). 잠시 후 다시 시도하세요.`);

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
    stopTimers();
    if (timedOut) throw timeoutError();
    throw new Error(`${step}: Anthropic API 네트워크 오류 — ${err.message}`);
  }

  if (!res.ok) {
    stopTimers();
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

  let data;
  try {
    data = await readMessageStream(res, onActivity);
  } catch (err) {
    if (timedOut) throw timeoutError();
    if (err.streamErrorType) {
      throw new Error(`${step}: Anthropic API가 응답 도중 오류를 보냈습니다 (${err.streamErrorType}) — ${err.message}. 잠시 후 다시 시도하세요.`);
    }
    throw new Error(`${step}: 응답을 받는 도중 연결이 끊겼습니다 — ${err.message}. 잠시 후 다시 시도하세요.`);
  } finally {
    stopTimers();
  }

  // 캐시 동작·사고 분량 확인용 로그 — '출력'에는 사고 토큰이 들어 있다(본문 글자 수와 견주면 사고에 얼마 썼는지 보인다)
  const usage = data.usage;
  console.log(
    `  [${step}] 토큰 — 입력 ${usage.input_tokens ?? 0}` +
    `, 캐시생성 ${usage.cache_creation_input_tokens ?? 0}` +
    `, 캐시읽기 ${usage.cache_read_input_tokens ?? 0}` +
    `, 출력 ${usage.output_tokens ?? 0}(사고 포함) / 본문 ${data.text.length}자`
  );

  if (data.stopReason === 'refusal') {
    throw new Error(`${step}: 모델이 요청을 거절했습니다 (stop_reason: refusal). 입력 내용을 확인하세요.`);
  }
  if (data.stopReason === 'max_tokens') {
    throw new Error(
      `${step}: 글이 출력 한도(${maxTokens}토큰, 사고 포함)에 닿아 중간에 끊겼습니다 — 끊긴 글은 저장하지 않았습니다. 다시 시도해 주세요.`
    );
  }
  if (!data.finished || !data.stopReason) {
    throw new Error(`${step}: 응답이 끝까지 오지 않았습니다(중간에 끊김) — 끊긴 글은 저장하지 않았습니다. 다시 시도해 주세요.`);
  }
  if (!data.text) {
    throw new Error(`${step}: Anthropic 응답에 텍스트가 없습니다 (stop_reason: ${data.stopReason}).`);
  }
  return data.text;
}
