// src/instagram.js — Instagram Graph API 캡션 수집 + 토큰 자동갱신
//
// 토큰 흐름:
//   단기 토큰(1h) → /api/exchange-token 호출 → 장기 토큰(60일) → .env 저장
//   서버 시작 시 만료 30일 전이면 자동 연장 (추가 사용자 개입 없음)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GRAPH_API_VERSION = 'v21.0';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env');

// ─── 토큰 갱신 ────────────────────────────────────────────────────────────────

/**
 * 단기 Facebook User Access Token → 장기 토큰(60일) 교환.
 * Graph API Explorer 발급 토큰(EAAn1g...)용: grant_type=fb_exchange_token
 */
export async function exchangeToLongLived(shortToken) {
  const appId = process.env.INSTAGRAM_APP_ID;
  const appSecret = process.env.INSTAGRAM_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('토큰 교환: INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET이 .env에 없습니다.');
  }

  const url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token` +
    `?grant_type=fb_exchange_token` +
    `&client_id=${encodeURIComponent(appId)}` +
    `&client_secret=${encodeURIComponent(appSecret)}` +
    `&fb_exchange_token=${encodeURIComponent(shortToken)}`;

  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`토큰 교환 실패: ${data.error?.message || res.status}`);
  }

  // data.access_token, data.expires_in (초)
  await saveTokenToEnv(data.access_token);
  console.log(`장기 토큰 교환 완료 (유효기간 ${Math.round(data.expires_in / 86400)}일)`);
  return data.access_token;
}

/**
 * 장기 Facebook User Access Token 연장 (60일 초기화).
 * 장기 토큰 자체를 fb_exchange_token으로 재교환하면 만료일이 리셋됨.
 */
export async function refreshLongLivedToken(token) {
  const appId = process.env.INSTAGRAM_APP_ID;
  const appSecret = process.env.INSTAGRAM_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('토큰 연장: INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET이 .env에 없습니다.');
  }

  const url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token` +
    `?grant_type=fb_exchange_token` +
    `&client_id=${encodeURIComponent(appId)}` +
    `&client_secret=${encodeURIComponent(appSecret)}` +
    `&fb_exchange_token=${encodeURIComponent(token)}`;

  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`토큰 연장 실패: ${data.error?.message || res.status}`);
  }

  await saveTokenToEnv(data.access_token);
  console.log(`토큰 연장 완료 (유효기간 ${Math.round(data.expires_in / 86400)}일)`);
  return data.access_token;
}

/**
 * 토큰 만료일 확인. expires_at(Unix초) 반환. 만료 정보 없으면 null.
 */
async function getTokenExpiry(token) {
  const appId = process.env.INSTAGRAM_APP_ID;
  const appSecret = process.env.INSTAGRAM_APP_SECRET;
  if (!appId || !appSecret) return null;

  const url =
    `https://graph.facebook.com/debug_token` +
    `?input_token=${encodeURIComponent(token)}` +
    `&access_token=${encodeURIComponent(appId + '|' + appSecret)}`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    return data?.data?.expires_at ?? null; // Unix timestamp (초)
  } catch {
    return null;
  }
}

/**
 * .env 파일의 INSTAGRAM_ACCESS_TOKEN 값을 새 토큰으로 교체.
 */
async function saveTokenToEnv(newToken) {
  // 런타임 환경변수는 .env 유무와 관계없이 즉시 갱신 (배포 환경엔 .env가 없음)
  process.env.INSTAGRAM_ACCESS_TOKEN = newToken;
  let content;
  try {
    content = await fs.readFile(ENV_FILE, 'utf8');
  } catch {
    return; // .env 없으면 파일 저장만 건너뜀
  }
  let updated = content.replace(
    /^INSTAGRAM_ACCESS_TOKEN=.*/m,
    `INSTAGRAM_ACCESS_TOKEN=${newToken}`
  );
  if (updated === content) updated += `\nINSTAGRAM_ACCESS_TOKEN=${newToken}`;
  await fs.writeFile(ENV_FILE, updated, 'utf8');
}

/**
 * 서버 시작 시 호출: 토큰이 30일 내로 만료되면 자동 연장.
 */
export async function autoRefreshIfNeeded() {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!token) return;

  const expiresAt = await getTokenExpiry(token);
  if (!expiresAt) {
    console.log('Instagram 토큰 만료일 확인 불가 — 갱신 건너뜀');
    return;
  }

  const daysLeft = (expiresAt - Date.now() / 1000) / 86400;
  if (daysLeft < 0) {
    console.warn(`⚠️  Instagram 토큰 이미 만료 (${Math.abs(Math.round(daysLeft))}일 전). /api/exchange-token으로 재발급하세요.`);
    return;
  }
  if (daysLeft <= 30) {
    console.log(`Instagram 토큰 ${Math.round(daysLeft)}일 남음 → 자동 연장 시작...`);
    try {
      await refreshLongLivedToken(token);
    } catch (err) {
      console.warn(`토큰 자동 연장 실패: ${err.message}`);
    }
  } else {
    console.log(`Instagram 토큰 유효 (${Math.round(daysLeft)}일 남음)`);
  }
}

// ─── 캡션 수집 ────────────────────────────────────────────────────────────────

const TOKEN_EXPIRED_MESSAGE =
  'Instagram 액세스 토큰이 만료됐습니다. /api/exchange-token에 Graph API Explorer의 단기 토큰을 보내 장기 토큰으로 교환하세요.';

/**
 * 토큰의 권한 목록(debug_token granular_scopes)에서 instagram_basic이 부여된
 * Instagram 계정 ID를 추출. 페이지 권한(pages_show_list) 없이도 동작한다.
 */
