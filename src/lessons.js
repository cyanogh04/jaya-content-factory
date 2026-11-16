// src/lessons.js — 수정에서 배우기: 자야쌤이 화면에서 손으로 고친 것(전 → 후)을 모아 다음 기획에 싣는다.
//
// 2026-11-17: 기획안은 대부분 그대로 못 쓰고 고쳐 쓰는데, 고친 내용이 어디에도 남지 않아 같은 수정을 매번 되풀이했다.
// 이제 화면에서 고쳐 저장하면(generate.js saveManualEdit) 고친 곳을 줄 단위로 뽑아(editPairs)
//  (1) 모델이 "다음부터 이렇게 쓴다"는 노트로 정리해 두고(learnFromEdit → notes),
//  (2) 최근에 고친 문장 몇 쌍을 예문으로 남긴다(examples).
// 카페·캡션·캐러셀의 첫 생성·수정·재생성 프롬프트가 이 둘을 읽어 싣는다(prompts.js editLessonsBlock).
//
// 저장: 새 테이블을 만들지 않고 jobs에 '시스템 작업' 행 하나(video_id = SCOPE)를 두고 그 contents에 버전으로 쌓는다
// (type `notes_<종류>` = 노트 글, `examples_<종류>` = 예문 JSON). Supabase·파일 저장소가 똑같이 동작하고,
// 작업 목록에서는 숨긴다(db.js listJobs — video_id가 'system-'으로 시작하는 행).

import { callClaude, MODELS } from './anthropic.js';
import { saveJob, saveContent, getLatestContent, findJobByVideoId } from './db.js';
import { COMMON_HEADER, buildEditLessonsPrompt, TYPE_LABELS } from './prompts.js';

/** 배우는 글 — 캡쳐 가이드는 시각 목록이라 배울 말투가 없다 */
export const LESSON_TYPES = ['cafe', 'caption', 'carousel'];
const EXAMPLES_KEEP = 12; // 예문으로 남겨 두는 수
const PAIRS_PER_EDIT = 14; // 한 번 저장에서 뽑는 고친 곳 수
const SIDE_MAX = 400; // 예문 한쪽 글자 수

/** 시스템 작업의 video_id — 테스트·가짜 서버는 JAYA_LESSONS_SCOPE로 따로 둔다(실제 노트를 건드리지 않게) */
const scope = () => process.env.JAYA_LESSONS_SCOPE || 'system-edit-notes';

let creating = null; // 시스템 작업을 만드는 중이면 그 약속 — 저장이 겹쳐도 행을 두 개 만들지 않는다
async function systemJob({ create = false } = {}) {
  const id = scope();
  const found = await findJobByVideoId(id);
  if (found || !create) return found;
  if (!creating) {
    creating = saveJob({
      video_id: id,
      video_title: '수정에서 배운 것',
      vimeo_url: '',
      topic: null,
      transcript_compressed: '-',
      transcript_full: '-', // findJobByVideoId가 자막 있는 행만 찾는다
    }).finally(() => {
      creating = null;
    });
  }
  return creating;
}

function parseExamples(text) {
  try {
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? arr.filter((e) => e && typeof e.before === 'string' && typeof e.after === 'string') : [];
  } catch {
    return [];
  }
}

const EMPTY = () => ({ notes: '', examples: [], edits: 0 });

/** 시스템 작업에서 종류별 최신 노트·예문을 읽는다(종류마다 최신 한 줄씩 — 버전이 쌓여도 읽는 양은 그대로) */
async function readAll() {
  const out = { cafe: EMPTY(), caption: EMPTY(), carousel: EMPTY() };
  const job = await systemJob();
  if (!job) return out;
  const keys = LESSON_TYPES.flatMap((type) => [`notes_${type}`, `examples_${type}`]);
  const rows = await Promise.all(keys.map((key) => getLatestContent(job.id, key)));
  const latest = new Map(keys.map((key, i) => [key, rows[i]]));
  for (const type of LESSON_TYPES) {
    const notesRow = latest.get(`notes_${type}`);
    const exRow = latest.get(`examples_${type}`);
    out[type] = {
      notes: (notesRow?.content || '').trim().replace(/^없음$/, ''),
      examples: exRow ? parseExamples(exRow.content) : [],
      edits: exRow?.version || 0, // 예문은 배울 때마다 한 번씩 저장된다
    };
  }
  return out;
}

