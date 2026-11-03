// test/course.test.js — 강좌(2~4강 묶음) 기획: 강별 지도 → 강좌 지도 → 4종이 강좌 블록·회차 시각·강별 안내를 싣는지.
// 2026-11-04: 강의는 보통 3~4강으로 올라가는데 작업은 영상 하나씩이라 전체를 아우르는 소개글이 없었다.
// 실행: npm test (모델·비메오·보이스는 가짜. 저장은 파일 폴백(outputs/) — 끝나면 지운다.)
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

// ── 1. 순수 헬퍼 ────────────────────────────────────────────
const course = await import('../src/course.js');

test('deriveCourseName — 회차 표기를 떼고 공통 이름을 뽑는다', () => {
  assert.equal(
    course.deriveCourseName(['1강-크롭데님쟈켓(OT+패턴 수정 및 재단+부속만들기+쌈솔)', '2강-크롭데님쟈켓(몸판 주머니+소매트임 및 커프스+실장력시연)']),
    '크롭데님쟈켓'
  );
  assert.equal(course.deriveCourseName(['후드 벌룬 하프 트렌치코트 1강-재단 및 심지-비조제작', '후드 벌룬 하프 트렌치코트 2강-몸판']), '후드 벌룬 하프 트렌치코트');
  assert.equal(course.deriveCourseName(['초급정규8강-버뮤다 팬츠 완성하기', '초급정규9강-버뮤다 팬츠 주머니']), '초급정규');
  assert.equal(course.deriveCourseName(['사과', '배']), '사과'); // 공통이 없으면 첫 제목
  assert.equal(course.deriveCourseName([]), '');
});

test('compressTranscriptText·buildCourseTranscript — 30초 한 줄, 시각에 회차가 붙는다', () => {
  const full = ['[00:00] 안녕하세요', '[00:10] 오늘은', '[00:31] 재단부터', '[00:45] 결을', '[01:02] 심지', '머리말 아님'].join('\n');
  const cues = course.compressTranscriptText(full);
  assert.deepEqual(cues.map((c) => c.start), [0, 31, 62]);
  const t = course.buildCourseTranscript([
    { n: 1, title: '1강 재단', duration: 3600, transcript_full: full },
    { n: 2, title: '2강 몸판', transcript_full: '[00:00] 둘째 강' },
  ]);
  assert.ok(t.startsWith('=== 1강 · 1강 재단 (60분) ===\n[1강 00:00] 안녕하세요\n[1강 00:31] 재단부터\n[1강 01:02] 심지'));
  assert.ok(t.includes('\n\n=== 2강 · 2강 몸판 ===\n[2강 00:00] 둘째 강'));
  assert.ok(!/^\[\d\d:\d\d\]/m.test(t), '회차 없는 시각 줄이 남아 있다');
});

test('isCourseJob·parseCourse', () => {
  assert.ok(course.isCourseJob({ video_id: 'course-ab12' }));
  assert.ok(!course.isCourseJob({ video_id: '1083259656' }));
  assert.equal(course.parseCourse('깨진 json'), undefined);
  assert.equal(course.parseCourse('{"name":"x","lectures":[]}'), undefined);
  assert.equal(course.parseCourse('{"name":"x","lectures":[{"n":1}]}').name, 'x');
});

// ── 2. 프롬프트 ─────────────────────────────────────────────
const prompts = await import('../src/prompts.js');
const voice = { tone: '테스트', representative_captions: ['예시 캡션'] };
const META = { name: '크롭데님쟈켓', lectures: [{ n: 1, title: '1강-재단', duration: 3600 }, { n: 2, title: '2강-몸판' }] };
const COURSE_MARK = '[강좌 — 이번 작업은 영상 하나가 아니라 강좌 전체(2강)다';

