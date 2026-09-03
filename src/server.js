// src/server.js — Express 서버: 정적 파일 서빙 + API 5개 (SSE 스트리밍 포함)
//
// POST /api/generate    — { url, topic? } → SSE (progress × N → done)
// POST /api/regenerate-all (SSE) — { jobId, concept } → 컨셉 기준으로 4종 전체 재기획
// POST /api/revise      — { jobId, type, instruction } → { content, version, capture? }  (cafe 수정으로 📷 자리가 바뀌면 capture도 갱신해 돌려줌)
// POST /api/regenerate  — { jobId } → { carousel, capture }
// POST /api/learn-voice — {} → { message }
// GET  /api/jobs        — → { jobs } (지난 작업 목록, 최신순)
// GET  /api/job/:id     — → { job, contents }
// GET  /api/status      — 환경변수/저장소 상태 (프론트 안내용)

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAll, regenerateAll, revise, regenerateSecondary } from './generate.js';
import { learn as learnVoice } from './voice.js';
import { exchangeToLongLived, autoRefreshIfNeeded } from './instagram.js';
import { saveLectureToNotion } from './notion.js';
import { getJob, getContents, getLatestContent, getVoiceProfile, isSupabase, listJobs, saveContent } from './db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));

// ───────────────────────── 상태 확인 (프론트 안내용) ─────────────────────────

const REQUIRED_ENV = ['ANTHROPIC_API_KEY', 'VIMEO_ACCESS_TOKEN'];
const VOICE_ENV = ['INSTAGRAM_ACCESS_TOKEN', 'IG_USER_ID'];

app.get('/api/status', async (req, res) => {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  const missingVoiceEnv = VOICE_ENV.filter((k) => !process.env[k]);
  let hasVoiceProfile = false;
  try {
    hasVoiceProfile = Boolean(await getVoiceProfile());
  } catch {
    /* 상태 조회 실패는 무시 */
  }
  res.json({
    missing,
    missingVoiceEnv,
    hasVoiceProfile,
    storage: isSupabase() ? 'supabase' : 'file',
    commit: process.env.RENDER_GIT_COMMIT || null, // 배포된 코드 버전 확인용
  });
});

// ───────────────────────── POST /api/generate (SSE) ─────────────────────────

/** SSE 스트림 시작 — 헤더·소켓 설정 후 send/isGone 헬퍼를 돌려준다 (생성·전체 재기획 공용) */
function openSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Nagle 비활성화 + 즉시 첫 청크 전송으로 SSE 스트림 활성화
  if (req.socket) req.socket.setNoDelay(true);

  let clientGone = false;
  // req.on('close')는 요청 본문 수신 완료 시 즉시 발화 → res.on('close') 사용
  res.on('close', () => { clientGone = true; });

  const send = (event, data) => {
    if (clientGone) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  // 연결 확인 — 첫 청크를 즉시 전송해 스트림 활성화
  res.write(': sse-connected\n\n');

  return { send, isGone: () => clientGone };
}

/** generateAll/regenerateAll의 onProgress → SSE 이벤트 매핑 */
const progressToSSE = (send) => (payload) => {
  if (payload.type === 'job_created') send('start', { jobId: payload.jobId });
  else send('progress', payload);
};

app.post('/api/generate', async (req, res) => {
  const { url, topic, concept } = req.body || {};
  if (!url || typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: '생성 요청: 비메오 URL을 입력하세요.' });
  }

  const { send, isGone } = openSSE(req, res);
  try {
    const { jobId } = await generateAll({
      url: url.trim(),
      topic: (topic || '').trim() || undefined,
      concept: (concept || '').trim() || undefined,
      onProgress: progressToSSE(send),
    });
    send('done', { jobId });
  } catch (err) {
    // 자막 수집 실패, 보이스 프로파일 없음 등 — 생성 시작 전 치명 오류
    console.error(`생성 실패: ${err.message}`);
    send('error', { error: err.message });
  } finally {
    if (!isGone()) res.end();
  }
});

// ───────────────────────── POST /api/regenerate-all (SSE) ─────────────────────────
// 컨셉이 통째로 어긋났을 때 — { jobId, concept } → 저장된 자막으로 4종을 컨셉에 맞춰 다시 생성