async function findIgIdFromTokenScopes(token) {
  const appId = process.env.INSTAGRAM_APP_ID;
  const appSecret = process.env.INSTAGRAM_APP_SECRET;
  if (!appId || !appSecret) return null;

  const url =
    `https://graph.facebook.com/debug_token` +
    `?input_token=${encodeURIComponent(token)}` +
    `&access_token=${encodeURIComponent(appId + '|' + appSecret)}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    const granular = data?.data?.granular_scopes || [];
    const ig = granular.find((s) => s.scope === 'instagram_basic' && s.target_ids?.length > 0);
    return ig?.target_ids[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * 연결된 Instagram Business Account ID를 찾아 반환.
 * 시도 1: /me/accounts (pages_show_list 권한 필요)
 * 시도 2: 토큰 권한 정보에서 instagram_basic 대상 계정 추출 (페이지 권한 불필요)
 * 찾으면 .env의 IG_USER_ID도 업데이트.
 */
async function discoverIgUserId(token) {
  // 시도 1: /me/accounts (pages_show_list 권한 필요)
  const url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/me/accounts` +
    `?fields=id,name,instagram_business_account{id,username}` +
    `&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  const data = await res.json();

  if (!data.error) {
    const pages = data.data || [];
    console.log(`Facebook 페이지 ${pages.length}개 발견`);
    for (const page of pages) {
      const igId = page.instagram_business_account?.id;
      if (igId) {
        console.log(`Instagram 계정 발견: @${page.instagram_business_account.username} (ID: ${igId}) ← 페이지 "${page.name}"`);
        await saveIgUserIdToEnv(igId);
        return igId;
      }
    }
  } else {
    console.warn(`페이지 목록 조회 실패(${data.error.message}) → 토큰 권한 정보로 재시도...`);
  }

  // 시도 2: 페이지가 없거나 조회 실패 → 토큰 권한 정보에서 IG 계정 추출
  const igId = await findIgIdFromTokenScopes(token);
  if (igId) {
    console.log(`Instagram 계정 발견: ID ${igId} ← 토큰 권한 정보(instagram_basic)`);
    await saveIgUserIdToEnv(igId);
    return igId;
  }

  throw new Error(
    'Instagram 계정을 찾지 못했습니다. Graph API Explorer에서 instagram_basic 권한을 포함해 ' +
    '토큰을 다시 발급한 뒤 [Instagram 토큰 교환]을 실행하거나, [캡션 직접 입력]으로 학습하세요.'
  );
}

async function saveIgUserIdToEnv(id) {
  // 런타임 환경변수는 .env 유무와 관계없이 즉시 갱신 (배포 환경엔 .env가 없음)
  process.env.IG_USER_ID = id;
  let content;
  try { content = await fs.readFile(ENV_FILE, 'utf8'); } catch { return; }
  let updated = content.replace(/^IG_USER_ID=.*/m, `IG_USER_ID=${id}`);
  if (updated === content) updated += `\nIG_USER_ID=${id}`;
  await fs.writeFile(ENV_FILE, updated, 'utf8');
}

/**
 * 최근 인스타 캡션 수집 (빈 캡션 제외, 페이지네이션으로 limit개 확보 시도).
 */
export async function fetchCaptions({ limit = 50 } = {}) {
  const step = '캡션 수집';
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!token) {
    throw new Error(`${step}: INSTAGRAM_ACCESS_TOKEN 환경변수가 설정되지 않았습니다.`);
  }

  // IG_USER_ID가 없거나 접근 불가일 때 자동 탐색
  let igUserId = process.env.IG_USER_ID;
  if (!igUserId) {
    console.log('IG_USER_ID 미설정 → Instagram 계정 자동 탐색...');
    igUserId = await discoverIgUserId(token);
  }

  let url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${igUserId}/media` +
    `?fields=caption,timestamp,permalink,media_type&limit=50&access_token=${encodeURIComponent(token)}`;

  const captions = [];
  let page = 0;
  const MAX_PAGES = 10;

  while (url && captions.length < limit && page < MAX_PAGES) {
    page += 1;
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      throw new Error(`${step}: Instagram API 네트워크 오류 — ${err.message}`);
    }

    if (!res.ok) {
      let errBody = null;
      try { errBody = await res.json(); } catch { /* 무시 */ }
      const code = errBody?.error?.code;
      const message = errBody?.error?.message || '';
      if (res.status === 401 || code === 190) {
        throw new Error(TOKEN_EXPIRED_MESSAGE);
      }
      // code 100: 잘못된 IG_USER_ID → 자동 재탐색 후 1회 재시도
      if (code === 100 && page === 1) {
        console.log(`IG_USER_ID(${igUserId}) 접근 불가 → 자동 재탐색...`);
        igUserId = await discoverIgUserId(token);
        url =
          `https://graph.facebook.com/${GRAPH_API_VERSION}/${igUserId}/media` +
          `?fields=caption,timestamp,permalink,media_type&limit=50&access_token=${encodeURIComponent(token)}`;
        continue;
      }
      throw new Error(`${step}: Instagram API 오류 (HTTP ${res.status}${code ? `, code ${code}` : ''}) — ${message}`);
    }

    const data = await res.json();
    for (const media of data.data || []) {
      if (media.caption && media.caption.trim()) {
        captions.push(media.caption.trim());
      }
    }
    url = data.paging?.next || null;
  }

  if (captions.length === 0) {
    throw new Error(`${step}: 수집된 캡션이 없습니다. IG_USER_ID(${igUserId})가 올바른지 확인하세요.`);
  }

  console.log(`캡션 ${captions.length}개 수집 완료 (${page}페이지 조회)`);
  return captions.slice(0, limit);
}