/**
 * 세 종류의 배운 것 — { cafe, caption, carousel } 각 { notes: 노트 글(없으면 ''), examples: [{ where, before, after }], edits: 배운 저장 횟수 }.
 * generate.js가 기획 한 번에 한 번 읽는다. 읽기에 실패해도 기획을 막지 않는다(빈 값).
 */
export async function loadAllLessons() {
  try {
    return await readAll();
  } catch (err) {
    console.warn(`수정에서 배운 것을 읽지 못했습니다 — 없이 진행합니다: ${err.message}`);
    return { cafe: EMPTY(), caption: EMPTY(), carousel: EMPTY() };
  }
}

/** 한 종류의 배운 것 */
export async function loadLessons(type) {
  return LESSON_TYPES.includes(type) ? (await loadAllLessons())[type] : EMPTY();
}

/** 화면에서 노트를 직접 고쳐 저장 — 잘못 배운 줄을 지우거나 고칠 수 있게 */
export async function saveLessonNotes(type, notes) {
  if (!LESSON_TYPES.includes(type)) throw new Error(`배운 것 저장: 알 수 없는 종류입니다 — ${type}`);
  const job = await systemJob({ create: true });
  const text = String(notes || '').trim();
  await saveContent(job.id, `notes_${type}`, text || '없음');
  return loadLessons(type);
}

// ───────────────────────── 고친 곳 뽑기 ─────────────────────────

/** 줄 단위 최장 공통 부분열 — 같은 줄은 건너뛰고 달라진 덩어리만 [{ a: 지운 줄들, b: 넣은 줄들, at: b에서의 위치 }]로 */
function diffHunks(a, b) {
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const hunks = [];
  let cur = null;
  let i = 0;
  let j = 0;
  const open = () => (cur ||= { a: [], b: [], at: j, atA: i });
  const close = () => {
    if (cur) hunks.push(cur);
    cur = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      close();
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      open().b.push(b[j++]);
    } else {
      open().a.push(a[i++]);
    }
  }
  close();
  return hunks;
}

const clip = (s) => (s.length > SIDE_MAX ? `${s.slice(0, SIDE_MAX)}…` : s);