test('강좌 블록 — 4종·수정·재생성 프롬프트에 실리고, 강좌가 아니면 끼우지 않는다', () => {
  const MAP = '- 강별 배움: 지도테스트-7a1c';
  const built = {
    cafe: prompts.buildCafePrompt({ voice, course: META, lectureMap: MAP }),
    caption: prompts.buildCaptionPrompt({ voice, course: META, lectureMap: MAP }),
    carousel: prompts.buildCarouselPrompt({ voice, course: META, lectureMap: MAP }),
    capture: prompts.buildCapturePrompt({ cafe: '카페', course: META, lectureMap: MAP }),
  };
  for (const [type, p] of Object.entries(built)) {
    assert.ok(p.includes(COURSE_MARK), `${type}: 강좌 블록이 없다`);
    assert.ok(p.includes('[n강 MM:SS]'), `${type}: 회차 시각 규칙이 없다`);
    assert.ok(p.includes(MAP), `${type}: 강좌 지도가 실리지 않는다`); // 강좌에서는 카페·캡쳐도 지도를 받는다
  }
  // 카페: 강별 안내 형식 + 늘어난 분량
  assert.ok(built.cafe.includes('✔️ 1강') && built.cafe.includes('2-1) 강별로 배우는 내용'), '카페에 강별 안내 자리가 없다');
  assert.ok(built.cafe.includes('2,200~2,800') && !built.cafe.includes('1,800~2,200'), '강좌 카페 분량이 안 바뀌었다');
  // 단일 강의는 그대로
  assert.ok(!prompts.buildCafePrompt({ voice }).includes('[강좌 —'));
  assert.ok(prompts.buildCafePrompt({ voice }).includes('1,800~2,200'));
  assert.ok(!prompts.buildCapturePrompt({ cafe: '카페' }).includes('[강좌 —'));
  // 수정·재생성
  for (const type of ['cafe', 'caption', 'carousel']) {
    const p = prompts.buildRevisePrompt({ type, original: '원본', instruction: '고쳐', voice, course: META, lectureMap: MAP });
    assert.ok(p.includes(COURSE_MARK) && p.includes(MAP), `${type} 수정: 강좌 블록·지도가 없다`);
    assert.ok(!prompts.buildRevisePrompt({ type, original: '원본', instruction: '고쳐', voice }).includes('[강좌 —'));
  }
  assert.ok(prompts.buildRevisePrompt({ type: 'cafe', original: '원본', instruction: '고쳐', voice, course: META }).includes('[n강 MM:SS]'));
  for (const type of ['carousel', 'capture']) {
    assert.ok(prompts.buildRegeneratePrompt({ type, cafe: '카페', caption: '캡션', voice, course: META, lectureMap: MAP }).includes(COURSE_MARK), `${type} 재생성: 강좌 블록이 없다`);
  }
});

test('강좌 지도 프롬프트 — 강별 지도를 싣고 강별 배움·전체 흐름 항목이 있다', () => {
  const p = prompts.buildCourseMapPrompt({ name: '크롭데님쟈켓', lectures: [{ n: 1, title: '1강', map: '지도일-4f2a' }, { n: 2, title: '2강', map: '지도이-9c1b' }] });
  assert.ok(p.includes('지도일-4f2a') && p.includes('지도이-9c1b'));
  for (const item of ['- 수업 이름:', '- 강의 한 줄:', '- 강별 배움:', '- 전체 흐름:', '- 주인공 배움:', '- 다 듣고 나면:', '- 장면 후보:']) {
    assert.ok(p.includes(item), `강좌 지도에 ${item} 항목이 없다`);
  }
  assert.ok(p.includes('자야쌤의 크롭데님쟈켓 수업'));
});

