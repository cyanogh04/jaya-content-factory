// public/app.js — 자야쌤 콘텐츠 공장 프론트엔드
// SSE(POST) 수신, 섹션별 렌더링, 수정 요청, 캐러셀·캡쳐 재생성

'use strict';

// ─── 상태 ────────────────────────────────────────────────
let currentJobId = null;
const sectionContent = { cafe: null, caption: null, carousel: null, capture: null };
const TYPES = ['cafe', 'caption', 'carousel', 'capture'];
// 저장된 버전 이력 — 한 번 기획한 A안/B안 등은 토큰을 다시 쓰지 않고 오가며 비교한다
// versions[type] = [{ version, content, created_at }] (오름차순), viewing[type] = 지금 카드에 띄운 버전 번호
const versions = { cafe: [], caption: [], carousel: [], capture: [] };
const viewing = { cafe: null, caption: null, carousel: null, capture: null };

// ─── DOM 참조 ─────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const $url        = $('url-input');
const $topic      = $('topic-input');
const $genBtn     = $('generate-btn');
const $results    = $('results');
const $statusBar  = $('status-bar');
const $regenRow   = $('regen-row');
const $regenBtn       = $('regen-btn');
const $concept        = $('concept-input');   // 첫 생성 시 기획 컨셉(선택)
const $conceptRow     = $('concept-row');     // 전체 기획 다시하기 영역
const $conceptRedo    = $('concept-redo');
const $regenAllBtn    = $('regen-all-btn');
const $saveNotionBtn  = $('save-notion-btn');
const $learnBtn            = $('learn-voice-btn');
const $exchangeTokenBtn    = $('exchange-token-btn');
const $learnManualBtn      = $('learn-voice-manual-btn');
const $manualModal         = $('manual-caption-modal');
const $manualInput         = $('manual-captions-input');
const $manualSubmit        = $('manual-caption-submit');
const $manualCancel        = $('manual-caption-cancel');
const $historyPanel        = $('history-panel');
const $historyList         = $('history-list');
const $historyCount        = $('history-count');

// ─── 초기화 ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  checkStatus();
  bindEvents();
  loadHistory();
});

async function checkStatus() {
  try {
    const data = await apiFetch('GET', '/api/status');
    const warnings = [];
    if (data.missing && data.missing.length > 0) {
      warnings.push(`⚠️ 필수 환경변수 미설정: ${data.missing.join(', ')} — 서버의 .env 파일을 확인하세요.`);
    }
    if (!data.hasVoiceProfile) {
      warnings.push('⚠️ 보이스 프로파일이 없습니다. 하단 [보이스 프로파일 갱신] 버튼을 먼저 실행하세요.');
    }
    if (warnings.length > 0) {
      $statusBar.textContent = warnings.join('  /  ');
      $statusBar.removeAttribute('hidden');
    }
  } catch {
    // 상태 확인 실패는 조용히 처리
  }
}

function bindEvents() {
  $genBtn.addEventListener('click', handleGenerate);
  $url.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleGenerate(); });

  // 복사 버튼
  document.querySelectorAll('.btn-copy').forEach((btn) => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.target;
      if (!sectionContent[type]) return;
      navigator.clipboard.writeText(sectionContent[type]).then(() => {
        showToast('클립보드에 복사됐습니다');
      }).catch(() => {
        showToast('복사 실패 — 브라우저 권한을 확인하세요');
      });
    });
  });

  // 수정 요청 버튼
  document.querySelectorAll('.btn-revise').forEach((btn) => {
    btn.addEventListener('click', () => handleRevise(btn.dataset.type));
  });

  // 저장된 버전 오가기 / 확정
  TYPES.forEach((type) => {
    $(`version-${type}`).addEventListener('change', (e) => selectVersion(type, Number(e.target.value)));
  });
  document.querySelectorAll('.btn-confirm-version').forEach((btn) => {
    btn.addEventListener('click', () => confirmVersion(btn.dataset.type));
  });

  // 수정 입력창 Enter
  ['cafe', 'caption', 'carousel'].forEach((type) => {
    $(`revise-${type}`).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleRevise(type);
    });
  });

  // 캐러셀·캡쳐 재생성
  $regenBtn.addEventListener('click', handleRegenSecondary);

  // 전체 기획 다시하기 — 컨셉을 적어야 버튼이 살아난다
  $conceptRedo.addEventListener('input', () => {
    $regenAllBtn.disabled = !currentJobId || !$conceptRedo.value.trim();
  });
  $regenAllBtn.addEventListener('click', handleRegenAll);

  // 노션에 저장
  $saveNotionBtn.addEventListener('click', handleSaveToNotion);

  // 보이스 프로파일 갱신
  $learnBtn.addEventListener('click', handleLearnVoice);

  // Instagram 토큰 교환
  $exchangeTokenBtn.addEventListener('click', handleExchangeToken);

  // 캡션 직접 입력
  $learnManualBtn.addEventListener('click', () => {
    $manualInput.value = '';
    $manualModal.removeAttribute('hidden');
    $manualInput.focus();
  });
  $manualCancel.addEventListener('click', () => $manualModal.setAttribute('hidden', ''));
  $manualModal.addEventListener('click', (e) => { if (e.target === $manualModal) $manualModal.setAttribute('hidden', ''); });
  $manualSubmit.addEventListener('click', handleLearnVoiceManual);
}

