// src/db.js — 저장소 계층: Supabase 연결 시 DB, 미연결 시 파일 시스템 자동 폴백
//
// 파일 폴백 구조:
//   jobs          → outputs/{videoId}/job.json
//   contents      → outputs/{videoId}/contents.json (버전 이력) + {type}.md (최신본)
//   voice_profile → data/voice_profile.json (voice.js가 백업/저장 담당, DB upsert만 여기서)

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUTS_DIR = path.join(ROOT, 'outputs');
const DATA_DIR = path.join(ROOT, 'data');
const VOICE_FILE = path.join(DATA_DIR, 'voice_profile.json');

let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function isSupabase() {
  return Boolean(supabase);
}

// ───────────────────────── 파일 폴백 헬퍼 ─────────────────────────

async function readJsonSafe(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** jobId로 outputs/ 하위 작업 디렉터리 탐색 */
async function findJobDir(jobId) {
  let entries;
  try {
    entries = await fs.readdir(OUTPUTS_DIR, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const jobPath = path.join(OUTPUTS_DIR, entry.name, 'job.json');
    const job = await readJsonSafe(jobPath);
    if (job && job.id === jobId) return path.join(OUTPUTS_DIR, entry.name);
  }
  return null;
}

// ───────────────────────── jobs ─────────────────────────

/**
 * 작업 저장.
 * @param {object} jobData - { video_id, video_title, vimeo_url, topic, transcript_compressed, transcript_full }
 * @returns {Promise<object>} 저장된 job (id 포함)
 */
export async function saveJob(jobData) {
  const step = 'DB 저장(job)';
  if (supabase) {
    const { data, error } = await supabase.from('jobs').insert(jobData).select().single();
    if (error) throw new Error(`${step}: Supabase 오류 — ${error.message}`);
    return data;
  }
  // 파일 폴백
  const job = { id: crypto.randomUUID(), ...jobData, created_at: new Date().toISOString() };
  const dir = path.join(OUTPUTS_DIR, job.id);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'job.json'), JSON.stringify(job, null, 2), 'utf8');
  } catch (err) {
    throw new Error(`${step}: 파일 저장 오류 — ${err.message}`);
  }
  return job;
}

/** jobId로 작업 조회 (없으면 null) */
export async function getJob(jobId) {
  const step = 'DB 조회(job)';
  if (supabase) {
    const { data, error } = await supabase.from('jobs').select('*').eq('id', jobId).maybeSingle();
    if (error) throw new Error(`${step}: Supabase 오류 — ${error.message}`);
    return data;
  }
  const dir = await findJobDir(jobId);
  if (!dir) return null;
  return readJsonSafe(path.join(dir, 'job.json'));
}

// ───────────────────────── contents ─────────────────────────

/**
 * 생성 콘텐츠 저장 (버전 자동 증가).
 * @returns {Promise<object>} 저장된 content 행
 */
export async function saveContent(jobId, type, content) {
  const step = 'DB 저장(content)';
  if (supabase) {
    const { data: existing, error: selErr } = await supabase
      .from('contents')
      .select('version')
      .eq('job_id', jobId)
      .eq('type', type)
      .order('version', { ascending: false })
      .limit(1);
    if (selErr) throw new Error(`${step}: Supabase 조회 오류 — ${selErr.message}`);
    const version = existing && existing.length > 0 ? existing[0].version + 1 : 1;
    const { data, error } = await supabase
      .from('contents')
      .insert({ job_id: jobId, type, content, version })
      .select()
      .single();
    if (error) throw new Error(`${step}: Supabase 오류 — ${error.message}`);
    return data;
  }
  // 파일 폴백
  const dir = await findJobDir(jobId);
  if (!dir) throw new Error(`${step}: 작업(${jobId})을 찾을 수 없습니다.`);
  try {
    const contentsPath = path.join(dir, 'contents.json');
    const list = (await readJsonSafe(contentsPath)) || [];
    const prev = list.filter((c) => c.type === type);
    const version = prev.length > 0 ? Math.max(...prev.map((c) => c.version)) + 1 : 1;
    const row = {
      id: crypto.randomUUID(),
      job_id: jobId,
      type,
      content,
      version,
      created_at: new Date().toISOString(),
    };
    list.push(row);
    await fs.writeFile(contentsPath, JSON.stringify(list, null, 2), 'utf8');
    await fs.writeFile(path.join(dir, `${type}.md`), content, 'utf8'); // 최신본은 사람이 읽기 좋게 md로도 저장
    return row;
  } catch (err) {
    throw new Error(`${step}: 파일 저장 오류 — ${err.message}`);
  }
}

/** 작업의 전체 콘텐츠 이력 조회 */
export async function getContents(jobId) {
  const step = 'DB 조회(contents)';
  if (supabase) {
    const { data, error } = await supabase
      .from('contents')
      .select('*')
      .eq('job_id', jobId)
      .order('created_at', { ascending: true });
    if (error) throw new Error(`${step}: Supabase 오류 — ${error.message}`);
    return data || [];
  }
  const dir = await findJobDir(jobId);
  if (!dir) return [];
  return (await readJsonSafe(path.join(dir, 'contents.json'))) || [];
}

/** 특정 타입의 최신 버전 콘텐츠 조회 (없으면 null) */
export async function getLatestContent(jobId, type) {
  const all = await getContents(jobId);
  const filtered = all.filter((c) => c.type === type);
  if (filtered.length === 0) return null;
  return filtered.reduce((a, b) => (a.version >= b.version ? a : b));
}

// ───────────────────────── voice_profile ─────────────────────────

/** 보이스 프로파일 저장 (Supabase 단일 행 upsert — 파일 저장/백업은 voice.js 담당) */
export async function saveVoiceProfile(profile) {
  const step = 'DB 저장(voice_profile)';
  if (!supabase) return; // 파일 모드에서는 voice.js의 파일 저장으로 충분
  const { error } = await supabase
    .from('voice_profile')
    .upsert({ id: 1, profile, updated_at: new Date().toISOString() });
  if (error) throw new Error(`${step}: Supabase 오류 — ${error.message}`);
}

// Render Secret File 경로 — 배포판의 디스크는 휘발성이라, 대시보드에 등록한
// 비밀 파일(/etc/secrets/voice_profile.json)을 영구 폴백으로 사용한다.
const SECRET_VOICE_FILE = '/etc/secrets/voice_profile.json';

/** 보이스 프로파일 로드: Supabase → 로컬 파일 → Render Secret File → null */
export async function getVoiceProfile() {
  if (supabase) {
    const { data, error } = await supabase
      .from('voice_profile')
      .select('profile')
      .eq('id', 1)
      .maybeSingle();
    if (error) throw new Error(`DB 조회(voice_profile): Supabase 오류 — ${error.message}`);
    if (data?.profile) return data.profile;
  }
  return (await readJsonSafe(VOICE_FILE)) || (await readJsonSafe(SECRET_VOICE_FILE));
}

export { DATA_DIR, VOICE_FILE, OUTPUTS_DIR };
