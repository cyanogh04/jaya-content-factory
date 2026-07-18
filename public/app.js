// public/app.js — 자야쌤 콘텐츠 공장 프론트엔드
// SSE(POST) 수신, 섹션별 렌더링, 수정 요청, 캐러셀·캡쳐 재생성

'use strict';

// ─── 상태 ────────────────────────────────────────────────
let currentJobId = null;
const sectionContent = { cafe: null, caption: null, carousel: null, capture: null };
const TYPES = ['cafe', 'caption', 'carousel', 'capture'];

// ─── DOM 참조 ─────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const $url        = $('url-input');
const $topic      = $('topic-input');
const $genBtn     = $('generate-btn');
const $results    = $('results');
const $statusBar  = $('status-bar');
const $regenRow   = $('regen-row');
const $regenBtn       = $('regen-btn');
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

  // 수정 입력창 Enter
  ['cafe', 'caption'].forEach((type) => {
    $(`revise-${type}`).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleRevise(type);
    });
  });

  // 캐러셀·캡쳐 재생성
  $regenBtn.addEventListener('click', handleRegenSecondary);

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

    TYPES.forEach((type) => {
      const rows = (data.contents || []).filter((c) => c.type === type);
      if (rows.length === 0) {
        setCardEmpty(type);
        return;
      }
      const latest = rows.reduce((a, b) => (a.version >= b.version ? a : b));
      setCardContent(type, latest.content);
    });

    if (sectionContent['cafe'] && sectionContent['caption']) {
      $regenRow.removeAttribute('hidden');
      $saveNotionBtn.disabled = !TYPES.every((t) => sectionContent[t]);
    }
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

  // 상태 초기화
  currentJobId = null;
  setActiveHistoryItem(null); // 새 생성 시작 — 히스토리 선택 해제
  TYPES.forEach((t) => { sectionContent[t] = null; });
  $regenRow.setAttribute('hidden', '');

  // 결과 영역 표시 + 스피너
  $results.removeAttribute('hidden');
  TYPES.forEach(setCardLoading);

  setGenerating(true);

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, topic: topic || undefined }),
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
    loadHistory(); // 방금 만든 작업이 히스토리에 바로 보이도록 갱신
  } else if (event === 'error') {
    TYPES.forEach((t) => { if (!sectionContent[t]) setCardError(t, data.error); });
  }
}

// ─── 섹션 상태 관리 ──────────────────────────────────────
function setCardLoading(type) {
  const body = $(`body-${type}`);
  body.innerHTML = `<div class="skeleton-wrap"><div class="spinner"></div><p class="loading-text">생성 중…</p></div>`;
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

  // 수정 요청 행 표시 (cafe, caption만) — jobId가 있을 때 버튼도 활성화
  const revRow = $(`revision-${type}`);
  if (revRow) {
    revRow.removeAttribute('hidden');
    const reviseBtn = revRow.querySelector('.btn-revise');
    if (reviseBtn) reviseBtn.disabled = !currentJobId;
  }

  // 재생성 버튼은 done 이벤트에서만 표시 (race condition 방지)
}

/** 히스토리에서 연 작업에 해당 섹션 콘텐츠가 없을 때 */
function setCardEmpty(type) {
  sectionContent[type] = null;
  const body = $(`body-${type}`);
  body.innerHTML = '<p class="empty-msg">이 작업에서는 생성되지 않은 섹션입니다.</p>';
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
async function handleRevise(type) {
  if (!currentJobId) { showToast('생성이 완료된 후 수정할 수 있습니다'); return; }
  const instruction = $(`revise-${type}`).value.trim();
  if (!instruction) { $(`revise-${type}`).focus(); return; }

  const reviseBtn = document.querySelector(`.btn-revise[data-type="${type}"]`);
  reviseBtn.disabled = true;
  reviseBtn.textContent = '재생성 중…';

  setCardLoading(type);

  try {
    const data = await apiFetch('POST', '/api/revise', { jobId: currentJobId, type, instruction });
    setCardContent(type, data.content);
    $(`revise-${type}`).value = '';
    showToast('수정 완료');
  } catch (err) {
    setCardError(type, err.message);
  } finally {
    reviseBtn.disabled = false;
    reviseBtn.textContent = '재생성';
  }
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