// ─── 지난 작업 히스토리 ──────────────────────────────────
async function loadHistory() {
  try {
    const data = await apiFetch('GET', '/api/jobs');
    renderHistory(data.jobs || []);
  } catch {
    // 히스토리 로드 실패는 조용히 처리 — 메인 기능에 영향 없음
  }
}

function renderHistory(jobs) {
  if (jobs.length === 0) {
    $historyPanel.setAttribute('hidden', '');
    return;
  }
  $historyCount.textContent = `${jobs.length}건`;
  $historyList.innerHTML = '';

  jobs.forEach((job) => {
    const li = document.createElement('li');
    li.className = 'history-item';
    li.tabIndex = 0;
    li.dataset.jobId = job.id;

    const d = new Date(job.created_at);
    const dateEl = document.createElement('span');
    dateEl.className = 'history-date';
    dateEl.textContent = isNaN(d)
      ? ''
      : `${d.getFullYear()}. ${String(d.getMonth() + 1).padStart(2, '0')}. ${String(d.getDate()).padStart(2, '0')}`;

    const titleEl = document.createElement('span');
    titleEl.className = 'history-topic';
    titleEl.textContent = job.topic || job.video_title || (job.vimeo_url ? `영상 ${job.vimeo_url.split('/').pop()}` : '제목 없음');

    const openEl = document.createElement('span');
    openEl.className = 'history-open';
    openEl.textContent = '보기 →';

    li.append(dateEl, titleEl, openEl);
    li.addEventListener('click', () => openJob(job.id, li));
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') openJob(job.id, li); });
    $historyList.appendChild(li);
  });

  $historyPanel.removeAttribute('hidden');
}

/** 지난 작업 열기 — 저장된 콘텐츠(타입별 최신 버전)를 카드에 표시 */
async function openJob(jobId, itemEl) {
  setActiveHistoryItem(itemEl);

  $results.removeAttribute('hidden');
  TYPES.forEach(setCardLoading);
  $regenRow.setAttribute('hidden', '');

  try {
    const data = await apiFetch('GET', `/api/job/${jobId}`);
    currentJobId = jobId;
    TYPES.forEach((t) => { sectionContent[t] = null; });

    setVersions(data.contents || []);
    TYPES.forEach((type) => {
      if (versions[type].length === 0) {
        setCardEmpty(type);
        return;
      }
      showLatestVersion(type);
    });

    if (sectionContent['cafe'] && sectionContent['caption']) {
      $regenRow.removeAttribute('hidden');
      $saveNotionBtn.disabled = !TYPES.every((t) => sectionContent[t]);
    }
    $conceptRedo.value = '';
    showConceptRow();
    $results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    TYPES.forEach((t) => setCardError(t, err.message));
    showToast(`⚠️ ${err.message}`);
  }
}

function setActiveHistoryItem(itemEl) {
  document.querySelectorAll('.history-item.is-active').forEach((el) => el.classList.remove('is-active'));
  if (itemEl) itemEl.classList.add('is-active');
}

// ─── 생성 ─────────────────────────────────────────────────
async function handleGenerate() {
  const url = $url.value.trim();
  if (!url) { $url.focus(); return; }
  const topic = $topic.value.trim();
  const concept = $concept.value.trim();

  // 상태 초기화
  currentJobId = null;
  setActiveHistoryItem(null); // 새 생성 시작 — 히스토리 선택 해제
  TYPES.forEach((t) => { sectionContent[t] = null; });
  $regenRow.setAttribute('hidden', '');
  $conceptRow.setAttribute('hidden', '');
  $conceptRedo.value = concept; // 처음 적은 컨셉을 다시하기 칸에 미리 채워 고쳐 쓰기 쉽게

  // 결과 영역 표시 + 스피너
  $results.removeAttribute('hidden');
  TYPES.forEach(setCardLoading);

  setGenerating(true);

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, topic: topic || undefined, concept: concept || undefined }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `서버 오류 (HTTP ${res.status})`);
    }

    await readSSE(res, handleSSEEvent);
  } catch (err) {
    // 연결 자체가 실패한 경우 — 아직 로딩 중인 섹션에 에러 표시
    TYPES.forEach((t) => { if (!sectionContent[t]) setCardError(t, err.message); });
  } finally {
    setGenerating(false);
  }
}

