// test/model.test.js — 모델 선택: CLAUDE_MODEL=auto면 가장 새 Opus, 고정이면 더 새 Opus가 있을 때만 알림(newer).
// 2026-11-04: 모델 ID는 저절로 바뀌지 않아서, 서버가 켜질 때 모델 목록 API를 보고 알리거나(기본) 자동 전환(auto)한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { latestOpus, pickModel, PINNED_MODEL } = await import('../src/anthropic.js');

const MODELS = [
  { id: 'claude-haiku-5-5', created_at: '2026-10-07T18:00:00Z' },
  { id: 'claude-sonnet-5-5', created_at: '2026-09-28T00:00:00Z' },
  { id: 'claude-opus-5-5', created_at: '2026-09-21T16:24:00Z' },
  { id: 'claude-fable-5-1', created_at: '2026-08-28T00:00:00Z' },
  { id: 'claude-opus-5', created_at: '2026-07-24T00:00:00Z' },
  { id: 'claude-opus-4-8', created_at: '2026-05-28T00:00:00Z' },
  { id: 'claude-opus-4-5-20251101', created_at: '2025-11-24T00:00:00Z' },
];

test('latestOpus — Opus만 보고 가장 새 것을 고른다 (Haiku·Sonnet·Fable은 후보가 아니다)', () => {
  assert.equal(latestOpus(MODELS).id, 'claude-opus-5-5');
  assert.equal(latestOpus([]), null);
  assert.equal(latestOpus([{ id: 'claude-sonnet-5-5', created_at: '2026-09-28T00:00:00Z' }]), null);
  // 더 새 Opus가 나오면 그걸 고른다
  assert.equal(latestOpus([...MODELS, { id: 'claude-opus-6', created_at: '2027-01-10T00:00:00Z' }]).id, 'claude-opus-6');
});

test('pickModel — 고정 모드는 그대로 쓰고, 더 새 Opus가 있을 때만 newer로 알린다', () => {
  const same = pickModel({ configured: 'claude-opus-5-5', models: MODELS });
  assert.deepEqual([same.model, same.mode, same.newer], ['claude-opus-5-5', 'pinned', null]);

  const old = pickModel({ configured: 'claude-opus-4-8', models: MODELS });
  assert.equal(old.model, 'claude-opus-4-8', '고정 모드인데 모델이 바뀌었다');
  assert.equal(old.newer?.id, 'claude-opus-5-5');

  // 목록에 없는 ID(새 모델을 미리 적은 경우)는 알림 없이 그대로
  const unknown = pickModel({ configured: 'claude-opus-7', models: MODELS });
  assert.equal(unknown.model, 'claude-opus-7');
  // 목록에 없어 날짜를 모르면 가장 새 Opus를 알림으로 보여 준다 — 그래야 오타 난 ID도 눈에 띈다
  assert.equal(unknown.newer?.id, 'claude-opus-5-5');
});

test('pickModel — auto는 가장 새 Opus를 쓰고, 목록이 비면 고정 기본값으로', () => {
  assert.equal(pickModel({ configured: 'auto', models: MODELS }).model, 'claude-opus-5-5');
  assert.equal(pickModel({ configured: 'auto', models: [...MODELS, { id: 'claude-opus-6', created_at: '2027-01-10T00:00:00Z' }] }).model, 'claude-opus-6');
  const empty = pickModel({ configured: 'auto', models: [] });
  assert.equal(empty.model, PINNED_MODEL);
  assert.equal(empty.mode, 'auto');
});
