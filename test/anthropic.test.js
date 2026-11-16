// test/anthropic.test.js — callClaude: 끝까지 온 글만 돌려주고, 중간에 끊긴 글은 오류로 던진다.
// 2026-11-16: 모델을 Opus 5.5로 올린 뒤(사고가 항상 켜짐) 출력 한도(max_tokens)가 본문 길이에 맞춘 4000~16000 그대로라
// 사고 토큰이 한도를 먹어 카페 글·캐러셀·강의 지도가 중간에 끊긴 채 저장됐다. 끊겨도 경고 로그만 남기고 그대로 저장한 것이 문제였다.
// 실제 API를 부르지 않는다 — fetch를 가짜로 바꿔 스트리밍 응답(SSE)을 흘려 준다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = 'test-key';
const { callClaude, MAX_OUTPUT_TOKENS } = await import('../src/anthropic.js');

const sse = (ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;

/** 사고 블록 하나 + 본문 블록 하나짜리 스트림. stopReason이 null이면 끝맺음 없이 끊긴 스트림 */
function messageEvents({ text, stopReason = 'end_turn', outputTokens = 1234 }) {
  const half = Math.ceil(text.length / 2);
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 500, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '사고는 본문에 섞이면 안 된다' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'ping' },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: text.slice(0, half) } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: text.slice(half) } },
    { type: 'content_block_stop', index: 1 },
  ];
  if (stopReason) {
    events.push({ type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: outputTokens } });
    events.push({ type: 'message_stop' });
  }
  return events;
}

/** fetch를 가짜로 바꾼다 — 이벤트를 chunkSize 바이트씩 잘라 흘려 준다(한글·이벤트 경계가 조각 사이에 걸리게) */
function fakeFetch(t, events, { chunkSize = 7, status = 200 } = {}) {
  const requests = [];
  const bytes = new TextEncoder().encode(events.map(sse).join(''));
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    const body = new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
        controller.close();
      },
    });
    return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
  });
  return requests;
}

const CAFE = '코트 완성하기 — 디바예요.\n자야쌤이 이번에 5강을 올리셨어요.\n[소잉클래스 수강 신청하기]http://www.sewingclass.co.kr';

test('끝까지 온 글은 조각을 이어 그대로 돌려준다 — 사고는 섞이지 않고, 스트리밍·넉넉한 한도로 요청한다', async (t) => {
  const requests = fakeFetch(t, messageEvents({ text: CAFE }));
  const out = await callClaude({ model: 'claude-opus-5-5', system: '헤더', prompt: '써 줘', transcript: '자막', step: '테스트' });
  assert.equal(out, CAFE);

  const body = requests[0].body;
  assert.equal(body.stream, true, '스트리밍으로 요청하지 않았다 — 긴 응답은 대기 시간 제한에 걸린다');
  assert.equal(body.max_tokens, MAX_OUTPUT_TOKENS);
  // 사고 + 본문 합계 한도다. 예전 값(4000~16000)으로 돌아가면 사고가 한도를 먹어 본문이 끊긴다
  assert.ok(body.max_tokens >= 32000, `출력 한도가 너무 낮다(${body.max_tokens}) — 사고 토큰이 본문 자리를 먹는다`);
  assert.equal(body.thinking, undefined, 'Opus 5.5는 thinking을 보내면 안 된다(끄면 400)');
  assert.equal(body.messages[0].content[0].cache_control?.type, 'ephemeral', '자막 캐시 블록이 사라졌다');
});

test('조각 크기가 달라도(1바이트씩·통째로) 같은 글이 나온다', async (t) => {
  for (const chunkSize of [1, 3, 100000]) {
    fakeFetch(t, messageEvents({ text: CAFE }), { chunkSize });
    assert.equal(await callClaude({ model: 'x', prompt: 'p', step: '테스트' }), CAFE, `chunkSize ${chunkSize}`);
    t.mock.restoreAll();
  }
});

test('출력 한도에 닿아 끊긴 글은 돌려주지 않고 오류로 던진다', async (t) => {
  fakeFetch(t, messageEvents({ text: CAFE.slice(0, 40), stopReason: 'max_tokens' }));
  await assert.rejects(
    callClaude({ model: 'x', prompt: 'p', step: '네이버 카페 서머리 생성' }),
    (err) => /네이버 카페 서머리 생성/.test(err.message) && /끊겼습니다/.test(err.message),
  );
});

test('끝맺음 없이 연결이 끊긴 스트림도 오류다 — 받은 데까지를 완성본처럼 돌려주지 않는다', async (t) => {
  fakeFetch(t, messageEvents({ text: CAFE.slice(0, 40), stopReason: null }));
  await assert.rejects(callClaude({ model: 'x', prompt: 'p', step: '테스트' }), /끝까지 오지 않았습니다/);
});

test('응답 도중 API가 보낸 오류(과부하 등)는 원인과 함께 던진다', async (t) => {
  const events = messageEvents({ text: CAFE, stopReason: null });
  events.push({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
  fakeFetch(t, events);
  await assert.rejects(callClaude({ model: 'x', prompt: 'p', step: '테스트' }), /overloaded_error/);
});

test('거절(refusal)과 HTTP 오류는 이전처럼 단계 이름과 함께 던진다', async (t) => {
  fakeFetch(t, messageEvents({ text: '', stopReason: 'refusal' }));
  await assert.rejects(callClaude({ model: 'x', prompt: 'p', step: '테스트' }), /refusal/);
  t.mock.restoreAll();

  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 }));
  await assert.rejects(callClaude({ model: 'x', prompt: 'p', step: '테스트' }), /HTTP 429.*rate limited/);
});