// ── 3. 실제 흐름 (generate.js) — 모델·비메오·보이스만 가짜 ─────────────
const calls = [];
mock.module('../src/anthropic.js', {
  namedExports: {
    MODELS: { VOICE: 'x', CAFE: 'x', CAPTION: 'x', CAROUSEL: 'x', CAPTURE: 'x' },
    callClaude: async ({ step, prompt, transcript }) => {
      calls.push({ step, prompt, transcript });
      if (step === '강의 파악') return `- 강의 한 줄: 가짜 강의 지도 ${transcript.slice(0, 12)}`;
      if (step === '강좌 파악') return '- 강별 배움: 가짜 강좌 지도';
      return `가짜 결과 (${step})`;
    },
  },
});
// 영상 ID는 실행마다 다르게 — 지난 실행이 남긴 outputs/ 폴더와 섞이지 않게
const RUN = Date.now().toString(36);
const URL1 = `https://vimeo.com/t${RUN}-1`;
const URL2 = `https://vimeo.com/t${RUN}-2`;
const fetched = [];
mock.module('../src/vimeo.js', {
  namedExports: {
    resolveVideoId: async (url) => url.split('/').pop(),
    getTranscript: async (url) => {
      fetched.push(url);
      const id = url.split('/').pop();
      const n = id.slice(-1);
      return { videoId: id, title: `${n}강-크롭데님쟈켓(부분${n})`, duration: 4000, compressed: `압축 ${n}`, full: `[00:00] 원본 ${n}\n[00:40] 둘째 ${n}` };
    },
  },
});
mock.module('../src/voice.js', { namedExports: { load: async () => voice } });

const gen = await import('../src/generate.js');
const db = await import('../src/db.js');
const L = prompts.TYPE_LABELS;

