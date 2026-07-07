// src/voice.js — 보이스 프로파일 생성(learn)/로드(load)/백업
//
// 절대 규칙 1: 말투는 반드시 data/voice_profile.json(또는 Supabase voice_profile) 기준.
// 프로파일이 없으면 load()가 learn-voice 실행을 안내하며 실패한다.

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchCaptions } from './instagram.js';
import { callClaude, MODELS } from './anthropic.js';
import { buildVoicePrompt } from './prompts.js';
import { saveVoiceProfile, getVoiceProfile, DATA_DIR, VOICE_FILE } from './db.js';

/** Claude 응답에서 JSON 추출 (```json 펜스 등 방어) */
function parseProfileJson(raw) {
  const stripped = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const first = stripped.indexOf('{');
    const last = stripped.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(stripped.slice(first, last + 1));
      } catch {
        /* 아래에서 공통 에러 */
      }
    }
  }
  throw new Error('보이스 프로파일 생성: 모델 응답을 JSON으로 파싱하지 못했습니다. 다시 시도하세요.');
}

/** 기존 프로파일을 data/voice_profile_YYYYMMDD.json으로 백업 */
async function backupExistingProfile() {
  try {
    await fs.access(VOICE_FILE);
  } catch {
    return null; // 기존 파일 없음 — 백업 불필요
  }
  const now = new Date();
  const stamp =
    String(now.getFullYear()) +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0');
  const backupPath = path.join(DATA_DIR, `voice_profile_${stamp}.json`);
  await fs.copyFile(VOICE_FILE, backupPath);
  console.log(`기존 보이스 프로파일 백업: ${path.basename(backupPath)}`);
  return backupPath;
}

/**
 * 보이스 프로파일 학습: 인스타 캡션 수집 → 말투 분석 → 백업 후 저장.
 * captions 배열을 직접 넘기면 API 수집을 건너뜀 (수동 입력용).
 * @returns {Promise<{profile: object, captionCount: number}>}
 */
export async function learn({ captions: inputCaptions } = {}) {
  let captions;
  if (inputCaptions && inputCaptions.length > 0) {
    captions = inputCaptions.map(c => String(c).trim()).filter(Boolean);
    console.log(`수동 입력 캡션 ${captions.length}개로 학습 시작...`);
  } else {
    console.log('인스타 캡션 수집 시작...');
    captions = await fetchCaptions({ limit: 50 });
  }

  console.log('말투 분석 중 (Claude 호출)...');
  const raw = await callClaude({
    model: MODELS.VOICE,
    prompt: buildVoicePrompt(captions),
    maxTokens: 8000,
    step: '말투 분석',
  });

  const profile = parseProfileJson(raw);

  // 저장 전 백업 → 파일 저장 → Supabase upsert (연결 시)
  await fs.mkdir(DATA_DIR, { recursive: true });
  await backupExistingProfile();
  await fs.writeFile(VOICE_FILE, JSON.stringify(profile, null, 2), 'utf8');
  await saveVoiceProfile(profile);

  console.log(`보이스 프로파일 저장 완료: ${VOICE_FILE}`);
  return { profile, captionCount: captions.length };
}

/**
 * 보이스 프로파일 로드 (Supabase 우선 → 로컬 파일).
 * 없으면 learn-voice 실행을 안내하며 에러를 던진다 (절대 규칙 1).
 */
export async function load() {
  const profile = await getVoiceProfile();
  if (!profile) {
    throw new Error(
      '보이스 프로파일이 없습니다. 먼저 `npm run learn-voice`를 실행하거나 웹 UI의 [보이스 프로파일 갱신] 버튼을 눌러 자야쌤 말투를 학습시키세요.'
    );
  }
  return profile;
}

// CLI 직접 실행 지원: npm run learn-voice
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  learn()
    .then(({ captionCount }) => {
      console.log(`완료 — 캡션 ${captionCount}개로 보이스 프로파일을 갱신했습니다.`);
      console.log('프로파일이 자야쌤 문체를 잘 담았는지 data/voice_profile.json을 직접 확인하세요.');
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