app.post('/api/regenerate-all', async (req, res) => {
  const { jobId, concept } = req.body || {};
  if (!jobId) return res.status(400).json({ error: '전체 기획 다시하기: jobId가 필요합니다.' });
  if (!concept || !String(concept).trim()) {
    return res.status(400).json({ error: '전체 기획 다시하기: 4종을 관통할 기획 컨셉을 적어 주세요.' });
  }

  const { send, isGone } = openSSE(req, res);
  try {
    send('start', { jobId });
    await regenerateAll({ jobId, concept: String(concept).trim(), onProgress: progressToSSE(send) });
    send('done', { jobId });
  } catch (err) {
    console.error(`전체 기획 다시하기 실패: ${err.message}`);
    send('error', { error: err.message });
  } finally {
    if (!isGone()) res.end();
  }
});

// ───────────────────────── POST /api/revise ─────────────────────────

app.post('/api/revise', async (req, res) => {
  const { jobId, type, instruction, alignCaption } = req.body || {};
  if (!jobId || !type || !instruction) {
    return res.status(400).json({ error: '수정 요청: jobId, type, instruction이 모두 필요합니다.' });
  }
  try {
    const { content, version, capture, captureError, caption, captionError, hookChanged } = await revise({
      jobId,
      type,
      instruction,
      alignCaption: alignCaption !== false, // 기본 켬 — 캐러셀 후크 안이 바뀌면 캡션 첫 두 줄도 따라 맞춤
    });
    res.json({
      content,
      version,
      capture: capture || null,
      captureError: captureError || null,
      caption: caption || null,
      captionError: captionError || null,
      hookChanged: !!hookChanged,
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────── POST /api/regenerate ─────────────────────────

app.post('/api/regenerate', async (req, res) => {
  const { jobId } = req.body || {};
  if (!jobId) {
    return res.status(400).json({ error: '재생성 요청: jobId가 필요합니다.' });
  }
  try {
    const { carousel, capture } = await regenerateSecondary({ jobId });
    res.json({ carousel, capture });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────── POST /api/exchange-token ─────────────────────────

app.post('/api/exchange-token', async (req, res) => {
  const { shortToken } = req.body || {};
  if (!shortToken || typeof shortToken !== 'string' || !shortToken.trim()) {
    return res.status(400).json({ error: '단기 토큰(shortToken)을 본문에 포함해주세요.' });
  }
  try {
    await exchangeToLongLived(shortToken.trim());
    res.json({ message: '장기 토큰 교환 완료 — .env에 저장됐습니다. 이후 만료 30일 전마다 서버가 자동 갱신합니다.' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────── POST /api/save-to-notion ─────────────────────────

app.post('/api/save-to-notion', async (req, res) => {
  const { jobId } = req.body || {};
  if (!jobId) return res.status(400).json({ error: 'jobId가 필요합니다.' });

  try {
    const job = await getJob(jobId);
    if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });

    // 각 타입의 최신 버전 콘텐츠 가져오기
    const [cafe, caption, carousel, capture] = await Promise.all(
      ['cafe', 'caption', 'carousel', 'capture'].map((t) => getLatestContent(jobId, t))
    );

    const missing = ['cafe', 'caption', 'carousel', 'capture']
      .filter((t, i) => ![cafe, caption, carousel, capture][i]);
    if (missing.length > 0) {
      return res.status(400).json({ error: `아직 생성되지 않은 섹션이 있습니다: ${missing.join(', ')}` });
    }

    const title = job.video_title || job.topic || `강의 ${job.vimeo_url?.split('/').pop() || jobId}`;
    const { url } = await saveLectureToNotion({
      title,
      vimeoUrl: job.vimeo_url,
      cafe: cafe.content,
      caption: caption.content,
      carousel: carousel.content,
      capture: capture.content,
    });

    res.json({ message: '노션에 저장됐습니다!', url });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────── GET /api/debug-instagram ─────────────────────────

app.get('/api/debug-instagram', async (req, res) => {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  const igUserId = process.env.IG_USER_ID;
  const v = 'v21.0';
  const results = {};

  if (!token) return res.json({ error: 'INSTAGRAM_ACCESS_TOKEN 없음' });

  // 1) /me
  try {
    const r = await fetch(`https://graph.facebook.com/${v}/me?fields=id,name&access_token=${encodeURIComponent(token)}`);
    results.me = await r.json();
  } catch (e) { results.me = { error: e.message }; }

  // 2) /me/accounts
  try {
    const r = await fetch(`https://graph.facebook.com/${v}/me/accounts?fields=id,name,instagram_business_account{id,username}&access_token=${encodeURIComponent(token)}`);
    results.pages = await r.json();
  } catch (e) { results.pages = { error: e.message }; }

  // 3) IG_USER_ID 직접 조회
  if (igUserId) {
    try {
      const r = await fetch(`https://graph.facebook.com/${v}/${igUserId}?fields=id,username,name,biography&access_token=${encodeURIComponent(token)}`);
      results.igAccount = await r.json();
    } catch (e) { results.igAccount = { error: e.message }; }
  }

  res.json(results);
});

// ───────────────────────── POST /api/learn-voice ─────────────────────────

// Render 환경에서 Supabase 미연결이면 재시작 시 새 프로파일이 사라진다는 경고 문구
function profilePersistWarning() {
  return process.env.RENDER && !isSupabase()
    ? ' ⚠️ 단, 서버가 재시작되면 이 프로파일은 예전 것으로 돌아갑니다 — Render의 Secret File(voice_profile.json)을 새 프로파일로 갱신하거나 Supabase를 연결하세요.'
    : '';
}

app.post('/api/learn-voice', async (req, res) => {
  try {
    const { captionCount } = await learnVoice();
    res.json({ message: `보이스 프로파일 갱신 완료 — 인스타 캡션 ${captionCount}개를 학습했습니다.${profilePersistWarning()}` });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────── POST /api/learn-voice-text ─────────────────────────

app.post('/api/learn-voice-text', async (req, res) => {
  const { captions } = req.body || {};
  if (!Array.isArray(captions) || captions.length === 0) {
    return res.status(400).json({ error: '캡션 배열(captions)이 필요합니다.' });
  }
  try {
    const { captionCount } = await learnVoice({ captions });
    res.json({ message: `보이스 프로파일 갱신 완료 — 캡션 ${captionCount}개를 학습했습니다.${profilePersistWarning()}` });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────── GET /api/jobs — 지난 작업 히스토리 ─────────────────────────

app.get('/api/jobs', async (req, res) => {
  try {
    const jobs = await listJobs();
    res.json({ jobs });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────── POST /api/content/restore ─────────────────────────
// 저장된 이전 버전을 최신으로 되살린다 — 내용을 그대로 복사해 새 버전으로 저장 (모델 호출 없음, 토큰 0).
// 화면에서 A안·B안 등 이미 기획한 버전을 비교한 뒤 "이 버전으로 확정"할 때 쓴다.
// 이후 수정·재생성·노션 저장은 모두 최신 버전을 기준으로 하므로, 되살려 두어야 그 버전이 기준이 된다.

app.post('/api/content/restore', async (req, res) => {
  const { jobId, type, version } = req.body || {};
  if (!jobId || !type || !Number.isInteger(version)) {
    return res.status(400).json({ error: '버전 확정: jobId, type, version(정수)이 모두 필요합니다.' });
  }
  try {
    const all = await getContents(jobId);
    const rows = all.filter((c) => c.type === type);
    const target = rows.find((c) => c.version === version);
    if (!target) return res.status(404).json({ error: `버전 확정: ${type} v${version}을 찾을 수 없습니다.` });
    const latest = rows.reduce((a, b) => (a.version >= b.version ? a : b));
    if (latest.version === version) {
      return res.json({ content: latest.content, version: latest.version, restored: false }); // 이미 최신
    }
    const row = await saveContent(jobId, type, target.content);
    console.log(`${type} v${version} → v${row.version}으로 되살림 (모델 호출 없음)`);
    res.json({ content: row.content, version: row.version, restored: true, from: version });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────── GET /api/job/:id ─────────────────────────

app.get('/api/job/:id', async (req, res) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: `작업 조회: 작업(${req.params.id})을 찾을 수 없습니다.` });
    }
    const contents = await getContents(req.params.id);
    // 자막 원문은 응답이 너무 커지므로 제외
    const { transcript_compressed, transcript_full, ...jobLite } = job;
    res.json({ job: jobLite, contents });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────── 서버 시작 ─────────────────────────

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`자야쌤 콘텐츠 공장 서버 시작 → http://localhost:${PORT}`);
  console.log(`저장소: ${isSupabase() ? 'Supabase' : '로컬 파일 (outputs/, data/)'}`);
  const missing = [...REQUIRED_ENV, ...VOICE_ENV].filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.warn(`환경변수를 설정하세요: ${missing.join(', ')} (.env 파일 — .env.example 참고)`);
  }
  // Instagram 토큰 만료 30일 전이면 자동 연장
  autoRefreshIfNeeded().catch(() => {});
});
