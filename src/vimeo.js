// src/vimeo.js — Vimeo 자막 자동 수집: URL 파싱 → 텍스트트랙 조회 → VTT 파싱 → 압축
//
// 지원 URL 형태:
//   vimeo.com/{id}
//   vimeo.com/{id}/{hash}          (비공개 링크)
//   player.vimeo.com/video/{id}
//   vimeo.com/share/{hash}...      (공유 링크 — oEmbed API로 실제 video_id 해석)

const VIMEO_API = 'https://api.vimeo.com';

function requireToken(step) {
  const token = process.env.VIMEO_ACCESS_TOKEN;
  if (!token) {
    throw new Error(`${step}: VIMEO_ACCESS_TOKEN 환경변수가 설정되지 않았습니다. .env 파일을 확인하세요.`);
  }
  return token;
}

/** URL 문자열에서 숫자 video_id를 바로 뽑을 수 있으면 반환, 아니면 null */
export function parseVideoId(url) {
  if (!url || typeof url !== 'string') return null;
  const playerMatch = url.match(/player\.vimeo\.com\/video\/(\d+)/);
  if (playerMatch) return playerMatch[1];
  // 공유 링크(vimeo.com/share/...)는 숫자 ID가 없으므로 여기서 처리하지 않는다
  if (/vimeo\.com\/share\//.test(url)) return null;
  const plainMatch = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (plainMatch) return plainMatch[1];
  return null;
}

/** 공유 링크 등 — oEmbed API로 실제 video_id 해석 */
async function resolveViaOembed(url) {
  const step = '자막 수집(공유 링크 해석)';
  let res;
  try {
    res = await fetch(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`);
  } catch (err) {
    throw new Error(`${step}: Vimeo oEmbed 네트워크 오류 — ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`${step}: Vimeo oEmbed 응답 오류 (HTTP ${res.status}). 링크가 올바른지, 영상이 공개 상태인지 확인하세요.`);
  }
  const data = await res.json();
  if (!data.video_id) {
    throw new Error(`${step}: 공유 링크에서 video_id를 찾지 못했습니다. 영상 페이지의 원본 URL을 사용해 보세요.`);
  }
  return String(data.video_id);
}

/** URL → video_id (공유 링크 포함) */
export async function resolveVideoId(url) {
  const direct = parseVideoId(url);
  if (direct) return direct;
  if (/vimeo\.com\//.test(url)) return resolveViaOembed(url);
  throw new Error(`자막 수집: 비메오 URL 형식이 아닙니다 — ${url}`);
}

/** 영상 메타데이터 (제목, 길이) */
async function getVideoInfo(videoId) {
  const step = '자막 수집(영상 정보)';
  const token = requireToken(step);
  let res;
  try {
    res = await fetch(`${VIMEO_API}/videos/${videoId}?fields=name,duration`, {
      headers: { Authorization: `bearer ${token}` },
    });
  } catch (err) {
    throw new Error(`${step}: Vimeo API 네트워크 오류 — ${err.message}`);
  }
  if (res.status === 401) throw new Error(`${step}: Vimeo 인증 실패 (HTTP 401). VIMEO_ACCESS_TOKEN을 확인하세요.`);
  if (res.status === 404) throw new Error(`${step}: 영상을 찾을 수 없습니다 (HTTP 404, video_id: ${videoId}). 토큰 계정이 이 영상에 접근 가능한지 확인하세요.`);
  if (!res.ok) throw new Error(`${step}: Vimeo API 오류 (HTTP ${res.status})`);
  const data = await res.json();
  return { title: data.name || '', duration: data.duration || 0 };
}

/** 텍스트 트랙 목록 조회 → 한국어 우선, 없으면 첫 트랙 */
export async function getTextTracks(videoId) {
  const step = '자막 수집(트랙 조회)';
  const token = requireToken(step);
  let res;
  try {
    res = await fetch(`${VIMEO_API}/videos/${videoId}/texttracks`, {
      headers: { Authorization: `bearer ${token}` },
    });
  } catch (err) {
    throw new Error(`${step}: Vimeo API 네트워크 오류 — ${err.message}`);
  }
  if (res.status === 401) throw new Error(`${step}: Vimeo 인증 실패 (HTTP 401). VIMEO_ACCESS_TOKEN을 확인하세요.`);
  if (!res.ok) throw new Error(`${step}: Vimeo API 오류 (HTTP ${res.status})`);
  const data = await res.json();
  return data.data || [];
}

function pickTrack(tracks, videoId) {
  const usable = tracks.filter((t) => t.link);
  if (usable.length === 0) {
    throw new Error(
      `자막 수집: 이 영상(${videoId})에 자막 트랙이 없습니다. Vimeo 설정에서 AI 자막을 활성화하세요.`
    );
  }
  const korean = usable.find((t) => (t.language || '').toLowerCase().startsWith('ko'));
  return korean || usable[0];
}

/** VTT 파일 다운로드 (비공개 영상 대응 — Authorization 헤더 포함) */
async function fetchVtt(track) {
  const step = '자막 수집(VTT 다운로드)';
  const token = requireToken(step);
  let res;
  try {
    res = await fetch(track.link, { headers: { Authorization: `bearer ${token}` } });
  } catch (err) {
    throw new Error(`${step}: VTT 다운로드 네트워크 오류 — ${err.message}`);
  }
  if (!res.ok) throw new Error(`${step}: VTT 다운로드 실패 (HTTP ${res.status})`);
  return res.text();
}

/** "00:01:23.456" 또는 "01:23.456" → 초 */
function vttTimeToSeconds(t) {
  const parts = t.trim().split(':');
  let h = 0, m = 0, s = 0;
  if (parts.length === 3) {
    [h, m] = [parseInt(parts[0], 10), parseInt(parts[1], 10)];
    s = parseFloat(parts[2]);
  } else if (parts.length === 2) {
    m = parseInt(parts[0], 10);
    s = parseFloat(parts[1]);
  } else {
    return 0;
  }
  return h * 3600 + m * 60 + s;
}

/** 초 → [MM:SS] (60분 초과 영상은 분이 60을 넘을 수 있음 — 총 분 표기 유지) */
export function formatTimestamp(seconds) {
  const total = Math.floor(seconds);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/** WebVTT 파싱 → [{ start, text }] (HTML 태그 제거) */
export function parseVtt(vtt) {
  const cues = [];
  const blocks = vtt.replace(/\r/g, '').split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const timeLineIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeLineIdx === -1) continue; // WEBVTT 헤더, NOTE, STYLE 등 스킵
    const timeLine = lines[timeLineIdx];
    const startStr = timeLine.split('-->')[0];
    const start = vttTimeToSeconds(startStr);
    const text = lines
      .slice(timeLineIdx + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '') // <b>, <c.color> 등 태그 제거
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) cues.push({ start, text });
  }
  return cues;
}

