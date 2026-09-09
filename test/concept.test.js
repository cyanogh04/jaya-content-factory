// test/concept.test.js — 기획 컨셉·강의 지도가 첫 생성 뒤의 모든 모델 호출(수정·재생성·컷 수 조정·캡쳐 갱신)에도 실리는지 확인.
// 2026-09-05: 캐러셀 수정(revise)에서 컨셉이 빠지던 버그의 재발 방지.
// 2026-09-09: 강의 지도(lecture_map) 단계 추가 — 작업당 한 번 만들고, 캡션·캐러셀의 첫 생성·수정·재생성 전부가 지도를 싣는지 확인.
// 실행: npm test (모델·비메오·보이스는 가짜로 바꿔 돌린다 — API 호출 없음. 저장은 실제 파일 폴백(outputs/)을 쓰고 끝나면 지운다.)
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const CONCEPT = '컨셉테스트-결잡기-하나로-관통-7f3a';
const MARK = '[기획 컨셉 —';
const MAP_MARK = '[강의 지도 —';

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

test('강의 지도 — 캡션·캐러셀 프롬프트(첫 생성·수정·재생성)에 실리고, 없으면 빈 블록을 끼우지 않는다', () => {
  const MAP = '- 강의 한 줄: 지도테스트-청자켓-원단부터-봉제세팅-3c1d';
  assert.ok(prompts.buildCaptionPrompt({ voice, lectureMap: MAP }).includes(MAP));
  assert.ok(prompts.buildCarouselPrompt({ voice, lectureMap: MAP }).includes(MAP));
  assert.ok(prompts.buildRevisePrompt({ type: 'caption', original: '원본', instruction: '고쳐', voice, lectureMap: MAP }).includes(MAP));
  assert.ok(prompts.buildRevisePrompt({ type: 'carousel', original: '원본', instruction: '고쳐', voice, lectureMap: MAP }).includes(MAP));
  assert.ok(prompts.buildRegeneratePrompt({ type: 'carousel', cafe: '카페', caption: '캡션', voice, lectureMap: MAP }).includes(MAP));
  assert.ok(!prompts.buildCaptionPrompt({ voice }).includes(MAP_MARK));
  assert.ok(!prompts.buildCarouselPrompt({ voice }).includes(MAP_MARK));
  // 카페는 이번 재설계 범위 밖 — 지도를 싣지 않는다
  assert.ok(!prompts.buildRevisePrompt({ type: 'cafe', original: '원본', instruction: '고쳐', voice, lectureMap: MAP }).includes(MAP));
});