// POST 기반 SSE 읽기 (EventSource는 GET 전용이므로 fetch + ReadableStream 사용)
async function readSSE(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventType = 'message';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop(); // 마지막 불완전 줄 보존

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          onEvent(eventType, data);
        } catch {
          /* JSON 파싱 실패 무시 */
        }
        eventType = 'message'; // 다음 이벤트를 위해 초기화
      }
    }
  }
}

function handleSSEEvent(event, data) {
  if (event === 'start') {
    // 작업 ID 즉시 확보 — 첫 섹션 완료 직후 수정 가능
    currentJobId = data.jobId;
  } else if (event === 'progress') {
    if (data.error) {
      setCardError(data.type, data.error);
    } else {
      setCardContent(data.type, data.content);
    }
  } else if (event === 'done') {
    // done 이벤트에서도 jobId 보장 (start가 누락된 경우 대비)
    if (!currentJobId) currentJobId = data.jobId;
    // cafe·caption 둘 다 성공한 경우에만 재생성 버튼 표시
    if (sectionContent['cafe'] && sectionContent['caption']) {
      $regenRow.removeAttribute('hidden');
      // 4종 모두 완성된 경우에만 노션 저장 활성화
      $saveNotionBtn.disabled = !TYPES.every((t) => sectionContent[t]);
    }
    showConceptRow(); // 결과가 나왔으니 '전체 기획 다시하기'를 열어 둔다
    refreshVersions(); // 버전 선택 목록 갱신
    loadHistory(); // 방금 만든 작업이 히스토리에 바로 보이도록 갱신
  } else if (event === 'error') {
    TYPES.forEach((t) => { if (!sectionContent[t]) setCardError(t, data.error); });
  }
}

/** '전체 기획 다시하기' 영역 표시 — jobId가 있고 컨셉을 적었을 때만 버튼 활성 */
function showConceptRow() {
  $conceptRow.removeAttribute('hidden');
  $regenAllBtn.disabled = !currentJobId || !$conceptRedo.value.trim();
}

// ─── 섹션 상태 관리 ──────────────────────────────────────
function setCardLoading(type, text = '생성 중…') {
  const body = $(`body-${type}`);
  body.innerHTML = `<div class="skeleton-wrap"><div class="spinner"></div><p class="loading-text">${escapeHtml(text)}</p></div>`;
  const card = $(`card-${type}`);
  card.classList.remove('is-done', 'is-error');
  card.querySelector('.btn-copy').disabled = true;
  const reviseBtn = card.querySelector('.btn-revise');
  if (reviseBtn) reviseBtn.disabled = true;
  const revRow = $(`revision-${type}`);
  if (revRow) revRow.setAttribute('hidden', '');
}

function setCardContent(type, content) {
  sectionContent[type] = content;
  const body = $(`body-${type}`);
  const pre = document.createElement('pre');
  pre.className = 'content-pre';
  pre.textContent = content;
  body.innerHTML = '';
  body.appendChild(pre);

  const card = $(`card-${type}`);
  card.classList.remove('is-loading', 'is-error');
  card.classList.add('is-done');
  card.querySelector('.btn-copy').disabled = false;

  // 글자수 표시 (cafe, caption)
  if (type === 'cafe' || type === 'caption') {
    const countEl = $(`count-${type}`);
    if (countEl) {
      const chars = content.replace(/\s/g, '').length;
      countEl.textContent = `${chars.toLocaleString()}자`;
    }
  }

  // 수정 요청 행 표시 (cafe, caption, carousel) — jobId가 있을 때 버튼도 활성화
  const revRow = $(`revision-${type}`);
  if (revRow) {
    revRow.removeAttribute('hidden');
    const reviseBtn = revRow.querySelector('.btn-revise');
    if (reviseBtn) reviseBtn.disabled = !currentJobId;
  }

  // 캐러셀: 기획안의 [후크 후보] A안/B안/C안을 버튼으로 — 다른 안을 누르면 그 안으로 1컷부터 재기획
  if (type === 'carousel') renderHookPicker(content);

  // 재생성 버튼은 done 이벤트에서만 표시 (race condition 방지)
}

/** 히스토리에서 연 작업에 해당 섹션 콘텐츠가 없을 때 */
function setCardEmpty(type) {
  sectionContent[type] = null;
  const body = $(`body-${type}`);
  body.innerHTML = '<p class="empty-msg">이 작업에서는 생성되지 않은 섹션입니다.</p>';
  viewing[type] = null;
  const sel = $(`version-${type}`);
  if (sel) sel.setAttribute('hidden', '');
  const confirmBtn = document.querySelector(`.btn-confirm-version[data-type="${type}"]`);
  if (confirmBtn) confirmBtn.setAttribute('hidden', '');
  const card = $(`card-${type}`);
  card.classList.remove('is-done', 'is-error');
  card.querySelector('.btn-copy').disabled = true;
  const reviseBtn = card.querySelector('.btn-revise');
  if (reviseBtn) reviseBtn.disabled = true;
  const revRow = $(`revision-${type}`);
  if (revRow) revRow.setAttribute('hidden', '');
}

