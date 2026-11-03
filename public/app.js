// public/app.js — 자야쌤 콘텐츠 공장 프론트엔드
// 작업함(지난 작업) + 새 기획(강의 하나 / 강좌 묶기 2~4강) + 작업 공간(짝으로 묶인 결과 탭)
// SSE(POST) 수신, 섹션별 렌더링, 수정 요청, 저장된 버전 오가기, 캐러셀·캡쳐 재생성, 전체 기획 다시하기
//
// 2026-11-04: 강좌 묶기 추가와 함께 화면을 작업함/작업 공간으로 다시 짰다. 결과는 짝으로 탭에 놓는다 —
// 카페 글(카페 서머리 | 캡쳐 가이드: 📷 자리로 이어짐), 인스타 게시물(캐러셀 기획 | 캡션: 같은 게시물).

'use strict';

// ─── 상태 ────────────────────────────────────────────────
let currentJobId = null;
let currentJob = null;      // { video_title, vimeo_url, created_at, kind … }
let currentCourse = null;   // 강좌면 { name, lectures: [{ n, title, duration, url, jobId }] }
let lectureMapText = null;  // 강의 지도(강좌면 강좌 지도)
let composerMode = 'single'; // 'single' | 'course'
let allJobs = [];
const TYPES = ['cafe', 'caption', 'carousel', 'capture'];
const CARD_NAMES = { cafe: '카페 서머리', caption: '인스타 캡션', carousel: '캐러셀 기획', capture: '캡쳐 가이드' };
const sectionContent = { cafe: null, caption: null, carousel: null, capture: null };
// 저장된 버전 이력 — 한 번 기획한 A안/B안 등은 토큰을 다시 쓰지 않고 오가며 비교한다
const versions = { cafe: [], caption: [], carousel: [], capture: [] };
const viewing = { cafe: null, caption: null, carousel: null, capture: null };
const PACK_OF = { cafe: 'cafe-pack', capture: 'cafe-pack', carousel: 'insta-pack', caption: 'insta-pack' };
const MAX_SLOTS = 4;

// ─── DOM ─────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const $composer = $('composer');
const $workspace = $('workspace');
const $slots = $('slots');
const $addSlot = $('add-slot-btn');
const $slotsHint = $('slots-hint');
const $courseNameField = $('course-name-field');
const $courseName = $('course-name-input');
const $topic = $('topic-input');
const $concept = $('concept-input');
const $genBtn = $('generate-btn');
const $composerNote = $('composer-note');
const $statusBar = $('status-bar');
const $historyList = $('history-list');
const $historyCount = $('history-count');
const $historyEmpty = $('history-empty');
const $progress = $('progress');
const $lectureStrip = $('lecture-strip');
const $conceptRedo = $('concept-redo');
const $regenAllBtn = $('regen-all-btn');
const $regenBtn = $('regen-btn');
const $saveNotionBtn = $('save-notion-btn');
const $copyAllBtn = $('copy-all-btn');
const $manualModal = $('manual-caption-modal');
const $manualInput = $('manual-captions-input');

// ─── 초기화 ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  checkStatus();
  bindEvents();
  renderSlots();
  loadHistory();
});

async function checkStatus() {
  try {
    const data = await apiFetch('GET', '/api/status');
    const warnings = [];
    if (data.missing && data.missing.length > 0) {
      warnings.push(`필수 환경변수가 비어 있어요: ${data.missing.join(', ')} — 서버의 .env 파일을 확인하세요.`);
    }
    if (!data.hasVoiceProfile) {
      warnings.push('보이스 프로파일이 없어요. 아래 [보이스 프로파일 갱신]을 먼저 실행하세요.');
    }
    if (warnings.length > 0) {
      $statusBar.textContent = warnings.join(' / ');
      $statusBar.removeAttribute('hidden');
    }
  } catch {
    /* 상태 확인 실패는 조용히 */
  }
}

function bindEvents() {
  $('new-btn').addEventListener('click', showComposer);
  document.querySelectorAll('.mode-btn').forEach((btn) => btn.addEventListener('click', () => setMode(btn.dataset.mode)));
  $addSlot.addEventListener('click', () => addSlot());
  $genBtn.addEventListener('click', handleGenerate);
  $courseName.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleGenerate(); });

  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => showTab(tab.dataset.tab)));

  document.querySelectorAll('.btn-copy').forEach((btn) => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.target;
      const text = type === 'map' ? lectureMapText : sectionContent[type];
      if (!text) return;
      copyText(text, '클립보드에 복사했어요');
    });
  });
  $copyAllBtn.addEventListener('click', handleCopyAll);

  document.querySelectorAll('.btn-revise').forEach((btn) => btn.addEventListener('click', () => handleRevise(btn.dataset.type)));
  ['cafe', 'caption', 'carousel'].forEach((type) => {
    $(`revise-${type}`).addEventListener('keydown', (e) => { if (e.key === 'Enter') handleRevise(type); });
  });

  TYPES.forEach((type) => $(`version-${type}`).addEventListener('change', (e) => selectVersion(type, Number(e.target.value))));
  document.querySelectorAll('.btn-confirm-version').forEach((btn) => btn.addEventListener('click', () => confirmVersion(btn.dataset.type)));

  $regenBtn.addEventListener('click', handleRegenSecondary);
  $conceptRedo.addEventListener('input', updateRedoButton);
  $regenAllBtn.addEventListener('click', handleRegenAll);
  $saveNotionBtn.addEventListener('click', handleSaveToNotion);

  $('learn-voice-btn').addEventListener('click', handleLearnVoice);
  $('exchange-token-btn').addEventListener('click', handleExchangeToken);
  $('learn-voice-manual-btn').addEventListener('click', () => {
    $manualInput.value = '';
    $manualModal.removeAttribute('hidden');
    $manualInput.focus();
  });
  $('manual-caption-cancel').addEventListener('click', () => $manualModal.setAttribute('hidden', ''));
  $manualModal.addEventListener('click', (e) => { if (e.target === $manualModal) $manualModal.setAttribute('hidden', ''); });
  $('manual-caption-submit').addEventListener('click', handleLearnVoiceManual);
}

