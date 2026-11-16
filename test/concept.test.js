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

// 2026-10-09: 결과물이 "무서워하는 그 지퍼", "오늘 그 걱정", "이 한 강"처럼 영어 어순·번역투 조각이라 매번 손으로 고쳤고,
// 헤드카피끼리·캡션 문단끼리 이어지지 않았다. 어순 규칙이 세 글에 실리는지, 프롬프트 속 좋은 예시(○)가 그 병을 갖지 않는지
// (모델이 예시를 그대로 배운다), 캐러셀에 줄거리 단계가 있는지, 역할 이름표("한 강만으로 이만큼")가 카피로 샐 자리가 없는지 본다.
const DEMONSTRATIVE = /(^|[\s"(])(그|이) [가-힣]|이게|그게|이거|그거|그걸|이걸/;
test('우리말 어순 규칙 — 카페·캡션·캐러셀(첫 생성·수정)에 실리고, 좋은 예시(○)는 지시어 없는 온전한 문장이다', () => {
  const RULE = '▸ 우리말 어순';
  const built = {
    cafe: prompts.buildCafePrompt({ voice }),
    caption: prompts.buildCaptionPrompt({ voice }),
    carousel: prompts.buildCarouselPrompt({ voice }),
  };
  for (const [type, p] of Object.entries(built)) {
    assert.ok(p.includes(RULE), `${type}: 우리말 어순 규칙이 없다`);
    assert.ok(prompts.buildRevisePrompt({ type, original: '원본', instruction: '고쳐', voice }).includes(RULE), `${type} 수정: 우리말 어순 규칙이 없다`);
    for (const m of p.matchAll(/○ "([^"]+)"/g)) {
      assert.ok(!DEMONSTRATIVE.test(m[1]), `${type}: 좋은 예시에 지시어가 남아 있다 — "${m[1]}"`);
      assert.ok(/[요다죠까!?.~…)]$/.test(m[1].trim()), `${type}: 좋은 예시가 명사·어절로 끊긴다 — "${m[1]}"`);
    }
    assert.ok(!p.includes('한 강만으로'), `${type}: 역할 이름표 "한 강만으로 이만큼"이 남아 카피로 샐 수 있다`);
  }
  const map = prompts.buildLectureMapPrompt({ title: '기초정규반 3강 시보리' });
  assert.ok(map.includes('- 수업 이름:'), '강의 지도에 수업 이름 항목이 없다');
  assert.ok(map.includes('[영상 제목] 기초정규반 3강 시보리'), '강의 지도에 영상 제목이 실리지 않는다');
});

test('캐러셀 줄거리 — 개요에 줄거리 단계가 있고, 짝 캡션이 오면 같은 이야기를 따르게 싣는다', () => {
  const p = prompts.buildCarouselPrompt({ voice });
  assert.ok(p.includes('[줄거리 먼저'), '줄거리 단계 설명이 없다');
  assert.ok(p.includes('- **줄거리**:'), '출력 형식에 줄거리 줄이 없다');
  assert.ok(!p.includes('[짝 인스타 캡션 —'), '캡션이 없는데 빈 짝 캡션 블록이 들어갔다');
  const CAP = '짝캡션테스트-지퍼에서-허리로-9b2e';
  const withCap = prompts.buildCarouselPrompt({ voice, caption: CAP });
  assert.ok(withCap.includes('[짝 인스타 캡션 —') && withCap.includes(CAP), '짝 캡션이 실리지 않는다');
  // 캡션은 번호 칸(1)~7))으로 채우지 않는다
  assert.ok(!/^1\) 첫 두 줄/m.test(prompts.buildCaptionPrompt({ voice })), '캡션이 아직 번호 칸 구성이다');
});