function setCardError(type, message) {
  sectionContent[type] = null;
  const body = $(`body-${type}`);
  body.innerHTML = `<p class="error-msg">⚠️ ${escapeHtml(message)}</p>`;
  const card = $(`card-${type}`);
  card.classList.remove('is-loading', 'is-done');
  card.classList.add('is-error');
  card.querySelector('.btn-copy').disabled = true;
  const reviseBtn = card.querySelector('.btn-revise');
  if (reviseBtn) reviseBtn.disabled = true;
}

// ─── 수정 재생성 ──────────────────────────────────────────
/**
 * @param {string} type - cafe | caption | carousel
 * @param {string} [instructionOverride] - 입력창 대신 쓸 지시(후크 안 버튼이 넘긴다)
 * @param {string} [doneMessage] - 완료 토스트 문구
 */
async function handleRevise(type, instructionOverride, doneMessage) {
  if (!currentJobId) { showToast('생성이 완료된 후 수정할 수 있습니다'); return; }
  const instruction = (instructionOverride || $(`revise-${type}`).value).trim();
  if (!instruction) { $(`revise-${type}`).focus(); return; }

  const reviseBtn = document.querySelector(`.btn-revise[data-type="${type}"]`);
  reviseBtn.disabled = true;
  reviseBtn.textContent = '재생성 중…';

  // 이전 콘텍스트를 남겨 실패 시 되돌릴 수 있게 한다 (수정 실패로 원본까지 잃지 않도록)
  const previous = sectionContent[type];
  setCardLoading(type);

  // 카페 글이 바뀌면 📷 캡쳐 자리가 달라질 수 있어 서버가 캡쳐 가이드도 같이 갱신한다 — 그동안 캡쳐 카드에 표시
  const previousCapture = type === 'cafe' ? sectionContent.capture : null;
  if (type === 'cafe' && previousCapture) setCardLoading('capture', '카페 수정 반영 확인 중…');

  // 캐러셀 후크 안이 바뀌면 짝꿍 캡션 첫 두 줄도 따라간다(체크박스로 끌 수 있음) — 그동안 캡션 카드에 표시
  const alignEl = $('align-caption');
  const alignCaption = type === 'carousel' ? (alignEl ? alignEl.checked : true) : undefined;
  const previousCaption = type === 'carousel' && alignCaption ? sectionContent.caption : null;
  if (previousCaption) setCardLoading('caption', '캐러셀 채택안에 맞춰 확인 중…');

  try {
    const data = await apiFetch('POST', '/api/revise', { jobId: currentJobId, type, instruction, alignCaption });
    setCardContent(type, data.content);
    $(`revise-${type}`).value = '';

    if (type === 'carousel') {
      if (data.caption) {
        setCardContent('caption', data.caption);
        showToast(`${doneMessage || '캐러셀 수정 완료'} · 인스타 캡션 첫 줄도 선택한 안에 맞췄습니다`);
      } else {
        if (previousCaption) setCardContent('caption', previousCaption);
        if (data.captionError) showToast(`캐러셀 수정 완료 · 캡션 맞추기는 실패했습니다: ${data.captionError}`);
        else if (data.hookChanged) showToast(`${doneMessage || '캐러셀 수정 완료'} (캡션은 없어서 맞추지 않았습니다)`);
        else showToast(doneMessage || '수정 완료 (후크 안은 그대로라 캡션 유지)');
      }
    } else if (type === 'cafe') {
      if (data.capture) {
        setCardContent('capture', data.capture);
        showToast('카페 서머리 수정 완료 · 캡쳐 자리가 바뀌어 캡쳐 가이드도 새로 맞췄습니다');
      } else {
        if (previousCapture) setCardContent('capture', previousCapture);
        showToast(data.captureError
          ? `카페 수정 완료 · 캡쳐 가이드 갱신은 실패했습니다: ${data.captureError}`
          : (doneMessage || '수정 완료 (캡쳐 자리는 그대로라 캡쳐 가이드 유지)'));
      }
    } else {
      showToast(doneMessage || '수정 완료');
    }
  } catch (err) {
    if (previous) {
      setCardContent(type, previous);
      showToast(`⚠️ 수정 실패 — 이전 버전을 그대로 둡니다: ${err.message}`);
    } else {
      setCardError(type, err.message);
    }
    if (previousCapture) setCardContent('capture', previousCapture);
    if (previousCaption) setCardContent('caption', previousCaption);
  } finally {
    reviseBtn.disabled = false;
    reviseBtn.textContent = '재생성';
    refreshVersions(); // 새 버전(과 따라 바뀐 캡션·캡쳐 버전)을 목록에 반영
  }
}