// ─── 화면 전환 ───────────────────────────────────────────
function showComposer() {
  $workspace.setAttribute('hidden', '');
  $composer.removeAttribute('hidden');
  setActiveHistoryItem(null);
  const first = $slots.querySelector('input.slot-url:not(:disabled)');
  if (first) first.focus();
}

function showWorkspace() {
  $composer.setAttribute('hidden', '');
  $workspace.removeAttribute('hidden');
}

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle('is-on', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.pack').forEach((p) => p.toggleAttribute('hidden', p.id !== `pack-${name}`));
}

// ─── 새 기획: 모드·슬롯 ───────────────────────────────────
function setMode(mode) {
  composerMode = mode;
  document.querySelectorAll('.mode-btn').forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  renderSlots();
}

/** 슬롯 상태는 DOM이 쥔다 — 모드를 바꾸면 1강 입력은 남기고 수를 맞춘다 */
function renderSlots() {
  const kept = readSlots();
  const want = composerMode === 'course' ? Math.max(2, kept.length) : 1;
  $slots.innerHTML = '';
  $slots.classList.toggle('is-course', composerMode === 'course');
  for (let i = 0; i < Math.min(want, MAX_SLOTS); i++) addSlot(kept[i]);
  $addSlot.toggleAttribute('hidden', composerMode !== 'course');
  $courseNameField.toggleAttribute('hidden', composerMode !== 'course');
  updateSlotsUI();
}

function addSlot(preset) {
  const count = $slots.children.length;
  if (count >= MAX_SLOTS) return;
  const n = count + 1;
  const row = document.createElement('div');
  row.className = 'slot';
  row.innerHTML = `
    <span class="slot-n">${composerMode === 'course' ? `${n}강` : '강의'}</span>
    <input type="url" class="input slot-url" placeholder="https://vimeo.com/…" autocomplete="off" spellcheck="false" />
    <select class="slot-pick" title="이미 자막을 받아 둔 지난 작업을 이 강으로 씁니다 (자막 수집 없음)"></select>
    <button type="button" class="slot-remove" title="이 강 빼기" aria-label="이 강 빼기">×</button>`;
  const url = row.querySelector('.slot-url');
  const pick = row.querySelector('.slot-pick');
  fillPickOptions(pick);
  if (preset?.jobId) pick.value = preset.jobId;
  if (preset?.url) url.value = preset.url;
  pick.addEventListener('change', () => {
    row.classList.toggle('is-picked', !!pick.value);
    url.disabled = !!pick.value;
    if (pick.value) url.value = '';
    updateSlotsUI();
  });
  url.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleGenerate(); });
  url.addEventListener('input', updateSlotsUI);
  row.querySelector('.slot-remove').addEventListener('click', () => { row.remove(); renumberSlots(); updateSlotsUI(); });
  if (pick.value) { row.classList.add('is-picked'); url.disabled = true; }
  $slots.appendChild(row);
  updateSlotsUI();
}

function fillPickOptions(select) {
  const prev = select.value;
  select.innerHTML = '<option value="">지난 작업에서 고르기…</option>';
  allJobs.filter((j) => j.kind !== 'course').forEach((j) => {
    const opt = document.createElement('option');
    opt.value = j.id;
    opt.textContent = `${jobTitle(j)} · ${fmtDate(j.created_at)}`;
    select.appendChild(opt);
  });
  if (prev) select.value = prev;
}

function renumberSlots() {
  [...$slots.children].forEach((row, i) => {
    row.querySelector('.slot-n').textContent = composerMode === 'course' ? `${i + 1}강` : '강의';
  });
}

function updateSlotsUI() {
  const rows = [...$slots.children];
  const count = rows.length;
  rows.forEach((row) => { row.querySelector('.slot-remove').disabled = composerMode !== 'course' || count <= 2; });
  $addSlot.disabled = count >= MAX_SLOTS;
  if (composerMode === 'course') {
    const filled = readSlots().length;
    $slotsHint.textContent = count >= MAX_SLOTS
      ? '강좌는 최대 4강까지 묶어요.'
      : `${count}강 구성. 이미 기획했던 강은 ‘지난 작업에서 고르기’로 넣으면 자막을 다시 받지 않아요.`;
    $composerNote.textContent = filled >= 2 ? `${filled}강을 한 번에 읽고 강좌 하나로 기획해요.` : '강좌는 2강 이상이 필요해요.';
  } else {
    $slotsHint.textContent = '';
    $composerNote.textContent = '';
  }
}

/** 슬롯 → [{ url } | { jobId }] (빈 칸 제외, 순서 유지) */
function readSlots() {
  return [...$slots.children]
    .map((row) => {
      const jobId = row.querySelector('.slot-pick')?.value;
      const url = row.querySelector('.slot-url')?.value.trim();
      if (jobId) return { jobId };
      if (url) return { url };
      return null;
    })
    .filter(Boolean);
}