/** 캐러셀 기획안 → 카드에 찍히는 줄만(헤드카피·서브카피·본문·목록) + 컷 머리(번호는 뗀다 — 컷을 지워 번호가 밀려도 같은 컷으로 보게) */
function carouselLines(content) {
  const out = [];
  let inCard = false;
  for (const raw of String(content || '').split('\n')) {
    const line = raw.trimEnd();
    const head = line.match(/^##\s*CUT\s*\d+\s*[—–-]?\s*(.*)$/);
    if (head) {
      out.push(`## CUT — ${head[1].trim()}`);
      inCard = false;
      continue;
    }
    if (/^\*\*카드 텍스트\*\*/.test(line)) {
      inCard = true;
      continue;
    }
    if (/^\*\*/.test(line)) {
      inCard = false; // 장면 디렉션·넘김 유도는 카드에 찍히지 않는다
      continue;
    }
    if (inCard && line.trim()) out.push(line.trim());
  }
  return out;
}

/**
 * 고친 곳 — [{ where, before, after }]. 지운 곳은 after가 '(지움)', 새로 넣은 곳은 before가 '(없던 내용)'.
 * 빈 줄과 줄 끝 공백만 달라진 것은 고친 것으로 치지 않는다.
 */
export function editPairs(type, before, after) {
  const isCarousel = type === 'carousel';
  const lines = (text) =>
    isCarousel
      ? carouselLines(text)
      : String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const a = lines(before);
  const b = lines(after);
  const pairs = [];
  for (const h of diffHunks(a, b)) {
    let where = '';
    if (isCarousel) {
      // 이 덩어리가 속한 컷 — 덩어리 앞에서 가장 가까운 컷 머리
      const src = h.b.length ? b : a;
      for (let k = (h.b.length ? h.at : h.atA) - 1; k >= 0; k--) {
        if (src[k].startsWith('## CUT — ')) {
          where = src[k].slice('## CUT — '.length);
          break;
        }
      }
    }
    const strip = (arr) => arr.filter((l) => !l.startsWith('## CUT — '));
    const removedCut = isCarousel && h.a.some((l) => l.startsWith('## CUT — ')) && !h.b.some((l) => l.startsWith('## CUT — '));
    const addedCut = isCarousel && h.b.some((l) => l.startsWith('## CUT — ')) && !h.a.some((l) => l.startsWith('## CUT — '));
    const beforeText = strip(h.a).join('\n');
    const afterText = strip(h.b).join('\n');
    if (!beforeText && !afterText) continue; // 컷 머리(역할 이름)만 달라짐
    if (removedCut) where = `컷을 통째로 지움 — ${h.a.find((l) => l.startsWith('## CUT — ')).slice('## CUT — '.length)}`;
    if (addedCut) where = `컷을 새로 넣음 — ${h.b.find((l) => l.startsWith('## CUT — ')).slice('## CUT — '.length)}`;
    pairs.push({
      where,
      before: clip(beforeText || '(없던 내용)'),
      after: clip(afterText || '(지움)'),
    });
    if (pairs.length >= PAIRS_PER_EDIT) break;
  }
  return pairs;
}

// ───────────────────────── 배우기 ─────────────────────────

let queue = Promise.resolve(); // 저장이 잇따라도 노트를 차례로 고쳐 쓴다

/**
 * 손으로 고친 한 번을 배운다 — 예문을 남기고, 노트를 모델로 고쳐 쓴다. 저장 응답을 기다리게 하지 않으려고 뒤에서 돈다.
 * @returns {Promise<{ learned: boolean, pairs: number }>}
 */
export function learnFromEdit({ type, before, after }) {
  const run = async () => {
    if (!LESSON_TYPES.includes(type)) return { learned: false, pairs: 0 };
    const pairs = editPairs(type, before, after);
    if (pairs.length === 0) return { learned: false, pairs: 0 };
    const job = await systemJob({ create: true });
    const current = await loadLessons(type);

    // 예문 — 전·후가 둘 다 있고 짧은 것이 본보기로 좋다. 최근 것이 앞.
    const usable = pairs.filter((p) => p.before !== '(없던 내용)' && p.after !== '(지움)' && p.before.length <= 220 && p.after.length <= 220);
    const examples = [...usable, ...current.examples].slice(0, EXAMPLES_KEEP);
    await saveContent(job.id, `examples_${type}`, JSON.stringify(examples));

    console.log(`수정에서 배우기: ${TYPE_LABELS[type]} — 고친 곳 ${pairs.length}군데를 노트에 반영하는 중...`);
    const notes = (
      await callClaude({
        model: MODELS.CAPTION,
        system: COMMON_HEADER,
        prompt: buildEditLessonsPrompt({ type, notes: current.notes, pairs }),
        step: '수정에서 배우기',
      })
    ).trim();
    if (notes && notes !== '없음' && notes !== current.notes) {
      await saveContent(job.id, `notes_${type}`, notes);
      console.log(`수정에서 배우기: ${TYPE_LABELS[type]} 노트 갱신 (${notes.length}자)`);
    }
    return { learned: true, pairs: pairs.length };
  };
  const result = queue.then(run, run);
  queue = result.catch((err) => {
    console.warn(`수정에서 배우기 실패 — 저장은 그대로입니다: ${err.message}`);
  });
  return result;
}

/** 뒤에서 돌고 있는 배우기가 끝나기를 기다린다(테스트·종료 직전용) */
export function lessonsIdle() {
  return queue;
}
