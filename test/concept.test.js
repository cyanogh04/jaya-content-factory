// test/concept.test.js — 기획 컨셉이 첫 생성 뒤의 모든 모델 호출(수정·재생성·컷 수 조정·캡쳐 갱신)에도 실리는지 확인.
// 2026-09-05: 캐러셀 수정(revise)에서 컨셉이 빠지던 버그의 재발 방지. 실행: npm test
// (모델·비메오·보이스는 가짜로 바꿔 돌린다 — API 호출 없음. 저장은 실제 파일 폴백(outputs/)을 쓰고 끝나면 지운다.)
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const CONCEPT = '컨셉테스트-결잡기-하나로-관통-7f3a';
const MARK = '[기획 컨셉 —';

// ── 1. 프롬프트 조립 단계 ────────────────────────────────────────
const prompts = await import('../src/prompts.js');
const L = prompts.TYPE_LABELS; // 실제 호출 이름표: 네이버 카페 서머리 / 인스타 캡션 / 인스타 캐러셀 기획 / 캡쳐 가이드
const voice = { tone: '테스트', representative_captions: ['예시 캡션'] };

test('수정(revise) 프롬프트 — cafe·caption·carousel 셋 다 컨셉을 싣는다', () => {
  for (const type of ['cafe', 'caption', 'carousel']) {
    const withConcept = prompts.buildRevisePrompt({ type, original: '원본', instruction: '고쳐', voice, concept: CONCEPT });
    assert.ok(withConcept.includes(CONCEPT), `${type}: 컨셉 문장이 프롬프트에 없다`);
    assert.ok(withConcept.includes(MARK), `${type}: 컨셉 블록 머리말이 없다`);
    const without = prompts.buildRevisePrompt({ type, original: '원본', instruction: '고쳐', voice });
    assert.ok(!without.includes(MARK), `${type}: 컨셉이 없는데 빈 컨셉 블록이 들어갔다`);
  }
});

test('재생성(regenerate) 프롬프트 — 캐러셀·캡쳐 둘 다 컨셉을 싣는다', () => {
  for (const type of ['carousel', 'capture']) {
    const p = prompts.buildRegeneratePrompt({ type, cafe: '카페', caption: '캡션', voice, concept: CONCEPT });
    assert.ok(p.includes(CONCEPT), `${type}: 컨셉 문장이 프롬프트에 없다`);
  }
});

// ── 2. 실제 흐름 (generate.js) — 모델·비메오·보이스만 가짜 ─────────────
const calls = []; // { step, prompt }
mock.module('../src/anthropic.js', {
  namedExports: {
    MODELS: { VOICE: 'x', CAFE: 'x', CAPTION: 'x', CAROUSEL: 'x', CAPTURE: 'x' },
    callClaude: async ({ step, prompt }) => {
      calls.push({ step, prompt });
      return `가짜 결과 (${step})`;
    },
  },
});
mock.module('../src/vimeo.js', {
  namedExports: {
    getTranscript: async () => ({ videoId: 'test-video', title: '테스트 강의', compressed: '압축 자막', full: '원본 자막' }),
  },
});
mock.module('../src/voice.js', { namedExports: { load: async () => voice } });

const gen = await import('../src/generate.js');
const db = await import('../src/db.js');

function promptsOf(step) {
  return calls.filter((c) => c.step === step).map((c) => c.prompt);
}

test('첫 생성 → 수정 → 재생성 전 구간에서 컨셉이 저장되고 매 호출에 실린다', async (t) => {
  assert.ok(!db.isSupabase(), '이 테스트는 파일 폴백(outputs/)으로만 돈다 — .env의 SUPABASE_URL을 비우고 실행');
  const { jobId } = await gen.generateAll({ url: 'https://vimeo.com/test', concept: CONCEPT });
  t.after(async () => {
    await fs.rm(path.join(db.OUTPUTS_DIR, jobId), { recursive: true, force: true });
  });

  // 저장: contents의 'concept' 타입으로
  assert.equal(await gen.loadConcept(jobId), CONCEPT);
  // 첫 생성 4종 전부
  for (const step of [`${L.cafe} 생성`, `${L.caption} 생성`, `${L.carousel} 생성`, `${L.capture} 생성`]) {
    const list = calls.filter((c) => c.step === step);
    assert.ok(list.length >= 1, `${step} 호출이 없다`);
    assert.ok(list.every((c) => c.prompt.includes(CONCEPT)), `${step}: 첫 생성 프롬프트에 컨셉이 없다`);
  }

  // 수정: 캐러셀(후크 안 교체가 대표 사례) — 여기서 컨셉이 새고 있었다
  calls.length = 0;
  await gen.revise({ jobId, type: 'carousel', instruction: 'B안으로 다시 기획', alignCaption: false });
  const carouselRevise = promptsOf(`${L.carousel} 수정`);
  assert.equal(carouselRevise.length, 1);
  assert.ok(carouselRevise[0].includes(CONCEPT), '캐러셀 수정 프롬프트에 컨셉이 없다');

  // 수정: 카페·캡션도 같은 규칙
  for (const type of ['cafe', 'caption']) {
    calls.length = 0;
    await gen.revise({ jobId, type, instruction: '첫 줄만 고쳐' });
    assert.ok(calls.length >= 1 && calls[0].prompt.includes(CONCEPT), `${type} 수정 프롬프트에 컨셉이 없다`);
  }

  // 재생성(캐러셀·캡쳐)
  calls.length = 0;
  await gen.regenerateSecondary({ jobId });
  assert.ok(promptsOf('캐러셀 기획 재생성')[0]?.includes(CONCEPT), '캐러셀 재생성 프롬프트에 컨셉이 없다');
  assert.ok(promptsOf('캡쳐 가이드 재생성')[0]?.includes(CONCEPT), '캡쳐 재생성 프롬프트에 컨셉이 없다');

  // 전체 다시하기: 새 컨셉이 새 버전으로 저장되고, 그 뒤 수정은 새 컨셉을 따른다
  const NEW = '새컨셉-심지-선수축-9b2c';
  calls.length = 0;
  await gen.regenerateAll({ jobId, concept: NEW });
  assert.equal(await gen.loadConcept(jobId), NEW);
  assert.ok(calls.every((c) => c.prompt.includes(NEW)), '전체 다시하기 프롬프트에 새 컨셉이 없다');
  calls.length = 0;
  await gen.revise({ jobId, type: 'carousel', instruction: 'C안으로', alignCaption: false });
  const p = promptsOf(`${L.carousel} 수정`)[0];
  assert.ok(p.includes(NEW) && !p.includes(CONCEPT), '수정이 옛 컨셉을 물고 있다');
});

test('컨셉 없이 만든 작업은 컨셉 블록 없이 돈다 (빈 블록을 끼워 넣지 않는다)', async (t) => {
  const { jobId } = await gen.generateAll({ url: 'https://vimeo.com/test2' });
  t.after(async () => {
    await fs.rm(path.join(db.OUTPUTS_DIR, jobId), { recursive: true, force: true });
  });
  assert.equal(await gen.loadConcept(jobId), undefined);
  calls.length = 0;
  await gen.revise({ jobId, type: 'carousel', instruction: 'B안으로', alignCaption: false });
  assert.ok(!promptsOf(`${L.carousel} 수정`)[0].includes(MARK));
});