// ─── 지난 작업 ────────────────────────────────────────────
async function loadHistory() {
  try {
    const data = await apiFetch('GET', '/api/jobs');
    allJobs = data.jobs || [];
    renderHistory(allJobs);
    document.querySelectorAll('.slot-pick').forEach(fillPickOptions);
  } catch {
    /* 히스토리 로드 실패는 조용히 — 메인 기능에 영향 없음 */
  }
}

function jobTitle(job) {
  return job.topic && job.kind !== 'course'
    ? job.topic
    : job.video_title || (job.vimeo_url ? `영상 ${job.vimeo_url.split('/').pop()}` : '제목 없음');
}

function fmtDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : `${d.getFullYear()}. ${String(d.getMonth() + 1).padStart(2, '0')}. ${String(d.getDate()).padStart(2, '0')}`;
}

function renderHistory(jobs) {
  $historyList.innerHTML = '';
  $historyEmpty.toggleAttribute('hidden', jobs.length > 0);
  $historyCount.textContent = jobs.length ? `${jobs.length}건` : '';
  jobs.forEach((job) => {
    const li = document.createElement('li');
    li.className = 'history-item';
    li.tabIndex = 0;
    li.dataset.jobId = job.id;
    if (job.id === currentJobId) li.classList.add('is-active');
    const isCourse = job.kind === 'course';
    const kind = document.createElement('span');
    kind.className = 'history-kind' + (isCourse ? ' is-course' : '');
    kind.textContent = isCourse ? `${job.lecture_count || ''}강` : '강의';
    kind.title = isCourse ? `강좌 (${job.lecture_count}강 묶음)` : '강의 하나';
    const title = document.createElement('span');
    title.className = 'history-title';
    title.textContent = jobTitle(job);
    title.title = title.textContent;
    const date = document.createElement('span');
    date.className = 'history-date';
    date.textContent = fmtDate(job.created_at);
    li.append(kind, title, date);
    li.addEventListener('click', () => openJob(job.id, li));
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') openJob(job.id, li); });
    $historyList.appendChild(li);
  });
}

function setActiveHistoryItem(itemEl) {
  document.querySelectorAll('.history-item.is-active').forEach((el) => el.classList.remove('is-active'));
  if (itemEl) itemEl.classList.add('is-active');
}

/** 지난 작업 열기 — 저장된 콘텐츠(타입별 최신 버전)를 카드에 표시 */
async function openJob(jobId, itemEl) {
  setActiveHistoryItem(itemEl);
  showWorkspace();
  $progress.setAttribute('hidden', '');
  TYPES.forEach((t) => setCardLoading(t, '불러오는 중…'));
  try {
    const data = await apiFetch('GET', `/api/job/${jobId}`);
    currentJobId = jobId;
    currentJob = data.job;
    currentCourse = data.course || null;
    TYPES.forEach((t) => { sectionContent[t] = null; });
    renderHeader();
    setVersions(data.contents || []);
    TYPES.forEach((type) => (versions[type].length ? showLatestVersion(type) : setCardEmpty(type)));
    setLectureMap(latestOf(data.contents || [], 'lecture_map'));
    $conceptRedo.value = latestOf(data.contents || [], 'concept') || '';
    updateJobButtons();
    showTab('cafe-pack');
  } catch (err) {
    TYPES.forEach((t) => setCardError(t, err.message));
    showToast(`⚠️ ${err.message}`);
  }
}

function latestOf(contents, type) {
  const rows = contents.filter((c) => c.type === type && typeof c.content === 'string');
  if (rows.length === 0) return '';
  return rows.reduce((a, b) => (a.version >= b.version ? a : b)).content.trim();
}

// ─── 작업 공간 머리 ───────────────────────────────────────
function renderHeader() {
  const isCourse = !!currentCourse;
  $('ws-kind').textContent = isCourse ? `강좌 · ${currentCourse.lectures.length}강 묶음` : '강의 하나';
  $('ws-title').textContent = isCourse ? currentCourse.name : (currentJob?.video_title || currentJob?.topic || '제목 없음');
  const meta = [];
  if (currentJob?.created_at) meta.push(fmtDate(currentJob.created_at));
  if (currentJob?.topic) meta.push(`주제: ${currentJob.topic}`);
  $('ws-meta').textContent = meta.join(' · ');
  $('map-title').textContent = isCourse ? '강좌 지도' : '강의 지도';

  $lectureStrip.innerHTML = '';
  const lectures = isCourse
    ? currentCourse.lectures
    : [{ n: 1, title: currentJob?.video_title || '', url: currentJob?.vimeo_url }];
  lectures.forEach((lec) => {
    const li = document.createElement('li');
    const n = document.createElement('span');
    n.className = 'lec-n';
    n.textContent = isCourse ? lec.n : '▶';
    const t = document.createElement(lec.url ? 'a' : 'span');
    t.className = 'lec-title';
    t.textContent = lec.title || '제목 없음';
    t.title = t.textContent;
    if (lec.url) { t.href = lec.url; t.target = '_blank'; t.rel = 'noopener'; }
    li.append(n, t);
    if (lec.duration) {
      const d = document.createElement('span');
      d.className = 'lec-dur';
      d.textContent = `${Math.round(lec.duration / 60)}분`;
      li.appendChild(d);
    }
    $lectureStrip.appendChild(li);
  });
}

function setLectureMap(text) {
  lectureMapText = text || null;
  const body = $('body-map');
  body.innerHTML = '';
  if (!text) {
    body.innerHTML = '<p class="empty-msg">아직 지도가 없어요. 캡션이나 캐러셀을 수정하면 그때 만들어져요.</p>';
  } else {
    const pre = document.createElement('pre');
    pre.className = 'content-pre';
    pre.textContent = text;
    body.appendChild(pre);
  }
  document.querySelector('.btn-copy[data-target="map"]').disabled = !text;
}