// ── 2. 실제 흐름 (generate.js) — 모델·비메오·보이스만 가짜 ─────────────
const calls = []; // { step, prompt, transcript }
mock.module('../src/anthropic.js', {
  namedExports: {
    MODELS: { VOICE: 'x', CAFE: 'x', CAPTION: 'x', CAROUSEL: 'x', CAPTURE: 'x' },
    callClaude: async ({ step, prompt, transcript }) => {
      calls.push({ step, prompt, transcript });
      if (step === '강의 파악') return `- 강의 한 줄: 가짜 강의 지도 (${step})\n- 이렇게 만드는 이유: 없음\n- 검색어 후보: 가짜 검색어`;
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
  // 캐러셀 첫 생성은 먼저 쓴 캡션을 짝으로 받아 같은 줄거리를 따른다
  const carouselFirst = calls.find((c) => c.step === `${L.carousel} 생성`);
  assert.ok(carouselFirst.prompt.includes(`[짝 인스타 캡션 —`) && carouselFirst.prompt.includes(`가짜 결과 (${L.caption} 생성)`),
    '캐러셀 첫 생성에 방금 쓴 캡션이 실리지 않는다');
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

// 2026-11-16: 모델을 Opus 5.5로 올린 뒤 출력 한도가 사고 토큰에 먹혀 강의 지도가 중간까지만 저장됐고(마지막 항목 '검색어 후보' 없음),
// 지도는 작업당 한 번만 만들기 때문에 그 반쪽 지도가 이후 수정·재기획에 계속 실렸다. 끊긴 지도는 다음에 쓸 때 다시 만든다.
// 같은 날 지도에 '이렇게 만드는 이유' 항목을 더했다 — 그 항목이 없는 옛 형식 지도도 다음에 쓸 때 다시 만든다(캡션·캐러셀의 중심 재료).
test('끊겼거나 옛 형식인 강의 지도는 다음에 쓸 때 다시 만든다 — 한 작업에서 두 번까지만', async (t) => {
  const { jobId } = await gen.generateAll({ url: 'https://vimeo.com/test4' });
  t.after(async () => {
    await fs.rm(path.join(db.OUTPUTS_DIR, jobId), { recursive: true, force: true });
  });
  // 끊긴 지도 흉내: 저장된 지도를 마지막 항목 앞에서 자른다
  const file = path.join(db.OUTPUTS_DIR, jobId, 'contents.json');
  const CUT = '- 강의 한 줄: 끊긴 지도\n- 수강생의 말·실패 장면:\n  - [16:53] "어';
  const list = JSON.parse(await fs.readFile(file, 'utf8')).map((c) => (c.type === gen.LECTURE_MAP_TYPE ? { ...c, content: CUT } : c));
  await fs.writeFile(file, JSON.stringify(list, null, 2), 'utf8');
  const OLD = '- 강의 한 줄: 옛 형식 지도\n- 검색어 후보: 코트 만들기'; // 끝까지 왔지만 '이렇게 만드는 이유'가 없다
  const NOW = '- 강의 한 줄: 지금 형식\n- 이렇게 만드는 이유: 없음\n- 검색어 후보: 코트 만들기';
  assert.ok(gen.isStaleLectureMap({ content: CUT, version: 1 }), '끊긴 지도');
  assert.ok(gen.isStaleLectureMap({ content: OLD, version: 1 }), '옛 형식 지도');
  assert.ok(gen.isStaleLectureMap({ content: OLD, version: 2 }), '끊겨서 한 번 다시 만든 옛 형식 지도');
  assert.ok(!gen.isStaleLectureMap({ content: NOW, version: 1 }));
  assert.ok(!gen.isStaleLectureMap({ content: OLD, version: 3 }), '두 번 다시 만든 뒤에는 그만둔다');

  calls.length = 0;
  await gen.revise({ jobId, type: 'caption', instruction: '첫 줄만 고쳐' });
  assert.equal(calls[0].step, '강의 파악', '끊긴 지도를 그대로 썼다');
  assert.ok(!calls[1].prompt.includes('끊긴 지도') && calls[1].prompt.includes(MAP_TEXT), '캡션 수정이 끊긴 지도를 받았다');
  assert.ok((await gen.loadLectureMap(jobId))?.includes('검색어 후보'), '다시 만든 지도가 최신 버전으로 저장되지 않았다');

  // 다시 만든 지도는 또 만들지 않는다
  calls.length = 0;
  await gen.revise({ jobId, type: 'caption', instruction: '한 번 더' });
  assert.equal(promptsOf('강의 파악').length, 0, '이미 다시 만든 지도를 또 만들었다');
});

// 2026-11-16: 자야쌤 — "말투가 불편하고, 제작 과정을 자꾸 설명하려 한다. 알아듣지 못할 수업 내용 열거가 너무 많다."
// 캐러셀·캡션은 수업을 한 번도 안 들은 사람에게 '왜 이렇게 만드는지 → 그래서 무엇까지 배우는지'를 쉬운 말로 소개한다.
// 이유는 강좌에서 한 번만 말하므로(안감을 넣는 이유는 4강, 안감을 마무리하는 건 5강) 같은 시리즈 다른 강의 지도에서도 가져온다.
test('같은 시리즈의 다른 강에서 밝힌 이유 — 캡션·캐러셀 프롬프트에 실리고, 카페 글에는 실리지 않는다', async (t) => {
  const SERIES = `시리즈테스트${Date.now()}`;
  const WHY4 = '안감 넣기 — 보통은 안감 없이 만든다 / 정전기가 나고 다리에 감겨서 [67:19]';
  const save = (n) => db.saveJob({ video_id: `${SERIES}-${n}`, video_title: `${SERIES}-${n}강-테스트`, vimeo_url: 'https://vimeo.com/x', topic: null, transcript_compressed: '압축', transcript_full: '[00:00] 원본' });
  const four = await save(4);
  const five = await save(5);
  const other = await db.saveJob({ video_id: `${SERIES}-x`, video_title: `다른수업${Date.now()}-4강-테스트`, vimeo_url: 'https://vimeo.com/y', topic: null, transcript_compressed: '압축', transcript_full: '[00:00] 원본' });
  t.after(async () => {
    for (const j of [four, five, other]) await fs.rm(path.join(db.OUTPUTS_DIR, j.id), { recursive: true, force: true });
  });
  await db.saveContent(four.id, gen.LECTURE_MAP_TYPE, `- 강의 한 줄: 4강\n- 이렇게 만드는 이유:\n  - ${WHY4}\n- 검색어 후보: 안감`);
  await db.saveContent(other.id, gen.LECTURE_MAP_TYPE, '- 강의 한 줄: 다른 수업\n- 이렇게 만드는 이유: 다른수업이유-7c2e\n- 검색어 후보: x');
  await db.saveContent(five.id, gen.LECTURE_MAP_TYPE, '- 강의 한 줄: 5강\n- 이렇게 만드는 이유: 없음\n- 검색어 후보: 코트');
  for (const type of ['cafe', 'caption', 'carousel']) await db.saveContent(five.id, type, `원본 ${type}`);

  assert.equal(gen.extractWhyItem(await gen.loadLectureMap(four.id)), `- ${WHY4}`);
  assert.equal(gen.extractWhyItem(await gen.loadLectureMap(five.id)), '', '"없음"은 이유가 아니다');
  const block = await gen.seriesWhyBlock(five);
  assert.ok(block.includes(WHY4) && block.includes('▸ 4강'), '4강의 이유를 가져오지 못했다');
  assert.ok(!block.includes('다른수업이유-7c2e'), '다른 시리즈의 이유를 끌어왔다');
  assert.equal(await gen.seriesWhyBlock(four), '', '이유가 없는 강("없음")만 있으면 블록을 만들지 않는다');

  for (const type of ['caption', 'carousel']) {
    calls.length = 0;
    await gen.revise({ jobId: five.id, type, instruction: '고쳐', alignCaption: false });
    const p = calls.find((c) => c.step === `${L[type]} 수정`).prompt;
    assert.ok(p.includes(WHY4), `${type} 수정 프롬프트에 4강의 이유가 없다`);
  }
  calls.length = 0;
  await gen.revise({ jobId: five.id, type: 'cafe', instruction: '고쳐' });
  assert.ok(!calls[0].prompt.includes(WHY4), '카페 글은 이전 그대로여야 한다');
  assert.equal(promptsOf('강의 파악').length, 0, '지금 형식 지도를 다시 만들었다');
});

test('캐러셀·캡션은 수업을 소개하는 글 — 이유 중심·쉬운 말·자신감 블록이 실리고, 카페 글 프롬프트에는 없다', () => {
  const MARKS = ['[읽는 사람 — 이 수업을 한 번도 듣지 않은 사람]', '[자야쌤 수업의 자신감', '[쉬운 말로 쓴다'];
  const built = {
    carousel: prompts.buildCarouselPrompt({ voice }),
    caption: prompts.buildCaptionPrompt({ voice }),
    captionRevise: prompts.buildRevisePrompt({ type: 'caption', original: '원본', instruction: '고쳐', voice }),
    carouselRevise: prompts.buildRevisePrompt({ type: 'carousel', original: '원본', instruction: '고쳐', voice }),
  };
  for (const [name, p] of Object.entries(built)) {
    for (const m of MARKS) assert.ok(p.includes(m), `${name}: ${m} 블록이 없다`);
    assert.ok(!p.includes('[노출 수위 — 후킹과 강의 보호'), `${name}: 옛 [노출 수위](진단은 다 준다)가 남아 수업 속 설명을 끌어온다`);
    assert.ok(!/한 끗 차이로|반이 정해져요\."\s*—/.test(p.replace(/×[^\n]*/g, '')), `${name}: 좋은 예시에 멋 부린 말이 남아 있다`);
  }
  // 카드는 소개하는 사람의 말(자야쌤 3인칭) — 수업 시간의 말이 아니다
  assert.ok(built.carousel.includes('자야쌤은 3인칭'));
  assert.ok(!built.carousel.includes('수강생 앞에서 소리 내어'), '카드를 수업 시간의 말로 쓰게 하는 지시가 남아 있다');
  // 카드용 우리말 규칙은 어순·번역투만 — 평범한 서술어("중요합니다")를 막는 상투 관용구 목록은 싣지 않는다
  assert.ok(built.carousel.includes('▸ 우리말 어순') && built.carousel.includes('▸ 번역투') && !built.carousel.includes('▸ 상투 관용구'));
  // 지도: 새 항목은 시간 비중으로 고르지 않고, 마지막 항목은 여전히 '검색어 후보'
  for (const map of [prompts.buildLectureMapPrompt({}), prompts.buildCourseMapPrompt({ name: '강좌', lectures: [{ n: 1, title: '1강', map: '지도' }] })]) {
    assert.ok(map.includes(`- ${prompts.MAP_WHY_ITEM}:`) && map.includes('시간 비중으로 고르지 않는다'));
    assert.ok(map.indexOf(`- ${prompts.MAP_WHY_ITEM}:`) < map.indexOf('- 검색어 후보:'), "'검색어 후보'가 마지막 항목이어야 끊긴 지도를 가려낼 수 있다");
  }
  // 카페 글은 이번 변경 범위 밖
  for (const p of [prompts.buildCafePrompt({ voice }), prompts.buildRevisePrompt({ type: 'cafe', original: '원본', instruction: '고쳐', voice })]) {
    for (const m of MARKS) assert.ok(!p.includes(m), `카페 글 프롬프트에 ${m}가 들어갔다`);
    assert.ok(p.includes('[노출 수위 — 후킹과 강의 보호'));
  }
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