test('강좌 기획 — 강별 작업·강좌 작업이 생기고, 강별 지도 → 강좌 지도 → 4종 순서로 강좌 자막·강좌 블록을 받는다', async (t) => {
  assert.ok(!db.isSupabase(), '이 테스트는 파일 폴백(outputs/)으로만 돈다 — .env의 SUPABASE_URL을 비우고 실행');
  const made = [];
  t.after(async () => {
    for (const id of made) await fs.rm(path.join(db.OUTPUTS_DIR, id), { recursive: true, force: true });
  });

  // 지난 작업 하나(3강 자리)를 미리 만든다 — 자막만 있는 강의 작업
  const prior = await db.saveJob({ video_id: `v3-${RUN}`, video_title: '3강-크롭데님쟈켓(마무리)', vimeo_url: 'https://vimeo.com/v3', topic: null, transcript_compressed: '압축 v3', transcript_full: '[00:00] 원본 v3' });
  made.push(prior.id);

  const progress = [];
  calls.length = 0;
  const { jobId, course: meta } = await gen.generateCourse({
    lectures: [{ url: URL1 }, { url: URL2 }, { jobId: prior.id }],
    concept: '컨셉-강좌-3b7d',
    onProgress: (p) => progress.push(p),
  });
  made.push(jobId);
  for (const l of meta.lectures) if (l.jobId !== prior.id) made.push(l.jobId);

  // 강좌 이름·구성
  assert.equal(meta.name, '크롭데님쟈켓');
  assert.deepEqual(meta.lectures.map((l) => l.n), [1, 2, 3]);
  assert.equal(meta.lectures[2].jobId, prior.id, '지난 작업이 3강으로 그대로 쓰이지 않았다');
  assert.deepEqual(fetched, [URL1, URL2], '지난 작업의 자막을 다시 받았다');
  const job = await db.getJob(jobId);
  assert.ok(course.isCourseJob(job));
  assert.equal(job.video_title, '크롭데님쟈켓');
  assert.ok(job.transcript_full.includes('=== 1강 · 1강-크롭데님쟈켓(부분1) (67분) ===\n[1강 00:00] 원본 1'));
  assert.ok(job.transcript_full.includes('[3강 00:00] 원본 v3'));
  assert.equal((await gen.loadCourse(jobId)).name, '크롭데님쟈켓');

  // 호출 순서: 강별 지도 3개(각 강의 원본 자막) → 강좌 지도(강좌 자막, 강별 지도 포함) → 4종
  const steps = calls.map((c) => c.step);
  assert.deepEqual(steps.slice(0, 4), ['강의 파악', '강의 파악', '강의 파악', '강좌 파악']);
  assert.equal(calls[0].transcript, '[00:00] 원본 1\n[00:40] 둘째 1');
  assert.equal(calls[2].transcript, '[00:00] 원본 v3');
  const courseMap = calls[3];
  assert.equal(courseMap.transcript, job.transcript_full);
  assert.ok(courseMap.prompt.includes('가짜 강의 지도 [00:00] 원본') && courseMap.prompt.includes('--- 3강 ·'), '강좌 지도에 강별 지도가 실리지 않는다');
  assert.ok(!courseMap.prompt.includes('컨셉-강좌'), '강좌 지도는 사실 정리라 컨셉을 싣지 않는다');
  assert.ok((await gen.loadLectureMap(jobId)).includes('가짜 강좌 지도'), '강좌 지도가 lecture_map 타입으로 저장되지 않았다');
  assert.ok((await gen.loadLectureMap(prior.id)).includes('가짜 강의 지도'), '3강 작업에 강의 지도가 저장되지 않았다');

  // 4종 전부: 강좌 자막 + 강좌 블록 + 강좌 지도 + 컨셉
  for (const type of ['cafe', 'caption', 'carousel', 'capture']) {
    const c = calls.find((x) => x.step === `${L[type]} 생성`);
    assert.ok(c, `${type} 호출이 없다`);
    assert.equal(c.transcript, job.transcript_full, `${type}: 강좌 자막이 아니다`);
    assert.ok(c.prompt.includes('[강좌 — 이번 작업은 영상 하나가 아니라 강좌 전체(3강)다'), `${type}: 강좌 블록이 없다`);
    assert.ok(c.prompt.includes('가짜 강좌 지도'), `${type}: 강좌 지도가 없다`);
    assert.ok(c.prompt.includes('컨셉-강좌-3b7d'), `${type}: 컨셉이 없다`);
  }
  assert.ok(calls.find((x) => x.step === `${L.cafe} 생성`).prompt.includes('✔️ 1강'));

  // 진행 단계 알림
  const stages = progress.filter((p) => p.type === 'stage').map((p) => p.label);
  assert.deepEqual(stages, ['1강 자막', '2강 자막', '3강 자막', '1강 강의 지도', '2강 강의 지도', '3강 강의 지도', '강좌 지도']);
  assert.ok(progress.find((p) => p.type === 'job_created')?.course?.name === '크롭데님쟈켓');

  // 수정·재생성도 강좌 블록을 싣고, 지도는 다시 만들지 않는다. 카페 수정도 강좌면 지도를 받는다
  calls.length = 0;
  await gen.revise({ jobId, type: 'cafe', instruction: '2강 안내 더 짧게' });
  assert.equal(calls[0].step, `${L.cafe} 수정`);
  assert.ok(calls[0].prompt.includes('[강좌 —') && calls[0].prompt.includes('가짜 강좌 지도'));
  calls.length = 0;
  await gen.revise({ jobId, type: 'carousel', instruction: 'B안으로', alignCaption: false });
  assert.ok(calls.find((c) => c.step === `${L.carousel} 수정`).prompt.includes('[강좌 —'));
  assert.equal(calls.filter((c) => c.step === '강좌 파악' || c.step === '강의 파악').length, 0, '저장된 강좌 지도가 있는데 다시 만들었다');
  calls.length = 0;
  await gen.regenerateSecondary({ jobId });
  assert.ok(calls.find((c) => c.step === '캐러셀 기획 재생성').prompt.includes('[강좌 —'));
  assert.ok(calls.find((c) => c.step === '캡쳐 가이드 재생성').prompt.includes('[강좌 —'));

  // 같은 URL로 다시 묶으면 자막을 다시 받지 않는다(이미 수집한 영상 재사용)
  fetched.length = 0;
  calls.length = 0;
  const again = await gen.generateCourse({ lectures: [{ url: URL1 }, { url: URL2 }] });
  made.push(again.jobId);
  assert.deepEqual(fetched, [], '이미 수집한 영상의 자막을 다시 받았다');
  assert.equal(calls.filter((c) => c.step === '강의 파악').length, 0, '이미 만든 강별 지도를 다시 만들었다');
  assert.equal(calls.filter((c) => c.step === '강좌 파악').length, 1);
});

test('강좌 기획 — 1강만 넣거나 강좌 작업을 강 자리에 넣으면 거절한다', async () => {
  await assert.rejects(gen.generateCourse({ lectures: [{ url: 'https://vimeo.com/9' }] }), /2~4강/);
  await assert.rejects(gen.generateCourse({ lectures: [{ jobId: 'course-없음' }, { jobId: 'x' }] }), /찾을 수 없습니다/);
});