function updateJobButtons() {
  const both = !!(sectionContent.cafe && sectionContent.caption);
  $regenBtn.disabled = !currentJobId || !both;
  $saveNotionBtn.disabled = !currentJobId || !TYPES.every((t) => sectionContent[t]);
  $copyAllBtn.disabled = !TYPES.some((t) => sectionContent[t]);
  updateRedoButton();
}
function updateRedoButton() {
  $regenAllBtn.disabled = !currentJobId || !$conceptRedo.value.trim();
}

// ─── 생성 진행 띠 ─────────────────────────────────────────
let progressSteps = []; // [{ key, label }]
function buildProgress(lectureCount) {
  progressSteps = [];
  if (lectureCount >= 2) {
    for (let n = 1; n <= lectureCount; n++) progressSteps.push({ key: `transcript-${n}`, label: `${n}강 자막` });
    for (let n = 1; n <= lectureCount; n++) progressSteps.push({ key: `lecture_map-${n}`, label: `${n}강 강의 지도` });
    progressSteps.push({ key: 'course_map', label: '강좌 지도' });
  } else {
    progressSteps.push({ key: 'transcript-1', label: '자막 수집' });
    progressSteps.push({ key: 'lecture_map-1', label: '강의 지도' });
  }
  TYPES.slice().sort((a, b) => ['cafe', 'caption', 'carousel', 'capture'].indexOf(a) - ['cafe', 'caption', 'carousel', 'capture'].indexOf(b))
    .forEach((t) => progressSteps.push({ key: t, label: CARD_NAMES[t] }));
  $progress.innerHTML = '';
  progressSteps.forEach((s) => {
    const li = document.createElement('li');
    li.dataset.key = s.key;
    li.textContent = s.label;
    $progress.appendChild(li);
  });
  $progress.removeAttribute('hidden');
  markProgress('transcript-1');
}
/** key 단계를 진행 중으로, 그 앞은 완료로 */
function markProgress(key, state = 'now') {
  const items = [...$progress.children];
  const idx = items.findIndex((li) => li.dataset.key === key);
  if (idx < 0) return;
  items.forEach((li, i) => {
    li.classList.remove('is-now');
    if (i < idx) { li.classList.add('is-done'); }
  });
  items[idx].classList.toggle('is-now', state === 'now');
  items[idx].classList.toggle('is-done', state === 'done');
  items[idx].classList.toggle('is-bad', state === 'bad');
}
function finishProgress() {
  [...$progress.children].forEach((li) => { li.classList.remove('is-now'); if (!li.classList.contains('is-bad')) li.classList.add('is-done'); });
}

// ─── 생성 ─────────────────────────────────────────────────
async function handleGenerate() {
  const lectures = readSlots();
  if (composerMode === 'single') {
    if (lectures.length === 0 || !lectures[0].url) {
      const first = $slots.querySelector('.slot-url');
      if (first) first.focus();
      showToast('비메오 링크를 넣어 주세요');
      return;
    }
  } else if (lectures.length < 2) {
    showToast('강좌는 2강 이상 넣어야 해요');
    return;
  } else if (lectures.every((l) => l.jobId)) {
    // 전부 지난 작업이어도 된다 — 자막 수집 없이 강좌 지도부터 간다
  }
  const topic = $topic.value.trim();
  const concept = $concept.value.trim();
  const name = composerMode === 'course' ? $courseName.value.trim() : '';

  // 상태 초기화
  currentJobId = null;
  currentJob = null;
  currentCourse = null;
  setActiveHistoryItem(null);
  TYPES.forEach((t) => { sectionContent[t] = null; versions[t] = []; viewing[t] = null; });
  setLectureMap(null);
  $conceptRedo.value = concept;

  showWorkspace();
  $('ws-kind').textContent = composerMode === 'course' ? `강좌 · ${lectures.length}강 묶음` : '강의 하나';
  $('ws-title').textContent = name || (composerMode === 'course' ? '강좌 이름은 자막을 읽은 뒤 정해져요' : '자막을 받는 중…');
  $('ws-meta').textContent = '';
  $lectureStrip.innerHTML = '';
  buildProgress(composerMode === 'course' ? lectures.length : 1);
  TYPES.forEach((t) => setCardLoading(t, '차례를 기다리는 중…'));
  updateJobButtons();
  showTab('cafe-pack');
  setGenerating(true);

  try {
    const body = composerMode === 'course'
      ? { lectures, name: name || undefined, topic: topic || undefined, concept: concept || undefined }
      : { url: lectures[0].url, topic: topic || undefined, concept: concept || undefined };
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `서버 오류 (HTTP ${res.status})`);
    }
    await readSSE(res, handleSSEEvent);
  } catch (err) {
    TYPES.forEach((t) => { if (!sectionContent[t]) setCardError(t, err.message); });
    const now = $progress.querySelector('.is-now');
    if (now) markProgress(now.dataset.key, 'bad');
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
    buffer = lines.pop();
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        try { onEvent(eventType, JSON.parse(line.slice(6))); } catch { /* JSON 파싱 실패 무시 */ }
        eventType = 'message';
      }
    }
  }
}