/** 큐 배열 → "[MM:SS] 텍스트" 줄들 */
function cuesToText(cues) {
  return cues.map((c) => `[${formatTimestamp(c.start)}] ${c.text}`).join('\n');
}

/** 30초 간격 대표 큐 샘플링 (60분 초과 영상용 압축) */
export function compressCues(cues, intervalSec = 30) {
  const sampled = [];
  let lastBucket = -1;
  for (const cue of cues) {
    const bucket = Math.floor(cue.start / intervalSec);
    if (bucket !== lastBucket) {
      sampled.push(cue);
      lastBucket = bucket;
    }
  }
  return sampled;
}

/**
 * 비메오 URL 하나로 자막 수집 전 과정 실행.
 * @returns {Promise<{videoId, title, duration, full, compressed, cueCount}>}
 *   full: 원본 자막 (캡쳐 가이드용), compressed: 압축 자막 (60분 이하면 full과 동일)
 */
export async function getTranscript(url) {
  const videoId = await resolveVideoId(url);
  console.log(`영상 ID 확인: ${videoId}`);

  const info = await getVideoInfo(videoId);
  console.log(`영상 제목: ${info.title} (길이 ${Math.round(info.duration / 60)}분)`);

  const tracks = await getTextTracks(videoId);
  const track = pickTrack(tracks, videoId);
  console.log(`자막 트랙 선택: ${track.language || '(언어 미상)'} — ${track.display_language || track.name || ''}`);

  const vtt = await fetchVtt(track);
  const cues = parseVtt(vtt);
  if (cues.length === 0) {
    throw new Error(`자막 수집: VTT 파싱 결과 자막 큐가 없습니다 (video_id: ${videoId}).`);
  }
  console.log(`자막 ${cues.length}개 큐 수집 완료`);

  const full = cuesToText(cues);
  let compressed = full;
  if (info.duration > 3600) {
    const sampled = compressCues(cues);
    compressed = cuesToText(sampled);
    console.log(`60분 초과 영상 — 30초 간격 압축본 생성 (${cues.length} → ${sampled.length}개 큐)`);
  }

  return {
    videoId,
    title: info.title,
    duration: info.duration,
    full,
    compressed,
    cueCount: cues.length,
  };
}
