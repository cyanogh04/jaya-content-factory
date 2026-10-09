// test/copyedit.test.js — 캐러셀 카드 카피 교정(src/copyedit.js)이 고친 문장을 제자리에만 끼우는지 확인(모델 호출 없음).
// 2026-10-09: 서브카피의 "그 자리요", "명사구, 한마디" 쉼표 틀이 자기 점검을 빠져나가 교정자 한 번을 따로 뒀다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReview, applyReview, cardTextByCut } from '../src/copyedit.js';

const PLAN = `# 인스타 캐러셀 기획안 — 청자켓

## 기획 개요
- **후크 후보**:
  · A안 [공감형] 칼라 다는 그 순간, 다들 멈춰요. → 수강생 말
  · B안 [반전형] 심지가 답이 아니었어요. → 통념
  · 채택: A안 → 반가움

## CUT 1 — 역할: hook (후킹)
**카드 텍스트**
- 헤드카피: 칼라 다는 그 순간, 다들 멈춰요.
- 서브카피: 다들 한 번씩 멈추게 되는 그 자리요.

**장면 디렉션**
- 연출 컷: 그 자리에서 멈춘 손

**넘김 유도**: 칼라가 어디서 꼬이는지 볼게요.

## CUT 2 — 역할: promise (기대)
**카드 텍스트**
- 헤드카피: 청자켓 1강은 원단 고르기부터 봉제 세팅까지 배워요.
- 서브카피: 다들 한 번씩 멈추게 되는 그 자리요.
`;

test('parseReview — JSON만 읽고, 필드·cut이 이상하거나 바뀐 게 없는 항목은 버린다', () => {
  const raw = '설명\n[{"cut":1,"field":"서브카피","before":"a","after":"b"},{"cut":1,"field":"장면","before":"a","after":"b"},{"cut":"1","field":"헤드카피","before":"a","after":"b"},{"cut":2,"field":"본문","before":"같다","after":"같다"}]';
  assert.deepEqual(parseReview(raw).map((r) => r.field), ['서브카피']);
  assert.deepEqual(parseReview('JSON 아님'), []);
});

test('applyReview — 지정한 CUT·필드 줄에서만 바꾸고, CUT 1 헤드카피는 후크 후보 줄도 함께 바꾼다', () => {
  const { content, applied } = applyReview(PLAN, [
    { cut: 1, field: '헤드카피', before: '칼라 다는 그 순간, 다들 멈춰요.', after: '칼라 달기에서 다들 한 번씩 멈추더라고요.' },
    { cut: 1, field: '서브카피', before: '다들 한 번씩 멈추게 되는 그 자리요.', after: '손이 멈추는 데는 이유가 있거든요.' },
    { cut: 1, field: '본문', before: '없는 문장', after: 'x' },
  ]);
  assert.equal(applied.length, 2, '원문을 못 찾은 항목은 건너뛴다');
  assert.ok(content.includes('· A안 [공감형] 칼라 달기에서 다들 한 번씩 멈추더라고요. → 수강생 말'), '후크 후보 줄이 CUT 1과 같이 바뀌어야 한다');
  assert.ok(content.includes('- 헤드카피: 칼라 달기에서 다들 한 번씩 멈추더라고요.'));
  assert.ok(content.includes('- 서브카피: 손이 멈추는 데는 이유가 있거든요.'));
  assert.ok(content.includes('- 연출 컷: 그 자리에서 멈춘 손'), '장면 디렉션은 건드리지 않는다');
  // CUT 2의 같은 문장은 지정하지 않았으니 그대로
  assert.equal(content.split('다들 한 번씩 멈추게 되는 그 자리요.').length - 1, 1, 'CUT 2의 같은 문장까지 바꾸면 안 된다');
});

test('cardTextByCut — 수정 전후 카드 텍스트가 달라진 컷만 골라낼 수 있다', () => {
  const after = PLAN.replace('- 헤드카피: 청자켓 1강은 원단 고르기부터 봉제 세팅까지 배워요.', '- 헤드카피: 청자켓 1강은 원단부터 시작해요.')
    .replace('- 연출 컷: 그 자리에서 멈춘 손', '- 연출 컷: 바뀐 장면');
  const a = cardTextByCut(PLAN);
  const b = cardTextByCut(after);
  const changed = [...b].filter(([cut, text]) => a.get(cut) !== text).map(([cut]) => cut);
  assert.deepEqual(changed, [2], '장면 디렉션만 바뀐 CUT 1은 교정 대상이 아니다');
});