function handleSSEEvent(event, data) {
  if (event === 'start') {
    currentJobId = data.jobId; // 작업 ID 즉시 확보 — 첫 섹션 완료 직후 수정 가능
    if (data.course) {
      currentCourse = data.course;
      currentJob = { video_title: data.course.name, created_at: new Date().toISOString() };
      renderHeader();
      markProgress(`lecture_map-1`);
    } else {
      markProgress('lecture_map-1');
    }
    loadHistory(); // 강좌면 강별 작업도 목록에 생겼다
  } else if (event === 'progress') {
    if (data.type === 'stage') {
      if (data.stage === 'transcript') markProgress(`transcript-${data.n}`);
      else if (data.stage === 'lecture_map') markProgress(`lecture_map-${data.n}`);
      else if (data.stage === 'course_map') markProgress('course_map');
      // 단일 강의 지도가 끝나면 카페 차례 — 서버는 4종 완료 때만 알리므로 지도 뒤 첫 섹션을 진행 중으로
      return;
    }
    if (data.error) {
      setCardError(data.type, data.error);
      markProgress(data.type, 'bad');
    } else {
      setCardContent(data.type, data.content);
      markProgress(data.type, 'done');
      const next = TYPES[TYPES.indexOf(data.type) + 1];
      if (next) markProgress(next);
      if (!currentJob) { currentJob = { created_at: new Date().toISOString() }; }
      if (PACK_OF[data.type] && data.type === 'cafe') showTab('cafe-pack');
      if (data.type === 'carousel') showTab('insta-pack');
    }
  } else if (event === 'done') {
    if (!currentJobId) currentJobId = data.jobId;
    finishProgress();
    updateJobButtons();
    refreshVersions();
    loadHistory();
    refreshJobMeta();
  } else if (event === 'error') {
    TYPES.forEach((t) => { if (!sectionContent[t]) setCardError(t, data.error); });
    const now = $progress.querySelector('.is-now');
    if (now) markProgress(now.dataset.key, 'bad');
  }
}

/** 생성이 끝난 뒤 제목·강 띠·지도를 서버 기준으로 채운다 */
async function refreshJobMeta() {
  if (!currentJobId) return;
  try {
    const data = await apiFetch('GET', `/api/job/${currentJobId}`);
    currentJob = data.job;
    currentCourse = data.course || null;
    renderHeader();
    setLectureMap(latestOf(data.contents || [], 'lecture_map'));
    const item = document.querySelector(`.history-item[data-job-id="${currentJobId}"]`);
    setActiveHistoryItem(item);
  } catch { /* 머리 정보 갱신 실패는 조용히 */ }
}

// ─── 카드 상태 ───────────────────────────────────────────
function setCardLoading(type, text = '생성 중…') {
  const body = $(`body-${type}`);
  body.innerHTML = `<div class="loading"><div class="spinner"></div><p>${escapeHtml(text)}</p></div>`;
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
  card.classList.remove('is-error');
  card.classList.add('is-done');
  card.querySelector('.btn-copy').disabled = false;

  if (type === 'cafe' || type === 'caption') {
    const chars = content.replace(/\s/g, '').length;
    $(`count-${type}`).textContent = `${chars.toLocaleString()}자`;
  }
  const revRow = $(`revision-${type}`);
  if (revRow) {
    revRow.removeAttribute('hidden');
    const reviseBtn = revRow.querySelector('.btn-revise');
    if (reviseBtn) reviseBtn.disabled = !currentJobId;
  }
  if (type === 'carousel') renderHookPicker(content);
  updateJobButtons();
}

function setCardEmpty(type) {
  sectionContent[type] = null;
  $(`body-${type}`).innerHTML = '<p class="empty-msg">이 작업에서는 아직 만들지 않은 섹션이에요.</p>';
  viewing[type] = null;
  $(`version-${type}`).setAttribute('hidden', '');
  document.querySelector(`.btn-confirm-version[data-type="${type}"]`).setAttribute('hidden', '');
  const card = $(`card-${type}`);
  card.classList.remove('is-done', 'is-error');
  card.querySelector('.btn-copy').disabled = true;
  const reviseBtn = card.querySelector('.btn-revise');
  if (reviseBtn) reviseBtn.disabled = true;
  const revRow = $(`revision-${type}`);
  if (revRow) revRow.setAttribute('hidden', '');
  if (type === 'cafe' || type === 'caption') $(`count-${type}`).textContent = '';
}

function setCardError(type, message) {
  sectionContent[type] = null;
  $(`body-${type}`).innerHTML = `<p class="error-msg">⚠️ ${escapeHtml(message)}</p>`;
  const card = $(`card-${type}`);
  card.classList.remove('is-done');
  card.classList.add('is-error');
  card.querySelector('.btn-copy').disabled = true;
  const reviseBtn = card.querySelector('.btn-revise');
  if (reviseBtn) reviseBtn.disabled = true;
}

