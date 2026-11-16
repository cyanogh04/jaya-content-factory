// test/edit.test.js — 화면에서 손으로 고친 글 저장(saveManualEdit)과 수정에서 배우기(lessons.js).
// 2026-11-17: 기획안을 그대로 못 쓰고 고쳐 쓰는데 화면에서 고칠 수도, 고친 것을 저장할 수도 없었다. 이제 고쳐 저장하면
//  (1) 새 버전으로 남고 (2) 캐러셀을 고치면 캡션이, 카페 글을 고치면 📷 캡쳐 자리와 캡쳐 가이드가 따라오고
//  (3) 고친 방향을 배워 다음 기획 프롬프트에 싣는다.
// 실행: npm test (모델·비메오·보이스는 가짜 — API 호출 없음. 저장은 실제 파일 폴백(outputs/)을 쓰고 끝나면 지운다.)
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const SCOPE = `system-edit-notes-test-${Date.now()}`;
process.env.JAYA_LESSONS_SCOPE = SCOPE; // 실제 '수정에서 배운 것'을 건드리지 않는다
process.env.JAYA_NO_SERIES = '1';

const CUT = (n, role, head, body = '가짜 본문입니다.') =>
  `## CUT ${n} — 역할: ${role}\n**카드 텍스트**\n- 헤드카피: ${head}\n- 서브카피: 가짜 서브카피예요.\n- 본문: ${body}\n\n**장면 디렉션**\n- 연출 컷: 장면 ${n}\n\n**넘김 유도**: 다음 장으로`;
const CAROUSEL = [
  '# 인스타 캐러셀 기획안 — 테스트',
  '## 기획 개요\n- **총 컷 수**: 10컷\n- **후크 후보**:\n  · A안 [공감형] 첫 컷 헤드카피예요. → 근거\n  · B안 [반전형] 다른 헤드카피예요. → 근거\n  · 채택: A안 → 이유',
  ...Array.from({ length: 10 }, (_, i) => CUT(i + 1, i === 0 ? 'hook' : 'learn', i === 0 ? '첫 컷 헤드카피예요.' : `${i + 1}번째 컷 헤드카피예요.`)),
].join('\n\n');
const CAFE = '코트 만들기 — 디바예요\n\n안감 이야기를 먼저 해요.\n\n📷 캡쳐 1 [00:20] 안감을 젖혀 보이는 장면\n\n카라 이야기를 이어서 해요.\n\n📷 캡쳐 2 [01:00] 카라 모서리 장면\n\n[소잉클래스 수강 신청하기]http://www.sewingclass.co.kr';
const TRANSCRIPT = ['[00:00] 시작', '[00:20] 안감', '[01:00] 카라', '[02:40] 단춧구멍', '[03:20] 다림질'].join('\n');

const calls = []; // { step, prompt }
let syncAnswer = '[]';
mock.module('../src/anthropic.js', {
  namedExports: {
    MODELS: { VOICE: 'x', CAFE: 'x', CAPTION: 'x', CAROUSEL: 'x', CAPTURE: 'x' },
    callClaude: async ({ step, prompt }) => {
      calls.push({ step, prompt });
      if (step === '강의 파악') return '- 강의 한 줄: 가짜 지도\n- 이렇게 만드는 이유: 없음\n- 검색어 후보: 코트';
      if (step === '수정에서 배우기') return '- 헤드카피를 더 쉬운 말로 쓴다 — 예: 첫 컷 → 고친 첫 컷 (1회)';
      if (step === '캡쳐 자리 맞추기') return syncAnswer;
      if (step.includes('캐러셀 기획 생성')) return CAROUSEL;
      if (step.includes('캐러셀 기획 수정')) return CAROUSEL.replace('2번째 컷 헤드카피예요.', '모델이 다시 쓴 둘째 컷이에요.');
      if (step.includes('카페 서머리 생성')) return CAFE;
      if (step.includes('카피 교정')) return '[]';
      return `가짜 결과 (${step})`;
    },
  },
});
mock.module('../src/vimeo.js', {
  namedExports: { getTranscript: async () => ({ videoId: `edit-test-${Date.now()}`, title: '테스트 강의', compressed: TRANSCRIPT, full: TRANSCRIPT }) },
});
mock.module('../src/voice.js', { namedExports: { load: async () => ({ tone: '테스트', representative_captions: ['예시'] }) } });