// ─── 저장된 버전 오가기 ─────────────────────────────────────
// 모든 생성·수정 결과는 서버에 버전으로 남는다. 화면은 최신만 보여주지 말고,
// 이미 기획한 A안·B안 등을 토큰 없이 불러와 비교하고 "이 버전으로 확정"할 수 있게 한다.

/** /api/job 응답의 contents → versions 상태로 정리 */
function setVersions(contents) {
  TYPES.forEach((type) => {
    versions[type] = contents
      .filter((c) => c.type === type)
      .map((c) => ({ version: c.version, content: c.content, created_at: c.created_at }))
      .sort((a, b) => a.version - b.version);
  });
}

/** 서버에서 이력을 다시 읽어 선택 목록을 갱신 (지금 보는 버전은 유지) */
async function refreshVersions() {
  if (!currentJobId) return;
  try {
    const data = await apiFetch('GET', `/api/job/${currentJobId}`);
    setVersions(data.contents || []);
    TYPES.forEach((type) => {
      if (!sectionContent[type]) return;
      // 지금 카드에 떠 있는 내용과 같은 버전을 찾아 viewing을 맞춘다 (없으면 최신)
      const match = [...versions[type]].reverse().find((v) => v.content === sectionContent[type]);
      viewing[type] = match ? match.version : latestVersionOf(type);
      renderVersionSelect(type);
    });
  } catch {
    /* 목록 갱신 실패는 조용히 — 카드 내용에는 영향 없음 */
  }
}

function latestVersionOf(type) {
  const list = versions[type];
  return list.length ? list[list.length - 1].version : null;
}

function showLatestVersion(type) {
  const v = latestVersionOf(type);
  if (v == null) return;
  selectVersion(type, v);
}

/** 버전 라벨 — 캐러셀은 채택된 후크 안, 나머지는 시각 */
function versionLabel(type, row) {
  const t = row.created_at ? new Date(row.created_at) : null;
  const time = t && !isNaN(t) ? ` · ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}` : '';
  let desc = '';
  if (type === 'carousel') {
    const parsed = parseHookCandidates(row.content);
    if (parsed && parsed.adopted) {
      const c = parsed.cands.find((x) => x.key === parsed.adopted);
      desc = ` · ${parsed.adopted}안${c ? ` ${c.kind}` : ''}`;
    }
  } else if (type === 'caption') {
    const pairedCarousel = carouselVersionPairedWithCaption(row);
    if (pairedCarousel) desc = ` · 캐러셀 ${pairedCarousel}`;
  }
  return `v${row.version}${desc}${time}`;
}