test('캐러셀 프롬프트 — 새 역할 구조(문제는 1컷에만, 대상 지목 컷 없음)', () => {
  const p = prompts.buildCarouselPrompt({ voice });
  for (const slug of ['hook', 'promise', 'learn', 'bonus', 'solution', 'result', 'together', 'cta']) {
    assert.ok(p.includes(`${slug}(`), `역할 ${slug}이 프롬프트에 없다`);
  }
  assert.ok(!/역할:\s*audience|audience\(대상 지목\)|urgency\(손실 회피/.test(p), '폐지한 역할(audience·urgency)이 남아 있다');
  for (const kind of prompts.HOOK_KINDS) assert.ok(p.includes(`▸ ${kind}`), `후크 갈래 ${kind} 설명이 없다`);
});

// ── 2. 실제 흐름 (generate.js) — 모델·비메오·보이스만 가짜 ─────────────
const calls = []; // { step, prompt, transcript }
mock.module('../src/anthropic.js', {
  namedExports: {
    MODELS: { VOICE: 'x', CAFE: 'x', CAPTION: 'x', CAROUSEL: 'x', CAPTURE: 'x' },
    callClaude: async ({ step, prompt, transcript }) => {
      calls.push({ step, prompt, transcript });
      if (step === '강의 파악') return `- 강의 한 줄: 가짜 강의 지도 (${step})`;
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
const MAP_TEXT = '가짜 강의 지도';

test('첫 생성 → 수정 → 재생성 전 구간에서 컨셉·강의 지도가 저장되고 매 호출에 실린다', async (t) => {
  assert.ok(!db.isSupabase(), '이 테스트는 파일 폴백(outputs/)으로만 돈다 — .env의 SUPABASE_URL을 비우고 실행');
  const { jobId } = await gen.generateAll({ url: 'https://vimeo.com/test', concept: CONCEPT });
  t.after(async () => {
    await fs.rm(path.join(db.OUTPUTS_DIR, jobId), { recursive: true, force: true });
  });

  // 저장: contents의 'concept'·'lecture_map' 타입으로
  assert.equal(await gen.loadConcept(jobId), CONCEPT);
  assert.ok((await gen.loadLectureMap(jobId))?.includes(MAP_TEXT), '강의 지도가 저장되지 않았다');

  // 강의 파악은 4종보다 먼저, 원본 자막으로, 딱 한 번. 컨셉은 지도에 싣지 않는다(사실 정리에 방향을 섞지 않는다)
  const mapCalls = calls.filter((c) => c.step === '강의 파악');
  assert.equal(mapCalls.length, 1);
  assert.equal(calls[0].step, '강의 파악');
  assert.equal(mapCalls[0].transcript, '원본 자막');
  assert.ok(!mapCalls[0].prompt.includes(CONCEPT));

  // 첫 생성 4종 전부 컨셉 / 캡션·캐러셀은 지도 + 원본 자막, 카페는 압축 자막 그대로
  for (const step of [`${L.cafe} 생성`, `${L.caption} 생성`, `${L.carousel} 생성`, `${L.capture} 생성`]) {
    const list = calls.filter((c) => c.step === step);
    assert.ok(list.length >= 1, `${step} 호출이 없다`);
    assert.ok(list.every((c) => c.prompt.includes(CONCEPT)), `${step}: 첫 생성 프롬프트에 컨셉이 없다`);
  }
  for (const type of ['caption', 'carousel']) {
    const c = calls.find((x) => x.step === `${L[type]} 생성`);
    assert.ok(c.prompt.includes(MAP_TEXT), `${type}: 첫 생성 프롬프트에 강의 지도가 없다`);
    assert.equal(c.transcript, '원본 자막', `${type}: 원본 자막이 아니라 압축 자막을 받았다`);
  }
  assert.equal(calls.find((x) => x.step === `${L.cafe} 생성`).transcript, '압축 자막');

  // 수정: 캐러셀(후크 안 교체가 대표 사례) — 여기서 컨셉이 새고 있었다. 지도는 다시 만들지 않고 저장본을 쓴다
  calls.length = 0;
  await gen.revise({ jobId, type: 'carousel', instruction: 'B안으로 다시 기획', alignCaption: false });
  const carouselRevise = promptsOf(`${L.carousel} 수정`);
  assert.equal(carouselRevise.length, 1);
  assert.ok(carouselRevise[0].includes(CONCEPT), '캐러셀 수정 프롬프트에 컨셉이 없다');
  assert.ok(carouselRevise[0].includes(MAP_TEXT), '캐러셀 수정 프롬프트에 강의 지도가 없다');
  assert.equal(promptsOf('강의 파악').length, 0, '저장된 지도가 있는데 다시 만들었다');

  // 수정: 카페·캡션도 같은 규칙 (캡션은 지도까지)
  for (const type of ['cafe', 'caption']) {
    calls.length = 0;
    await gen.revise({ jobId, type, instruction: '첫 줄만 고쳐' });
    assert.ok(calls.length >= 1 && calls[0].prompt.includes(CONCEPT), `${type} 수정 프롬프트에 컨셉이 없다`);
    assert.equal(calls[0].prompt.includes(MAP_TEXT), type === 'caption', `${type} 수정 프롬프트의 강의 지도 유무가 틀리다`);
  }

  // 재생성(캐러셀·캡쳐)
  calls.length = 0;
  await gen.regenerateSecondary({ jobId });
  assert.ok(promptsOf('캐러셀 기획 재생성')[0]?.includes(CONCEPT), '캐러셀 재생성 프롬프트에 컨셉이 없다');
  assert.ok(promptsOf('캐러셀 기획 재생성')[0]?.includes(MAP_TEXT), '캐러셀 재생성 프롬프트에 강의 지도가 없다');
  assert.ok(promptsOf('캡쳐 가이드 재생성')[0]?.includes(CONCEPT), '캡쳐 재생성 프롬프트에 컨셉이 없다');

  // 전체 다시하기: 새 컨셉이 새 버전으로 저장되고, 그 뒤 수정은 새 컨셉을 따른다. 지도는 사실 정리라 그대로 재사용
  const NEW = '새컨셉-심지-선수축-9b2c';
  calls.length = 0;
  await gen.regenerateAll({ jobId, concept: NEW });
  assert.equal(await gen.loadConcept(jobId), NEW);
  assert.equal(promptsOf('강의 파악').length, 0, '전체 다시하기가 지도를 다시 만들었다');
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

test('강의 지도가 없는 옛 작업은 수정할 때 지도를 만들어 채운다', async (t) => {
  const { jobId } = await gen.generateAll({ url: 'https://vimeo.com/test3' });
  t.after(async () => {
    await fs.rm(path.join(db.OUTPUTS_DIR, jobId), { recursive: true, force: true });
  });
  // 옛 작업 흉내: 저장된 지도를 지운다 (파일 폴백: contents.json에서 lecture_map 항목 제거)
  const dir = path.join(db.OUTPUTS_DIR, jobId);
  const file = path.join(dir, 'contents.json');
  const list = JSON.parse(await fs.readFile(file, 'utf8')).filter((c) => c.type !== gen.LECTURE_MAP_TYPE);
  await fs.writeFile(file, JSON.stringify(list, null, 2), 'utf8');
  assert.equal(await gen.loadLectureMap(jobId), undefined);

  calls.length = 0;
  await gen.revise({ jobId, type: 'caption', instruction: '첫 줄만 고쳐' });
  assert.equal(calls[0].step, '강의 파악', '지도가 없는데 만들지 않았다');
  assert.ok(calls[1].prompt.includes(MAP_TEXT), '방금 만든 지도가 캡션 수정 프롬프트에 실리지 않았다');
  assert.ok((await gen.loadLectureMap(jobId))?.includes(MAP_TEXT), '만든 지도가 저장되지 않았다');
});

// ── 3. 후크 채택안 파서 — 갈래 넷(공감형·참여유도형·반전형·위기형) 전부 읽는다 ─────────────
test('adoptedHook — 새 갈래 이름도 읽고, 헤드카피에서 근거를 떼어낸다', () => {
  const plan = `# 인스타 캐러셀 기획안 — 테스트
## 기획 개요
- **후크 후보**:
  · A안 [공감형] 청자켓, 왜 나만 뻣뻣하게 나올까 → 속마음 인용
  · B안 [반전형] 심지는 답이 아니에요 → 통념 부정, 놀람
  · C안 [위기형] 다음 자켓에서도 거기서 멈춰요 → 서늘함
  · 채택: B안 → 자막 근거가 가장 세다
## CUT 1 — 역할: hook (후킹)
- 헤드카피: 심지는 답이 아니에요`;
  assert.deepEqual(gen.adoptedHook(plan), { key: 'B', kind: '반전형', head: '심지는 답이 아니에요' });
  const c = plan.replace('· 채택: B안', '· 채택: C안');
  assert.deepEqual(gen.adoptedHook(c), { key: 'C', kind: '위기형', head: '다음 자켓에서도 거기서 멈춰요' });
  assert.equal(gen.adoptedHook('후크 후보 없음'), null);
});

test('normalizeCarouselCuts — 개요의 총 컷 수를 실제 CUT 개수로 바로잡는다', () => {
  const plan = ['- **총 컷 수**: 13컷 (…)', ...Array.from({ length: 11 }, (_, i) => `## CUT ${i + 1} — 역할: learn`)].join('\n');
  const r = gen.normalizeCarouselCuts(plan, '테스트');
  assert.equal(r.count, 11);
  assert.ok(r.content.includes('**총 컷 수**: 11컷'));
});