const gen = await import('../src/generate.js');
const db = await import('../src/db.js');
const lessons = await import('../src/lessons.js');
const prompts = await import('../src/prompts.js');
const L = prompts.TYPE_LABELS;
const stepsOf = () => calls.map((c) => c.step);
const versionsOf = async (jobId, type) => (await db.getContents(jobId)).filter((c) => c.type === type).length;

async function removeSystemJob() {
  const job = await db.findJobByVideoId(SCOPE);
  if (job) await fs.rm(path.join(db.OUTPUTS_DIR, job.id), { recursive: true, force: true });
}

test('editPairs — 고친 줄만 전·후로 뽑는다. 빈 줄만 달라진 건 고친 게 아니다', () => {
  const before = '첫 줄이에요.\n\n둘째 줄이에요.\n셋째 줄이에요.';
  assert.deepEqual(lessons.editPairs('caption', before, '첫 줄이에요.\n둘째 줄이에요.\n\n\n셋째 줄이에요.  '), []);
  assert.deepEqual(lessons.editPairs('caption', before, '첫 줄이에요.\n둘째 줄을 고쳤어요.\n셋째 줄이에요.'),
    [{ where: '', before: '둘째 줄이에요.', after: '둘째 줄을 고쳤어요.' }]);
  assert.deepEqual(lessons.editPairs('caption', before, '첫 줄이에요.\n셋째 줄이에요.'), [{ where: '', before: '둘째 줄이에요.', after: '(지움)' }]);

  // 캐러셀: 카드에 찍히는 줄만 본다(장면 디렉션은 안 본다). 컷을 지워 번호가 밀려도 뒤 컷들을 고친 것으로 치지 않는다
  const edited = CAROUSEL.replace('- 헤드카피: 3번째 컷 헤드카피예요.', '- 헤드카피: 셋째 컷을 쉬운 말로 고쳤어요.').replace('- 연출 컷: 장면 4', '- 연출 컷: 다른 장면');
  assert.deepEqual(lessons.editPairs('carousel', CAROUSEL, edited),
    [{ where: '역할: learn', before: '- 헤드카피: 3번째 컷 헤드카피예요.', after: '- 헤드카피: 셋째 컷을 쉬운 말로 고쳤어요.' }]);
  const cut5 = CUT(5, 'learn', '5번째 컷 헤드카피예요.');
  const renumbered = CAROUSEL.replace(`${cut5}\n\n`, '').replace(/## CUT (\d+)/g, (m, n) => `## CUT ${Number(n) > 5 ? Number(n) - 1 : n}`);
  const removed = lessons.editPairs('carousel', CAROUSEL, renumbered);
  assert.equal(removed.length, 1, '컷 하나를 지웠는데 고친 곳이 여러 군데로 잡혔다');
  assert.ok(removed[0].where.startsWith('컷을 통째로 지움') && removed[0].after === '(지움)');
});

test('applyMarkerSync — 📷 줄만, 자막에 있는 시각일 때만 바꾼다. 본문은 건드리지 않는다', () => {
  const ok = gen.applyMarkerSync(CAFE, [{ before: '📷 캡쳐 2 [01:00] 카라 모서리 장면', after: '📷 캡쳐 2 [03:20] 다림질 장면' }], TRANSCRIPT);
  assert.equal(ok.applied.length, 1);
  assert.ok(ok.content.includes('📷 캡쳐 2 [03:20] 다림질 장면') && ok.content.includes('카라 이야기를 이어서 해요.'));
  // 자막에 없는 시각, 📷 줄이 아닌 줄, 글에 없는 줄은 받지 않는다
  for (const bad of [
    { before: '📷 캡쳐 2 [01:00] 카라 모서리 장면', after: '📷 캡쳐 2 [09:99] 없는 시각' },
    { before: '카라 이야기를 이어서 해요.', after: '본문을 바꾸려는 시도' },
    { before: '📷 캡쳐 9 [01:00] 글에 없는 줄', after: '📷 캡쳐 9 [03:20] 다림질' },
  ]) assert.equal(gen.applyMarkerSync(CAFE, [bad], TRANSCRIPT).content, CAFE);
  // 빈 after는 그 📷 줄을 지운다
  const gone = gen.applyMarkerSync(CAFE, [{ before: '📷 캡쳐 1 [00:20] 안감을 젖혀 보이는 장면', after: '' }], TRANSCRIPT);
  assert.ok(!gone.content.includes('캡쳐 1') && gone.content.includes('안감 이야기를 먼저 해요.\n\n카라 이야기'));
  assert.deepEqual(gen.parseMarkerSync('고칠 줄이 없어요'), []);
});

test('캐러셀을 고쳐 저장 — 고친 그대로 새 버전이 되고, 카드 글이 바뀌었으면 캡션이 그 내용에 맞게 다시 써진다', async (t) => {
  const { jobId } = await gen.generateAll({ url: 'https://vimeo.com/edit1' });
  t.after(async () => {
    await lessons.lessonsIdle();
    await fs.rm(path.join(db.OUTPUTS_DIR, jobId), { recursive: true, force: true });
    await removeSystemJob();
  });
  const original = (await db.getLatestContent(jobId, 'carousel')).content;
  const NEW_HEAD = '안감 없는 코트는 정전기가 나요.';
  const edited = original.replace('- 헤드카피: 3번째 컷 헤드카피예요.', `- 헤드카피: ${NEW_HEAD}`);

  calls.length = 0;
  const out = await gen.saveManualEdit({ jobId, type: 'carousel', content: edited });
  assert.equal(out.content, edited, '고친 글을 모델이 다시 다듬으면 안 된다');
  assert.equal((await db.getLatestContent(jobId, 'carousel')).content, edited);
  assert.ok(!stepsOf().some((s) => s.includes('카피 교정') || s.includes('캐러셀 기획 수정')), '손으로 고친 캐러셀을 모델이 다시 썼다');
  const align = calls.find((c) => c.step === '인스타 캡션 결 맞추기');
  assert.ok(align, '카드 글을 고쳤는데 캡션을 맞추지 않았다');
  assert.ok(align.prompt.includes(NEW_HEAD) && align.prompt.includes('[자야쌤이 카드에서 고친 곳]'), '캡션 맞추기 프롬프트에 고친 카드가 없다');
  assert.equal(out.caption, '가짜 결과 (인스타 캡션 결 맞추기)');
  assert.equal((await db.getLatestContent(jobId, 'caption')).content, out.caption);

  // 장면 디렉션만 고쳤으면 캡션은 그대로 — 카드에 찍히는 글이 안 바뀌었다
  calls.length = 0;
  const captionVersions = await versionsOf(jobId, 'caption');
  await gen.saveManualEdit({ jobId, type: 'carousel', content: edited.replace('- 연출 컷: 장면 4', '- 연출 컷: 창가의 코트') });
  assert.ok(!stepsOf().includes('인스타 캡션 결 맞추기'));
  assert.equal(await versionsOf(jobId, 'caption'), captionVersions);

  // 체크를 끄면 카드 글을 고쳐도 캡션을 건드리지 않는다
  calls.length = 0;
  const latest = (await db.getLatestContent(jobId, 'carousel')).content;
  await gen.saveManualEdit({ jobId, type: 'carousel', content: latest.replace('- 헤드카피: 4번째 컷 헤드카피예요.', '- 헤드카피: 넷째도 고쳤어요.'), alignCaption: false });
  assert.ok(!stepsOf().includes('인스타 캡션 결 맞추기'));

  // 컷을 지우면 개요의 총 컷 수만 맞춘다(10 → 9)
  const cut10 = CUT(10, 'learn', '10번째 컷 헤드카피예요.');
  const nine = await gen.saveManualEdit({ jobId, type: 'carousel', content: (await db.getLatestContent(jobId, 'carousel')).content.replace(`\n\n${cut10}`, ''), alignCaption: false });
  assert.ok(nine.content.includes('**총 컷 수**: 9컷') && !nine.content.includes('## CUT 10'));

  // 바뀐 게 없으면 새 버전을 만들지 않는다
  const before = await versionsOf(jobId, 'carousel');
  const same = await gen.saveManualEdit({ jobId, type: 'carousel', content: `${nine.content}\n` });
  assert.ok(same.unchanged);
  assert.equal(await versionsOf(jobId, 'carousel'), before);
});

test('카페 글을 고쳐 저장 — 본문은 고친 그대로, 📷 자리는 본문에 맞게 옮기고 캡쳐 가이드를 다시 맞춘다', async (t) => {
  const { jobId } = await gen.generateAll({ url: 'https://vimeo.com/edit2' });
  t.after(async () => {
    await lessons.lessonsIdle();
    await fs.rm(path.join(db.OUTPUTS_DIR, jobId), { recursive: true, force: true });
    await removeSystemJob();
  });
  const original = (await db.getLatestContent(jobId, 'cafe')).content;
  assert.equal(original, CAFE);

  // 본문을 고침 → 캡쳐 자리 확인 호출. 모델이 캡쳐 2를 옮기자고 하면 그 📷 줄만 바뀐다
  const edited = original.replace('카라 이야기를 이어서 해요.', '마무리 다림질 이야기를 이어서 해요.');
  syncAnswer = '[{"before": "📷 캡쳐 2 [01:00] 카라 모서리 장면", "after": "📷 캡쳐 2 [03:20] 다림질로 털을 살리는 장면"}]';
  calls.length = 0;
  const out = await gen.saveManualEdit({ jobId, type: 'cafe', content: edited });
  const sync = calls.find((c) => c.step === '캡쳐 자리 맞추기');
  assert.ok(sync && sync.prompt.includes('마무리 다림질 이야기를 이어서 해요.'), '고친 본문으로 캡쳐 자리를 확인하지 않았다');
  assert.equal(out.markersMoved, 1);
  assert.ok(out.content.includes('마무리 다림질 이야기를 이어서 해요.') && out.content.includes('📷 캡쳐 2 [03:20] 다림질로 털을 살리는 장면'));
  assert.ok(out.content.includes('📷 캡쳐 1 [00:20] 안감을 젖혀 보이는 장면'), '본문이 그대로인 자리의 📷 줄이 바뀌었다');
  assert.equal(out.capture, '가짜 결과 (캡쳐 가이드 갱신)', '📷 자리가 바뀌었는데 캡쳐 가이드를 다시 만들지 않았다');
  assert.ok(calls.find((c) => c.step === '캡쳐 가이드 갱신').prompt.includes('[03:20] 다림질로 털을 살리는 장면'));
  assert.equal((await db.getLatestContent(jobId, 'capture')).content, out.capture);

  // 본문을 고쳤지만 📷 자리는 그대로 맞으면([]) 캡쳐 가이드는 그대로 둔다
  syncAnswer = '[]';
  calls.length = 0;
  const captureVersions = await versionsOf(jobId, 'capture');
  const second = await gen.saveManualEdit({ jobId, type: 'cafe', content: out.content.replace('안감 이야기를 먼저 해요.', '안감 이야기를 먼저 할게요.') });
  assert.ok(stepsOf().includes('캡쳐 자리 맞추기') && !stepsOf().includes('캡쳐 가이드 갱신'));
  assert.equal(second.capture, null);
  assert.equal(await versionsOf(jobId, 'capture'), captureVersions);

  // 📷 줄만 직접 옮겼으면 확인 호출 없이 캡쳐 가이드만 다시 맞춘다
  calls.length = 0;
  const third = await gen.saveManualEdit({ jobId, type: 'cafe', content: second.content.replace('📷 캡쳐 1 [00:20]', '📷 캡쳐 1 [02:40]') });
  assert.ok(!stepsOf().includes('캡쳐 자리 맞추기') && stepsOf().includes('캡쳐 가이드 갱신'));
  assert.ok(third.capture);

  // 캡션·캡쳐 가이드는 고친 그대로 저장만 한다
  calls.length = 0;
  const cap = await gen.saveManualEdit({ jobId, type: 'caption', content: '손으로 고친 캡션이에요.' });
  const guide = await gen.saveManualEdit({ jobId, type: 'capture', content: '[00:20] — 고친 캡쳐 가이드' });
  assert.equal(cap.content, '손으로 고친 캡션이에요.');
  assert.equal(guide.content, '[00:20] — 고친 캡쳐 가이드');
  await lessons.lessonsIdle();
  assert.deepEqual(stepsOf().filter((s) => s !== '수정에서 배우기'), [], '캡션·캡쳐 가이드 저장이 다른 글을 건드렸다');
  await assert.rejects(gen.saveManualEdit({ jobId, type: 'caption', content: '   ' }), /비어 있습니다/);
});

test('수정에서 배우기 — 고쳐 저장하면 노트와 예문이 쌓이고, 다음 기획 프롬프트에 실린다. 작업 목록에는 안 보인다', async (t) => {
  const { jobId } = await gen.generateAll({ url: 'https://vimeo.com/edit3' });
  t.after(async () => {
    await lessons.lessonsIdle();
    await fs.rm(path.join(db.OUTPUTS_DIR, jobId), { recursive: true, force: true });
    await removeSystemJob();
  });
  await removeSystemJob(); // 앞 테스트가 남긴 것 없이 시작
  assert.deepEqual(await lessons.loadLessons('carousel'), { notes: '', examples: [], edits: 0 });
  const MARK = '[자야쌤이 직접 고친 것에서 배운 것';
  calls.length = 0;
  await gen.revise({ jobId, type: 'caption', instruction: '고쳐' });
  assert.ok(!calls.some((c) => c.prompt.includes(MARK)), '배운 것이 없는데 빈 블록이 실렸다');

  const original = (await db.getLatestContent(jobId, 'carousel')).content;
  const out = await gen.saveManualEdit({
    jobId, type: 'carousel', alignCaption: false,
    content: original.replace('- 헤드카피: 3번째 컷 헤드카피예요.', '- 헤드카피: 셋째 컷을 쉬운 말로 고쳤어요.'),
  });
  assert.ok(out.learning);
  await lessons.lessonsIdle();
  const learnCall = calls.find((c) => c.step === '수정에서 배우기');
  assert.ok(learnCall.prompt.includes('전: - 헤드카피: 3번째 컷 헤드카피예요.') && learnCall.prompt.includes('후: - 헤드카피: 셋째 컷을 쉬운 말로 고쳤어요.'));

  const learned = await lessons.loadLessons('carousel');
  assert.equal(learned.notes, '- 헤드카피를 더 쉬운 말로 쓴다 — 예: 첫 컷 → 고친 첫 컷 (1회)');
  assert.equal(learned.examples[0].after, '- 헤드카피: 셋째 컷을 쉬운 말로 고쳤어요.');
  assert.equal(learned.edits, 1);
  assert.equal((await lessons.loadLessons('caption')).notes, '', '캐러셀에서 배운 것이 캡션 노트에 들어갔다');

  // 다음 캐러셀 기획(수정·재생성)에 실린다. 캡션·카페에는 캐러셀 노트가 실리지 않는다
  calls.length = 0;
  await gen.revise({ jobId, type: 'carousel', instruction: '다시', alignCaption: false });
  const carouselPrompt = calls.find((c) => c.step === `${L.carousel} 수정`).prompt;
  assert.ok(carouselPrompt.includes(MARK) && carouselPrompt.includes(learned.notes) && carouselPrompt.includes('셋째 컷을 쉬운 말로 고쳤어요.'));
  assert.ok(calls.find((c) => c.step.includes('카피 교정')).prompt.includes(MARK), '카드 카피 교정에 배운 것이 없다');
  calls.length = 0;
  await gen.revise({ jobId, type: 'cafe', instruction: '다시' });
  assert.ok(!calls[0].prompt.includes(MARK));

  // 화면에서 노트를 직접 고칠 수 있다(잘못 배운 줄 지우기)
  const fixed = await lessons.saveLessonNotes('carousel', '- 내가 직접 고친 노트');
  assert.equal(fixed.notes, '- 내가 직접 고친 노트');
  assert.equal((await lessons.saveLessonNotes('carousel', '')).notes, '', '비워서 저장하면 노트가 없어야 한다');

  // 배운 것을 쌓아 두는 시스템 작업은 지난 작업 목록에 안 보인다
  assert.ok(await db.findJobByVideoId(SCOPE), '시스템 작업이 만들어지지 않았다');
  assert.ok(!(await db.listJobs(500)).some((j) => String(j.video_id).startsWith('system-')), '시스템 작업이 지난 작업 목록에 보인다');
});

test('배운 것 블록 — 없으면 프롬프트가 한 글자도 달라지지 않고, 있으면 카페·캡션·캐러셀 전부에 실린다', () => {
  const voice = { tone: '테스트', representative_captions: ['예시'] };
  assert.equal(prompts.editLessonsBlock(undefined), '');
  assert.equal(prompts.editLessonsBlock({ notes: '없음', examples: [] }), '');
  const lessonsOn = { notes: '- 본문을 "~해요"로 쓴다 (2회)', examples: [{ before: '배웁니다.', after: '배워요.' }] };
  const builders = {
    cafe: (l) => prompts.buildCafePrompt({ voice, lessons: l }),
    caption: (l) => prompts.buildCaptionPrompt({ voice, lessons: l }),
    carousel: (l) => prompts.buildCarouselPrompt({ voice, lessons: l }),
    cafeRevise: (l) => prompts.buildRevisePrompt({ type: 'cafe', original: '원본', instruction: '고쳐', voice, lessons: l }),
    captionRevise: (l) => prompts.buildRevisePrompt({ type: 'caption', original: '원본', instruction: '고쳐', voice, lessons: l }),
    carouselRevise: (l) => prompts.buildRevisePrompt({ type: 'carousel', original: '원본', instruction: '고쳐', voice, lessons: l }),
    regenerate: (l) => prompts.buildRegeneratePrompt({ type: 'carousel', cafe: '카페', caption: '캡션', voice, lessons: l }),
  };
  for (const [name, build] of Object.entries(builders)) {
    assert.equal(build(undefined), build({ notes: '', examples: [] }), `${name}: 배운 것이 없는데 프롬프트가 달라졌다`);
    const p = build(lessonsOn);
    assert.ok(p.includes(lessonsOn.notes) && p.includes('후: 배워요.'), `${name}: 배운 것이 실리지 않았다`);
    assert.ok(p.includes('출력 형식·컷 수·표기 규약'), `${name}: 형식 규약을 지키라는 단서가 없다`);
  }
  // 배우기 프롬프트 — 한 번의 수정을 부풀리지 않게, 강의 고유의 사실 수정은 빼게 시킨다
  const learn = prompts.buildEditLessonsPrompt({ type: 'caption', notes: '- 기존 줄 (1회)', pairs: [{ before: '전 문장', after: '후 문장' }] });
  assert.ok(learn.includes('- 기존 줄 (1회)') && learn.includes('전: 전 문장') && learn.includes('후: 후 문장'));
  assert.ok(learn.includes('이번 강의에만 해당하는 수정') && learn.includes('고친 범위만큼만'));
});