// ─── 수정 재생성 ──────────────────────────────────────────
async function handleRevise(type, instructionOverride, doneMessage) {
  if (!currentJobId) { showToast('생성이 끝난 뒤에 수정할 수 있어요'); return; }
  const instruction = (instructionOverride || $(`revise-${type}`).value).trim();
  if (!instruction) { $(`revise-${type}`).focus(); return; }

  const reviseBtn = document.querySelector(`.btn-revise[data-type="${type}"]`);
  reviseBtn.disabled = true;
  reviseBtn.textContent = '재생성 중…';
  const previous = sectionContent[type];
  setCardLoading(type, '수정 반영 중…');

  // 카페 글이 바뀌면 📷 자리가 달라질 수 있어 서버가 캡쳐 가이드도 같이 갱신한다
  const previousCapture = type === 'cafe' ? sectionContent.capture : null;
  if (type === 'cafe' && previousCapture) setCardLoading('capture', '카페 수정 반영 확인 중…');
  // 캐러셀 후크 안이 바뀌면 짝꿍 캡션 첫 두 줄도 따라간다(체크박스로 끌 수 있음)
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
        showToast(`${doneMessage || '캐러셀 수정 완료'} · 인스타 캡션 첫 줄도 선택한 안에 맞췄어요`);
      } else {
        if (previousCaption) setCardContent('caption', previousCaption);
        if (data.captionError) showToast(`캐러셀 수정 완료 · 캡션 맞추기는 실패했어요: ${data.captionError}`);
        else if (data.hookChanged) showToast(`${doneMessage || '캐러셀 수정 완료'} (캡션은 없어서 맞추지 않았어요)`);
        else showToast(doneMessage || '수정 완료 (후크 안은 그대로라 캡션 유지)');
      }
    } else if (type === 'cafe') {
      if (data.capture) {
        setCardContent('capture', data.capture);
        showToast('카페 서머리 수정 완료 · 캡쳐 자리가 바뀌어 캡쳐 가이드도 새로 맞췄어요');
      } else {
        if (previousCapture) setCardContent('capture', previousCapture);
        showToast(data.captureError
          ? `카페 수정 완료 · 캡쳐 가이드 갱신은 실패했어요: ${data.captureError}`
          : (doneMessage || '수정 완료 (캡쳐 자리는 그대로라 캡쳐 가이드 유지)'));
      }
    } else {
      showToast(doneMessage || '수정 완료');
    }
  } catch (err) {
    if (previous) {
      setCardContent(type, previous);
      showToast(`⚠️ 수정 실패 — 이전 버전을 그대로 둬요: ${err.message}`);
    } else {
      setCardError(type, err.message);
    }
    if (previousCapture) setCardContent('capture', previousCapture);
    if (previousCaption) setCardContent('caption', previousCaption);
  } finally {
    reviseBtn.disabled = false;
    reviseBtn.textContent = '재생성';
    refreshVersions();
  }
}

// ─── 저장된 버전 오가기 ─────────────────────────────────────
function setVersions(contents) {
  TYPES.forEach((type) => {
    versions[type] = contents
      .filter((c) => c.type === type)
      .map((c) => ({ version: c.version, content: c.content, created_at: c.created_at }))
      .sort((a, b) => a.version - b.version);
  });
}

async function refreshVersions() {
  if (!currentJobId) return;
  try {
    const data = await apiFetch('GET', `/api/job/${currentJobId}`);
    setVersions(data.contents || []);
    TYPES.forEach((type) => {
      if (!sectionContent[type]) return;
      const match = [...versions[type]].reverse().find((v) => v.content === sectionContent[type]);
      viewing[type] = match ? match.version : latestVersionOf(type);
      renderVersionSelect(type);
    });
    const map = latestOf(data.contents || [], 'lecture_map');
    if (map && map !== lectureMapText) setLectureMap(map);
  } catch { /* 목록 갱신 실패는 조용히 */ }
}

function latestVersionOf(type) {
  const list = versions[type];
  return list.length ? list[list.length - 1].version : null;
}

function showLatestVersion(type) {
  const v = latestVersionOf(type);
  if (v != null) selectVersion(type, v);
}

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
    const paired = carouselVersionPairedWithCaption(row);
    if (paired) desc = ` · 캐러셀 ${paired}`;
  }
  return `v${row.version}${desc}${time}`;
}