function renderVersionSelect(type) {
  const sel = $(`version-${type}`);
  const confirmBtn = document.querySelector(`.btn-confirm-version[data-type="${type}"]`);
  if (!sel) return;
  const list = versions[type];
  if (list.length <= 1) {
    sel.setAttribute('hidden', '');
    if (confirmBtn) confirmBtn.setAttribute('hidden', '');
    return;
  }
  const latest = latestVersionOf(type);
  sel.innerHTML = '';
  [...list].reverse().forEach((row) => {
    const opt = document.createElement('option');
    opt.value = String(row.version);
    opt.textContent = versionLabel(type, row) + (row.version === latest ? ' (최신)' : '');
    if (row.version === viewing[type]) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.removeAttribute('hidden');
  const isOld = viewing[type] != null && viewing[type] !== latest;
  sel.classList.toggle('is-old', isOld);
  if (confirmBtn) confirmBtn.toggleAttribute('hidden', !isOld);
  // 옛 버전을 보는 동안은 수정 요청 입력을 막는다 — 서버의 수정은 항상 최신 버전을 기준으로 하기 때문.
  // 캐러셀은 후크 안 버튼(저장된 안 오가기)은 남기고 입력 행만 숨긴다 — 비교하는 중에 다른 안으로 넘어갈 수 있어야 한다.
  const revRow = $(`revision-${type}`);
  if (revRow && sectionContent[type]) {
    const inputRow = revRow.querySelector('.revision-input-row');
    if (inputRow) {
      revRow.removeAttribute('hidden');
      inputRow.toggleAttribute('hidden', isOld);
    } else {
      revRow.toggleAttribute('hidden', isOld);
    }
  }
}

/** 저장된 버전을 카드에 띄운다 (모델 호출 없음) */
function selectVersion(type, version) {
  const row = versions[type].find((v) => v.version === version);
  if (!row) return;
  viewing[type] = version;
  setCardContent(type, row.content);
  renderVersionSelect(type);
}

/** 지금 보는 버전을 최신으로 되살린다 (내용 복사 저장, 토큰 0). 캐러셀이면 함께 보던 옛 캡션도 같이 확정 */
async function confirmVersion(type) {
  if (!currentJobId || viewing[type] == null) return;
  const targets = [{ type, version: viewing[type] }];
  if (type === 'carousel' && viewing.caption != null && viewing.caption !== latestVersionOf('caption')) {
    targets.push({ type: 'caption', version: viewing.caption });
  }
  const btn = document.querySelector(`.btn-confirm-version[data-type="${type}"]`);
  if (btn) { btn.disabled = true; btn.textContent = '확정 중…'; }
  try {
    for (const t of targets) {
      await apiFetch('POST', '/api/content/restore', { jobId: currentJobId, type: t.type, version: t.version });
    }
    await refreshVersions();
    targets.forEach((t) => showLatestVersion(t.type));
    const names = targets.map((t) => `${CARD_NAMES[t.type]} v${t.version}`).join(', ');
    showToast(`${names}을(를) 최신 버전으로 확정했습니다 (토큰 사용 없음)`);
  } catch (err) {
    showToast(`⚠️ 버전 확정 실패: ${err.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '이 버전으로 확정'; }
  }
}

const CARD_NAMES = { cafe: '카페 서머리', caption: '인스타 캡션', carousel: '캐러셀 기획', capture: '캡쳐 가이드' };

/** 후크 안(A/B/C)이 채택된 가장 최근 저장 버전 — 없으면 null */
function savedCarouselVersionForHook(key) {
  for (const row of [...versions.carousel].reverse()) {
    const parsed = parseHookCandidates(row.content);
    if (parsed && parsed.adopted === key) return row;
  }
  return null;
}

/** 캐러셀 버전 V가 최신이던 시기에 함께 쓰이던 캡션 버전 (그 다음 캐러셀 버전이 생기기 전까지의 마지막 캡션) */
function pairedCaptionVersion(carouselVersion) {
  const list = versions.carousel;
  const idx = list.findIndex((v) => v.version === carouselVersion);
  if (idx < 0) return null;
  const next = list[idx + 1];
  const cutoff = next && next.created_at ? new Date(next.created_at).getTime() : Infinity;
  const candidates = versions.caption.filter((c) => {
    const t = c.created_at ? new Date(c.created_at).getTime() : 0;
    return t < cutoff;
  });
  return candidates.length ? candidates[candidates.length - 1] : null;
}

/** 캡션 버전 라벨용 — 이 캡션이 생길 때 최신이던 캐러셀의 채택안 */
function carouselVersionPairedWithCaption(captionRow) {
  const t = captionRow.created_at ? new Date(captionRow.created_at).getTime() : 0;
  const before = versions.carousel.filter((v) => (v.created_at ? new Date(v.created_at).getTime() : 0) <= t);
  const car = before.length ? before[before.length - 1] : null;
  if (!car) return null;
  const parsed = parseHookCandidates(car.content);
  return parsed && parsed.adopted ? `${parsed.adopted}안` : `v${car.version}`;
}

// ─── 캐러셀 후크 안 선택 ──────────────────────────────────
// 기획안 [기획 개요]의 후크 후보 표기(프롬프트가 고정한 계약):
//   · A안 [공감형] 헤드카피 → 근거
//   · B안 [참여유도형] 헤드카피 → 근거
//   · C안 [공감형] 헤드카피 → 근거
//   · 채택: A안 → 이유
// 개요 구간(첫 "## CUT" 이전)만 읽어 카드 텍스트와 섞이지 않게 한다.
const HOOK_CAND_RE = /^\s*[·•\-*]?\s*\**([ABC])안\**\s*[\[［(（]\s*(공감형|참여유도형)\s*[\]］)）]\s*[:：]?\s*(.+)$/;
const HOOK_ADOPT_RE = /^\s*[·•\-*]?\s*\**채택\**\s*[:：]?\s*\**\s*([ABC])안/;

function parseHookCandidates(text) {
  if (!text) return null;
  const cutIdx = text.search(/^##\s*CUT\s*\d+/m);
  const overview = cutIdx > 0 ? text.slice(0, cutIdx) : text;

  const byKey = new Map();
  let adopted = null;
  for (const raw of overview.split('\n')) {
    const m = raw.match(HOOK_CAND_RE);
    if (m) {
      const [, key, kind, rest] = m;
      // 근거는 → / — / | 뒤에 붙는다. 헤드카피만 남기고 감싼 따옴표·굵게 표시를 벗긴다.
      const head = rest.split(/\s*(?:→|—|\||--)\s*/)[0]
        .replace(/\*\*/g, '')
        .replace(/^["“「『']+|["”」』']+$/g, '')
        .trim();
      if (head && !byKey.has(key)) byKey.set(key, { key, kind, head });
      continue;
    }
    const a = raw.match(HOOK_ADOPT_RE);
    if (a && !adopted) adopted = a[1];
  }
  const cands = ['A', 'B', 'C'].filter((k) => byKey.has(k)).map((k) => byKey.get(k));
  if (cands.length < 2) return null; // 고를 게 없으면 버튼을 만들지 않는다 (자유 입력창은 그대로)
  return { cands, adopted };
}

function renderHookPicker(content) {
  const picker = $('hooks-carousel');
  const chips = $('hook-chips-carousel');
  if (!picker || !chips) return;
  chips.innerHTML = '';

  const parsed = parseHookCandidates(content);
  if (!parsed) { picker.setAttribute('hidden', ''); return; }

  parsed.cands.forEach(({ key, kind, head }) => {
    const isCurrent = key === parsed.adopted;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hook-chip' + (isCurrent ? ' is-current' : '');
    btn.disabled = isCurrent || !currentJobId;
    btn.title = isCurrent ? '현재 기획안이 채택한 안' : `${key}안(${kind})으로 1컷부터 다시 기획`;

    const keyEl = document.createElement('span');
    keyEl.className = 'hook-chip-key';
    keyEl.textContent = `${key}안 · ${kind}`;
    const headEl = document.createElement('span');
    headEl.className = 'hook-chip-head';
    headEl.textContent = head;
    // 이미 이 안으로 기획해 둔 버전이 있으면 토큰 없이 불러온다. 없을 때만 새로 기획한다.
    const saved = isCurrent ? null : savedCarouselVersionForHook(key);
    const tagEl = document.createElement('span');
    tagEl.className = 'hook-chip-tag';
    tagEl.textContent = isCurrent ? '현재 채택' : (saved ? `저장된 기획 보기 (v${saved.version})` : '이 안으로 다시 기획 →');
    if (saved) btn.title = `${key}안으로 이미 기획한 v${saved.version}을 불러옵니다 (토큰 사용 없음). 새로 기획하려면 아래 입력창에 "${key}안으로 다시 기획"이라고 적으세요.`;
    btn.append(keyEl, headEl, tagEl);

    if (!isCurrent && saved) {
      btn.addEventListener('click', () => {
        selectVersion('carousel', saved.version);
        const pairedCap = pairedCaptionVersion(saved.version);
        if (pairedCap && pairedCap.version !== viewing.caption) selectVersion('caption', pairedCap.version);
        const isLatest = saved.version === latestVersionOf('carousel');
        showToast(
          `${key}안(${kind})으로 기획해 둔 v${saved.version}을 불러왔습니다` +
          (pairedCap ? ` · 그때의 캡션 v${pairedCap.version}도 함께` : '') +
          (isLatest ? '' : ' — 이 안으로 갈 거면 "이 버전으로 확정"을 누르세요 (토큰 사용 없음)')
        );
      });
    } else if (!isCurrent) {
      btn.addEventListener('click', () => {
        const instruction =
          `후크 후보 ${key}안(${kind}) "${head}"을 채택안으로 바꿔 CUT 1부터 다시 기획한다. ` +
          `후크 후보 A안·B안·C안의 문구는 그대로 두고 '채택' 줄만 ${key}안으로 옮긴다. ` +
          `1컷이 바뀌면서 어긋나는 열린 고리·감정 곡선·연결 컷만 함께 맞추고, 나머지 컷은 유지한다.`;
        showToast(`${key}안(${kind})으로 다시 기획 중…`);
        handleRevise('carousel', instruction, `${key}안(${kind})으로 다시 기획했습니다`);
      });
    }
    chips.appendChild(btn);
  });
  picker.removeAttribute('hidden');
}

// ─── 노션 저장 ───────────────────────────────────────
async function handleSaveToNotion() {
  if (!currentJobId) return;
  $saveNotionBtn.disabled = true;
  $saveNotionBtn.textContent = '저장 중…';
  try {
    const data = await apiFetch('POST', '/api/save-to-notion', { jobId: currentJobId });
    showToast('노션에 저장됐습니다!');
    if (data.url) {
      setTimeout(() => window.open(data.url, '_blank'), 400);
    }
  } catch (err) {
    showToast(`⚠️ ${err.message}`);
  } finally {
    $saveNotionBtn.disabled = false;
    $saveNotionBtn.textContent = '노션에 저장';
  }
}

// ─── 전체 기획 다시하기 (컨셉 기준 4종 재생성) ──────────────
async function handleRegenAll() {
  if (!currentJobId) { showToast('생성이 완료된 후 다시 기획할 수 있습니다'); return; }
  const concept = $conceptRedo.value.trim();
  if (!concept) { $conceptRedo.focus(); return; }
  if (!confirm('카페·캡션·캐러셀·캡쳐 4종을 이 컨셉으로 처음부터 다시 기획합니다.\n이전 버전은 이력에 남습니다. 진행할까요?')) return;

  $regenAllBtn.disabled = true;
  $regenAllBtn.textContent = '4종 다시 기획 중…';
  $regenRow.setAttribute('hidden', '');
  TYPES.forEach((t) => { sectionContent[t] = null; });
  TYPES.forEach((t) => setCardLoading(t, '컨셉에 맞춰 다시 기획 중…'));
  $results.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const res = await fetch('/api/regenerate-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: currentJobId, concept }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `서버 오류 (HTTP ${res.status})`);
    }
    await readSSE(res, handleSSEEvent);
    showToast('컨셉에 맞춰 4종을 다시 기획했습니다');
  } catch (err) {
    TYPES.forEach((t) => { if (!sectionContent[t]) setCardError(t, err.message); });
  } finally {
    $regenAllBtn.textContent = '이 컨셉으로 4종 다시 기획';
    $regenAllBtn.disabled = !currentJobId || !$conceptRedo.value.trim();
  }
}

// ─── 캐러셀·캡쳐 재생성 ──────────────────────────────────
async function handleRegenSecondary() {
  if (!currentJobId) return;

  $regenBtn.disabled = true;
  $regenBtn.textContent = '재생성 중…';
  setCardLoading('carousel');
  setCardLoading('capture');

  try {
    const data = await apiFetch('POST', '/api/regenerate', { jobId: currentJobId });
    setCardContent('carousel', data.carousel);
    setCardContent('capture', data.capture);
    $saveNotionBtn.disabled = !TYPES.every((t) => sectionContent[t]);
    showToast('캐러셀·캡쳐 가이드 재생성 완료');
    refreshVersions();
  } catch (err) {
    setCardError('carousel', err.message);
    setCardError('capture', err.message);
  } finally {
    $regenBtn.disabled = false;
    $regenBtn.textContent = '캐러셀·캡쳐 가이드 재생성';
  }
}

// ─── 보이스 프로파일 갱신 ────────────────────────────────
async function handleLearnVoice() {
  if (!confirm('인스타그램 캡션을 수집해 보이스 프로파일을 갱신합니다. 진행하시겠어요?')) return;
  $learnBtn.disabled = true;
  $learnBtn.textContent = '학습 중…';
  try {
    const data = await apiFetch('POST', '/api/learn-voice');
    showToast(data.message || '보이스 프로파일 갱신 완료');
    await checkStatus(); // 프로파일 있음으로 상태 갱신
  } catch (err) {
    showToast(`⚠️ ${err.message}`);
  } finally {
    $learnBtn.disabled = false;
    $learnBtn.textContent = '보이스 프로파일 갱신';
  }
}

// ─── 캡션 직접 입력 ──────────────────────────────────────────
async function handleLearnVoiceManual() {
  const raw = $manualInput.value.trim();
  if (!raw) { $manualInput.focus(); return; }
  const captions = raw.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  if (captions.length < 3) { showToast('캡션을 3개 이상 입력해주세요 (빈 줄로 구분)'); return; }

  $manualSubmit.disabled = true;
  $manualSubmit.textContent = '학습 중…';
  try {
    const data = await apiFetch('POST', '/api/learn-voice-text', { captions });
    $manualModal.setAttribute('hidden', '');
    showToast(data.message || '보이스 프로파일 갱신 완료');
    await checkStatus();
  } catch (err) {
    showToast(`⚠️ ${err.message}`);
  } finally {
    $manualSubmit.disabled = false;
    $manualSubmit.textContent = '학습 시작';
  }
}

// ─── Instagram 토큰 교환 ──────────────────────────────────
async function handleExchangeToken() {
  const shortToken = prompt(
    'Graph API Explorer에서 발급한 단기 토큰을 붙여넣으세요.\n' +
    '(developers.facebook.com/tools/explorer → "토큰 생성" → 복사)'
  );
  if (!shortToken || !shortToken.trim()) return;
  $exchangeTokenBtn.disabled = true;
  $exchangeTokenBtn.textContent = '교환 중…';
  try {
    const data = await apiFetch('POST', '/api/exchange-token', { shortToken: shortToken.trim() });
    showToast(data.message || '장기 토큰 교환 완료');
  } catch (err) {
    showToast(`⚠️ ${err.message}`);
  } finally {
    $exchangeTokenBtn.disabled = false;
    $exchangeTokenBtn.textContent = 'Instagram 토큰 교환';
  }
}

// ─── 유틸 ─────────────────────────────────────────────────
function setGenerating(on) {
  $genBtn.disabled = on;
  $genBtn.textContent = on ? '생성 중…' : '생성 시작';
}

async function apiFetch(method, path, body) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `서버 오류 (HTTP ${res.status})`);
  return data;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(message) {
  const prev = document.querySelector('.toast');
  if (prev) prev.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  // 긴 메시지(주로 오류 안내)는 읽을 시간을 충분히 준다
  const duration = message.length > 40 ? Math.min(9000, 3500 + message.length * 30) : 2200;
  setTimeout(() => el.remove(), duration);
}
