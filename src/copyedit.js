// src/copyedit.js — 캐러셀 카드 카피 교정: 기획안이 다 나온 뒤 교정자 한 번이 카드 텍스트를 읽고 걸리는 줄만 문장째 다시 쓴다.
//
// 2026-10-09: 줄거리·우리말 어순 규칙을 넣어 헤드카피가 문장이 되고 장과 장이 이어졌지만, 긴 프롬프트 안의 자기 점검으로는
// 서브카피의 "그 자리요/그 바지요", "밴딩 허리, 설명서 방법은…" 같은 몇 줄이 계속 빠져나갔다. 이 카피는 캐러셀 공장(강의요약)이
// 다듬지 않고 그대로 카드에 찍으므로 교정을 따로 둔다. 무엇이 걸리는지는 정규식이 아니라 모델이 판단하고(낱말 바꿔 끼우기 금지),
// 코드는 모델이 돌려준 before가 기획안에 글자 그대로 있을 때만 그 자리를 바꾼다. 실패하면 원문 그대로 둔다.

import { callClaude, MODELS } from './anthropic.js';
import { COMMON_HEADER, buildCardCopyReviewPrompt } from './prompts.js';

const FIELDS = ['헤드카피', '서브카피', '본문'];

/** "## CUT n" 단위로 자른다 — [{ cut, start, end }] (start·end는 content 안의 위치) */
function cutSections(content) {
  const heads = [...content.matchAll(/^##\s*CUT\s*(\d+)\b.*$/gm)];
  return heads.map((m, i) => ({
    cut: Number(m[1]),
    start: m.index,
    end: i + 1 < heads.length ? heads[i + 1].index : content.length,
  }));
}

/** 컷별 카드 텍스트(헤드·서브·본문 줄) — 수정 전후를 견줘 바뀐 컷만 교정하려고 쓴다 */
export function cardTextByCut(content) {
  const out = new Map();
  for (const sec of cutSections(content || '')) {
    const body = content.slice(sec.start, sec.end);
    const lines = body.split('\n').filter((l) => new RegExp(`^\\s*-\\s*(?:${FIELDS.join('|')})\\s*[:：]`).test(l));
    out.set(sec.cut, lines.join('\n'));
  }
  return out;
}

/** 모델 응답(JSON 배열)을 읽는다. 형식이 깨졌으면 빈 배열 */
export function parseReview(raw) {
  const m = (raw || '').match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    return (Array.isArray(arr) ? arr : []).filter(
      (r) => r && Number.isInteger(r.cut) && FIELDS.includes(r.field) &&
        typeof r.before === 'string' && typeof r.after === 'string' &&
        r.before.trim() && r.after.trim() && r.before.trim() !== r.after.trim(),
    );
  } catch {
    return [];
  }
}

/**
 * 고친 문장을 끼운다. before가 그 CUT의 해당 필드 줄 안에 글자 그대로 있을 때만 바꾼다(엉뚱한 자리를 건드리지 않게).
 * CUT 1 헤드카피가 바뀌면 개요의 후크 후보 줄에 있는 같은 문장도 함께 바꾼다 — "채택 헤드카피 = CUT 1 헤드카피" 규약 유지.
 * @returns {{ content: string, applied: object[] }}
 */
export function applyReview(content, edits) {
  let out = content;
  const applied = [];
  for (const e of edits) {
    const before = e.before.trim();
    const after = e.after.replace(/\s*\n\s*/g, ' ').trim();
    const sec = cutSections(out).find((s) => s.cut === e.cut);
    if (!sec) continue;
    const body = out.slice(sec.start, sec.end);
    const lineRe = new RegExp(`^(\\s*-\\s*${e.field}\\s*[:：]\\s*)(.*)$`, 'm');
    const lm = body.match(lineRe);
    if (!lm || !lm[2].includes(before)) continue;
    const newBody = body.replace(lineRe, (whole, pre, text) => pre + text.replace(before, after));
    out = out.slice(0, sec.start) + newBody + out.slice(sec.end);
    if (e.cut === 1 && e.field === '헤드카피') {
      const firstCut = out.search(/^##\s*CUT\s*\d+/m);
      const overview = firstCut > 0 ? out.slice(0, firstCut) : '';
      const fixedOverview = overview
        .split('\n')
        .map((l) => (/^\s*[·•\-*]?\s*\**[ABC]안/.test(l) && l.includes(before) ? l.replace(before, after) : l))
        .join('\n');
      out = fixedOverview + out.slice(overview.length);
    }
    applied.push({ ...e, before, after });
  }
  return { content: out, applied };
}

/**
 * @param {object} o
 * @param {string} o.content 캐러셀 기획안
 * @param {string} [o.lectureMap]
 * @param {string} [o.previous] 수정 전 기획안 — 주면 카드 텍스트가 달라진 컷만 교정한다(확정된 컷은 건드리지 않는다)
 * @param {string} [o.instruction] 사용자의 수정 지시 — 사용자가 정해 준 문구는 존중하게 넘긴다
 * @param {string} [o.label]
 * @returns {Promise<string>}
 */
export async function reviewCardCopy({ content, lectureMap, previous, instruction, label = '캐러셀 기획' }) {
  if (!content || !/^##\s*CUT\s*\d+/m.test(content)) return content;
  let onlyCuts;
  if (previous) {
    const before = cardTextByCut(previous);
    onlyCuts = [...cardTextByCut(content)].filter(([cut, text]) => before.get(cut) !== text).map(([cut]) => cut);
    if (onlyCuts.length === 0) return content;
  }
  console.log(`${label}: 카드 카피 교정 중...${onlyCuts ? ` (바뀐 CUT ${onlyCuts.join(', ')})` : ''}`);
  try {
    const raw = await callClaude({
      model: MODELS.CAROUSEL,
      system: COMMON_HEADER,
      prompt: buildCardCopyReviewPrompt({ plan: content, lectureMap, instruction, onlyCuts }),
      maxTokens: 4000,
      step: `${label} 카드 카피 교정`,
    });
    const edits = parseReview(raw).filter((e) => !onlyCuts || onlyCuts.includes(e.cut));
    const { content: fixed, applied } = applyReview(content, edits);
    applied.forEach((e) => console.log(`  CUT ${e.cut} ${e.field}: "${e.before}" → "${e.after}"`));
    console.log(`${label}: 카드 카피 교정 완료 (${applied.length}줄 고침${edits.length > applied.length ? `, ${edits.length - applied.length}줄은 원문을 못 찾아 건너뜀` : ''})`);
    return fixed;
  } catch (err) {
    console.warn(`${label}: 카드 카피 교정 실패 — 교정 없이 저장합니다 (${err.message})`);
    return content;
  }
}