function renderVersionSelect(type) {
  const sel = $(`version-${type}`);
  const confirmBtn = document.querySelector(`.btn-confirm-version[data-type="${type}"]`);
  const list = versions[type];
  if (list.length <= 1) {
    sel.setAttribute('hidden', '');
    confirmBtn.setAttribute('hidden', '');
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
  confirmBtn.toggleAttribute('hidden', !isOld);
  // 옛 버전을 보는 동안은 수정 입력을 막는다 — 서버의 수정은 항상 최신 버전 기준이기 때문.
  const revRow = $(`revision-${type}`);
  if (revRow && sectionContent[type]) {
    const inputRow = revRow.querySelector('.revise-row');
    if (inputRow) {
      revRow.removeAttribute('hidden');
      inputRow.toggleAttribute('hidden', isOld);
    } else {
      revRow.toggleAttribute('hidden', isOld);
    }
  }
}

function selectVersion(type, version) {
  const row = versions[type].find((v) => v.version === version);
  if (!row) return;
  viewing[type] = version;
  setCardContent(type, row.content);
  renderVersionSelect(type);
}

/** 지금 보는 버전을 최신으로 되살린다 (내용 복사 저장, 토큰 0). 캐러셀이면 함께 보던 옛 캡션도 같이 */
async function confirmVersion(type) {
  if (!currentJobId || viewing[type] == null) return;
  const targets = [{ type, version: viewing[type] }];
  if (type === 'carousel' && viewing.caption != null && viewing.caption !== latestVersionOf('caption')) {
    targets.push({ type: 'caption', version: viewing.caption });
  }
  const btn = document.querySelector(`.btn-confirm-version[data-type="${type}"]`);
  btn.disabled = true; btn.textContent = '확정 중…';
  try {
    for (const t of targets) await apiFetch('POST', '/api/content/restore', { jobId: currentJobId, type: t.type, version: t.version });
    await refreshVersions();
    targets.forEach((t) => showLatestVersion(t.type));
    showToast(`${targets.map((t) => `${CARD_NAMES[t.type]} v${t.version}`).join(', ')}을(를) 최신 버전으로 확정했어요 (토큰 사용 없음)`);
  } catch (err) {
    showToast(`⚠️ 버전 확정 실패: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = '이 버전으로 확정';
  }
}

function savedCarouselVersionForHook(key) {
  for (const row of [...versions.carousel].reverse()) {
    const parsed = parseHookCandidates(row.content);
    if (parsed && parsed.adopted === key) return row;
  }
  return null;
}

/** 캐러셀 버전 V가 최신이던 시기에 함께 쓰이던 캡션 버전 */
function pairedCaptionVersion(carouselVersion) {
  const list = versions.carousel;
  const idx = list.findIndex((v) => v.version === carouselVersion);
  if (idx < 0) return null;
  const next = list[idx + 1];
  const cutoff = next && next.created_at ? new Date(next.created_at).getTime() : Infinity;
  const candidates = versions.caption.filter((c) => (c.created_at ? new Date(c.created_at).getTime() : 0) < cutoff);
  return candidates.length ? candidates[candidates.length - 1] : null;
}

function carouselVersionPairedWithCaption(captionRow) {
  const t = captionRow.created_at ? new Date(captionRow.created_at).getTime() : 0;
  const before = versions.carousel.filter((v) => (v.created_at ? new Date(v.created_at).getTime() : 0) <= t);
  const car = before.length ? before[before.length - 1] : null;
  if (!car) return null;
  const parsed = parseHookCandidates(car.content);
  return parsed && parsed.adopted ? `${parsed.adopted}안` : `v${car.version}`;
}

// ─── 캐러셀 후크 안 선택 ──────────────────────────────────
// 기획안 [기획 개요]의 후크 후보 표기(프롬프트가 고정한 계약): "· A안 [갈래] 헤드카피 → 근거" / "· 채택: A안 → 이유".
// 갈래는 대괄호 안 짧은 낱말이면 무엇이든 받는다(서버 generate.js adoptedHook과 같은 규칙).
const HOOK_CAND_RE = /^\s*[·•\-*]?\s*\**([ABC])안\**\s*[\[［(（]\s*([^\]］)）\s]{1,12})\s*[\]］)）]\s*[:：]?\s*(.+)$/;
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
      const head = rest.split(/\s*(?:→|—|\||--)\s*/)[0].replace(/\*\*/g, '').replace(/^["“「『']+|["”」』']+$/g, '').trim();
      if (head && !byKey.has(key)) byKey.set(key, { key, kind, head });
      continue;
    }
    const a = raw.match(HOOK_ADOPT_RE);
    if (a && !adopted) adopted = a[1];
  }
  const cands = ['A', 'B', 'C'].filter((k) => byKey.has(k)).map((k) => byKey.get(k));
  if (cands.length < 2) return null;
  return { cands, adopted };
}

function renderHookPicker(content) {
  const picker = $('hooks-carousel');
  const chips = $('hook-chips-carousel');
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
        showToast(`${key}안(${kind})으로 기획해 둔 v${saved.version}을 불러왔어요` +
          (pairedCap ? ` · 그때의 캡션 v${pairedCap.version}도 함께` : '') +
          (isLatest ? '' : ' — 이 안으로 갈 거면 "이 버전으로 확정"을 누르세요 (토큰 사용 없음)'));
      });
    } else if (!isCurrent) {
      btn.addEventListener('click', () => {
        const instruction =
          `후크 후보 ${key}안(${kind}) "${head}"을 채택안으로 바꿔 CUT 1부터 다시 기획한다. ` +
          `후크 후보 A안·B안·C안의 문구는 그대로 두고 '채택' 줄만 ${key}안으로 옮긴다. ` +
          `1컷이 바뀌면서 어긋나는 열린 고리·감정 곡선·연결 컷만 함께 맞추고, 나머지 컷은 유지한다.`;
        showToast(`${key}안(${kind})으로 다시 기획 중…`);
        handleRevise('carousel', instruction, `${key}안(${kind})으로 다시 기획했어요`);
      });
    }
    chips.appendChild(btn);
  });
  picker.removeAttribute('hidden');
}

// ─── 전체 복사 (마크다운 한 벌 — 챗GPT 등에 붙여 넣기 좋게) ──
function handleCopyAll() {
  if (!TYPES.some((t) => sectionContent[t])) return;
  const title = currentCourse ? `${currentCourse.name} (강좌 ${currentCourse.lectures.length}강)` : (currentJob?.video_title || '강의');
  const parts = [`# ${title}`];
  if (currentCourse) parts.push(currentCourse.lectures.map((l) => `- ${l.n}강 ${l.title}${l.url ? ` — ${l.url}` : ''}`).join('\n'));
  else if (currentJob?.vimeo_url) parts.push(`- ${currentJob.vimeo_url}`);
  if (lectureMapText) parts.push(`## ${currentCourse ? '강좌 지도' : '강의 지도'}\n${lectureMapText}`);
  const order = [['cafe', '네이버 카페 서머리'], ['capture', '캡쳐 가이드'], ['carousel', '인스타 캐러셀 기획'], ['caption', '인스타 캡션']];
  order.forEach(([t, name]) => { if (sectionContent[t]) parts.push(`## ${name}\n${sectionContent[t]}`); });
  copyText(parts.join('\n\n'), '강의 지도와 4종을 마크다운으로 복사했어요');
}

// ─── 노션 저장 ───────────────────────────────────────
async function handleSaveToNotion() {
  if (!currentJobId) return;
  $saveNotionBtn.disabled = true;
  $saveNotionBtn.textContent = '저장 중…';
  try {
    const data = await apiFetch('POST', '/api/save-to-notion', { jobId: currentJobId });
    showToast('노션에 저장했어요');
    if (data.url) setTimeout(() => window.open(data.url, '_blank'), 400);
  } catch (err) {
    showToast(`⚠️ ${err.message}`);
  } finally {
    $saveNotionBtn.disabled = false;
    $saveNotionBtn.textContent = '노션에 저장';
  }
}

// ─── 전체 기획 다시하기 (컨셉 기준 4종 재생성) ──────────────
async function handleRegenAll() {
  if (!currentJobId) { showToast('생성이 끝난 뒤에 다시 기획할 수 있어요'); return; }
  const concept = $conceptRedo.value.trim();
  if (!concept) { $conceptRedo.focus(); return; }
  if (!confirm('카페·캡션·캐러셀·캡쳐 4종을 이 컨셉으로 처음부터 다시 기획해요.\n이전 버전은 이력에 남아요. 진행할까요?')) return;

  $regenAllBtn.disabled = true;
  $regenAllBtn.textContent = '4종 다시 기획 중…';
  TYPES.forEach((t) => { sectionContent[t] = null; setCardLoading(t, '컨셉에 맞춰 다시 기획 중…'); });
  updateJobButtons();
  buildProgress(currentCourse ? currentCourse.lectures.length : 1);
  // 자막·지도는 저장돼 있어 바로 4종으로 간다
  [...$progress.children].forEach((li) => { if (!TYPES.includes(li.dataset.key)) li.classList.add('is-done'); });
  markProgress('cafe');
  showTab('cafe-pack');

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
    showToast('컨셉에 맞춰 4종을 다시 기획했어요');
  } catch (err) {
    TYPES.forEach((t) => { if (!sectionContent[t]) setCardError(t, err.message); });
  } finally {
    $regenAllBtn.textContent = '이 컨셉으로 4종 다시 기획';
    updateRedoButton();
  }
}

// ─── 캐러셀·캡쳐 재생성 ──────────────────────────────────
async function handleRegenSecondary() {
  if (!currentJobId) return;
  $regenBtn.disabled = true;
  $regenBtn.textContent = '재생성 중…';
  setCardLoading('carousel');
  setCardLoading('capture');
  showTab('insta-pack');
  try {
    const data = await apiFetch('POST', '/api/regenerate', { jobId: currentJobId });
    setCardContent('carousel', data.carousel);
    setCardContent('capture', data.capture);
    showToast('캐러셀·캡쳐 가이드를 다시 만들었어요');
    refreshVersions();
  } catch (err) {
    setCardError('carousel', err.message);
    setCardError('capture', err.message);
  } finally {
    $regenBtn.textContent = '캐러셀·캡쳐 가이드 재생성';
    updateJobButtons();
  }
}

// ─── 보이스 프로파일 ────────────────────────────────────
async function handleLearnVoice() {
  if (!confirm('인스타그램 캡션을 수집해 보이스 프로파일을 갱신해요. 진행할까요?')) return;
  const btn = $('learn-voice-btn');
  btn.disabled = true; btn.textContent = '학습 중…';
  try {
    const data = await apiFetch('POST', '/api/learn-voice');
    showToast(data.message || '보이스 프로파일을 갱신했어요');
    await checkStatus();
  } catch (err) {
    showToast(`⚠️ ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = '보이스 프로파일 갱신';
  }
}

async function handleLearnVoiceManual() {
  const raw = $manualInput.value.trim();
  if (!raw) { $manualInput.focus(); return; }
  const captions = raw.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  if (captions.length < 3) { showToast('캡션을 3개 이상 넣어 주세요 (빈 줄로 구분)'); return; }
  const btn = $('manual-caption-submit');
  btn.disabled = true; btn.textContent = '학습 중…';
  try {
    const data = await apiFetch('POST', '/api/learn-voice-text', { captions });
    $manualModal.setAttribute('hidden', '');
    showToast(data.message || '보이스 프로파일을 갱신했어요');
    await checkStatus();
  } catch (err) {
    showToast(`⚠️ ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = '학습 시작';
  }
}

async function handleExchangeToken() {
  const shortToken = prompt('Graph API Explorer에서 발급한 단기 토큰을 붙여넣으세요.\n(developers.facebook.com/tools/explorer → "토큰 생성" → 복사)');
  if (!shortToken || !shortToken.trim()) return;
  const btn = $('exchange-token-btn');
  btn.disabled = true; btn.textContent = '교환 중…';
  try {
    const data = await apiFetch('POST', '/api/exchange-token', { shortToken: shortToken.trim() });
    showToast(data.message || '장기 토큰으로 교환했어요');
  } catch (err) {
    showToast(`⚠️ ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = 'Instagram 토큰 교환';
  }
}

// ─── 유틸 ─────────────────────────────────────────────────
function setGenerating(on) {
  $genBtn.disabled = on;
  $genBtn.textContent = on ? '기획 중…' : '기획 시작';
  $('new-btn').disabled = on;
}

function copyText(text, doneMessage) {
  navigator.clipboard.writeText(text)
    .then(() => showToast(doneMessage))
    .catch(() => showToast('복사하지 못했어요 — 브라우저 권한을 확인하세요'));
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
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showToast(message) {
  const prev = document.querySelector('.toast');
  if (prev) prev.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  const duration = message.length > 40 ? Math.min(9000, 3500 + message.length * 30) : 2200;
  setTimeout(() => el.remove(), duration);
}
