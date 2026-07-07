# 기획서 (PRD) — 자야쌤 강의 콘텐츠 자동화 웹앱

## 1. 한 줄 정의
비메오 강의 URL 하나를 브라우저에 입력하면, 자막을 자동 수집하고 자야쌤의 실제 인스타 말투로 네이버 카페 서머리·인스타 캡션·캐러셀 기획·캡쳐 가이드 4종을 생성하며, 마음에 들지 않으면 수정 요청을 입력해 재생성할 수 있는 **콘텐츠 공장 웹앱**.

## 2. 배경 / 목적
- 자야쌤은 15년차 소잉 교육·콘텐츠 사업자(공구 순익 회당 약 1,000만 원 → 목표 5,000만 원, 온라인 강의 연 매출 목표 3억).
- 강의 영상마다 카페·인스타 콘텐츠를 반복 생산하는 데 시간이 소모됨.
- **자동화의 두 전제**:
  1. **진정성 유지** — 생성물이 자야쌤이 직접 쓴 글과 구분되지 않아야 함. 범용 AI 문체가 아닌 자야쌤 캡션을 학습한 '자기 목소리의 재조합'.
  2. **누가 써도 일정한 품질** — 자야쌤 본인, 직원, 어시스턴트 누구든 브라우저만 열면 동일한 품질의 콘텐츠 초안을 뽑을 수 있어야 함.
- n8n 없이 단일 코드베이스로 관리·확장.

## 3. 목표 (성공 기준)
1. **입력은 비메오 URL 단 하나**. 자막 수동 추출 없음. 터미널·개발 지식 불필요.
2. 집에서도 사무실에서도 브라우저로 접근 가능.
3. 인스타 캡션·카페 서머리가 자야쌤 말투와 자연스럽게 일치.
4. 생성 결과가 마음에 들지 않으면 수정 요청 한 줄로 재생성 가능.
5. 캡쳐 가이드 타임스탬프가 실제 영상 시점과 정확히 대응.

## 4. 범위
**In scope**
- 비메오 자막 자동 수집 (Vimeo API)
- 인스타 캡션 수집 → 말투 보이스 프로파일 생성/저장
- 텍스트 4종 순차 생성 + 화면 표시
- 카페 서머리·인스타 캡션 개별 수정 요청 → 재생성
- 수정 확정 후 캐러셀·캡쳐 가이드 재생성
- 결과 Supabase DB 저장 (로컬 개발 시 파일 저장)

**Out of scope (별도 작업)**
- 카드뉴스·이미지 생성 및 디자인 렌더링
- 인스타/카페 자동 게시 (이 앱은 '초안'까지만 생산)

## 5. 핵심 기능

### 기능 A — 콘텐츠 생성 (메인 플로우)
1. URL + 강의 주제(선택) 입력 → [생성 시작] 클릭.
2. 자막 수집 → 4종을 **순차적으로** 생성하며 완료되는 즉시 화면에 표시.
   - 카페 서머리 → 인스타 캡션 → 캐러셀 기획 → 캡쳐 가이드 순.
3. 각 항목 완료 시 바로 읽고 수정 요청 가능(전체 완료를 기다릴 필요 없음).

### 기능 B — 개별 수정 재생성
- **카페 서머리** 또는 **인스타 캡션** 아래 수정 요청 입력란에 지시 입력 후 [재생성].
  - 예: "첫 문단을 좀 더 따뜻하게", "마지막 CTA 부분 다시"
- 해당 섹션만 재생성, 나머지는 유지.

### 기능 C — 캐러셀·캡쳐 가이드 재생성
- 카페/캡션 수정이 완료된 후 [캐러셀·캡쳐 가이드 재생성] 버튼 클릭.
- 확정된 카페·캡션 내용을 반영해 캐러셀과 캡쳐 가이드를 다시 생성.

### 기능 D — 보이스 프로파일 갱신 (가끔 실행, 관리자용)
- 인스타 그래프 API로 최근 캡션 30~50개 수집 → 말투 분석 → `voice_profile` 갱신.
- 기존 프로파일은 타임스탬프 백업 후 덮어씀.

## 6. 화면 구성 (UI 와이어프레임)

```
┌──────────────────────────────────────────────────────┐
│  자야쌤 콘텐츠 공장                                    │
│                                                        │
│  강의 URL  [________________________________]          │
│  강의 주제 [________________] (선택)                   │
│                              [생성 시작]               │
│                                                        │
│  ─────────────────────────────────────────────────   │
│                                                        │
│  ✅ 카페 서머리                               [복사]   │
│  ┌──────────────────────────────────────────────┐    │
│  │ (생성된 텍스트)                               │    │
│  └──────────────────────────────────────────────┘    │
│  수정 요청: [________________________] [재생성]        │
│                                                        │
│  ⏳ 인스타 캡션 생성 중...                             │
│                                                        │
│  ─ 캐러셀 기획 (캡션 확정 후 활성화)                   │
│  ─ 캡쳐 가이드 (캡션 확정 후 활성화)                   │
│                                                        │
│                [캐러셀·캡쳐 가이드 재생성]              │
└──────────────────────────────────────────────────────┘
```

## 7. 아키텍처 / 데이터 흐름

```
[브라우저]
  URL 입력 → POST /api/generate
           ← SSE 스트림: 섹션별 완료 이벤트 수신 → 화면 표시

  수정 요청 → POST /api/revise  { jobId, type, instruction }
           ← 재생성 결과

  재생성    → POST /api/regenerate { jobId }  (캐러셀·캡쳐)
           ← 재생성 결과

[서버 — Node.js Express]
  vimeo.js       # 자막 수집 + VTT 파싱
  instagram.js   # 캡션 수집
  voice.js       # 보이스 프로파일 관리
  generate.js    # 4종 순차 생성 오케스트레이션
  revise.js      # 수정 재생성
  anthropic.js   # Anthropic API 래퍼 (캐싱 포함)
  prompts.js     # 프롬프트 조립
  db.js          # Supabase 클라이언트 (로컬: 파일)

[저장소]
  로컬 개발: /data/voice_profile.json, /outputs/<video_id>/
  운영(Supabase): jobs 테이블, contents 테이블, voice_profile 테이블
```

### API 엔드포인트

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/generate` | URL 입력 → 자막 수집 + 4종 순차 생성 (SSE) |
| POST | `/api/revise` | 특정 섹션 수정 재생성 |
| POST | `/api/regenerate` | 캐러셀·캡쳐 가이드 재생성 |
| POST | `/api/learn-voice` | 보이스 프로파일 갱신 (관리자) |
| GET | `/api/job/:id` | 저장된 결과 조회 |

### 폴더 구조
```
/src
  server.js           # Express 서버 + API 라우팅
  vimeo.js            # 자막 수집 + VTT 파싱
  instagram.js        # 캡션 수집
  voice.js            # 보이스 프로파일 생성/로드
  generate.js         # 4종 생성 오케스트레이션
  revise.js           # 수정 재생성 로직
  anthropic.js        # Anthropic API 래퍼
  prompts.js          # 프롬프트 조립
  db.js               # Supabase 클라이언트
/public
  index.html          # 메인 UI
  app.js              # 프론트엔드 로직 (Vanilla JS)
  style.css           # 스타일
/data
  voice_profile.json  # 로컬 개발용
/outputs              # 로컬 개발용 파일 저장
.env
```

## 8. 수정 재생성 워크플로우

```
카페 서머리 재생성 요청
  → prompts.revise(originalCafe, instruction, voice, transcript)
  → Anthropic opus 호출
  → 응답으로 카페 서머리 교체

인스타 캡션 재생성 요청
  → prompts.revise(originalCaption, instruction, voice, transcript)
  → Anthropic opus 호출
  → 응답으로 캡션 교체

[캐러셀·캡쳐 가이드 재생성] 클릭
  → 확정된 cafe + caption + transcript 기반
  → carousel, capture 순차 재생성
```

## 9. 데이터 모델 (Supabase)

```sql
-- 영상별 작업
CREATE TABLE jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id    text NOT NULL,
  video_title text,
  vimeo_url   text NOT NULL,
  topic       text,
  transcript_compressed text,
  transcript_full       text,
  created_at  timestamptz DEFAULT now()
);

-- 생성된 콘텐츠 (버전 관리)
CREATE TABLE contents (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id   uuid REFERENCES jobs(id),
  type     text NOT NULL,  -- 'cafe' | 'caption' | 'carousel' | 'capture'
  content  text NOT NULL,
  version  int  DEFAULT 1,
  created_at timestamptz DEFAULT now()
);

-- 보이스 프로파일 (단일 행 유지)
CREATE TABLE voice_profile (
  id         int PRIMARY KEY DEFAULT 1,
  profile    jsonb NOT NULL,
  updated_at timestamptz DEFAULT now()
);
```

## 10. 외부 연동 명세

### 10.1 Vimeo (자막 자동 수집)
- video_id 파싱: `vimeo.com/{id}`, `player.vimeo.com/video/{id}`, `vimeo.com/{id}/{hash}`, 공유 링크(`vimeo.com/share/{hash}`) 형태 대응. 공유 링크는 canonical URL(`og:url`)에서 실제 video_id 추출.
- 자막 목록: `GET https://api.vimeo.com/videos/{id}/texttracks` (`Authorization: bearer {VIMEO_ACCESS_TOKEN}`).
- VTT fetch 시에도 `Authorization: bearer` 헤더 포함 (비공개 영상 대응).
- 한국어 트랙 우선, 없으면 첫 트랙, 없으면 에러("Vimeo 설정에서 AI 자막을 활성화하세요").
- WebVTT 파싱: HTML 태그 제거, `[MM:SS] 텍스트` 조립.
- 60분 초과 시 30초 간격 샘플링 압축본(생성용)과 원본(캡쳐 가이드용) 분리 반환.

### 10.2 Instagram (말투 학습)
- 핸드북 프로젝트의 장기 토큰 자동 갱신 구조 그대로 사용. 동일 `.env` 값 공유.
- 캡션 수집: `GET https://graph.facebook.com/v21.0/{IG_USER_ID}/media?fields=caption,timestamp,permalink,media_type&limit=50&access_token={INSTAGRAM_ACCESS_TOKEN}`.
- API 버전 상수 `GRAPH_API_VERSION = 'v21.0'`으로 코드 한 곳에서 관리.

### 10.3 Anthropic (생성)
- 모델: 말투 중요 섹션(cafe·caption) → `claude-opus-4-8`, 구조 위주(carousel·capture) → `claude-sonnet-4-6`.
- `max_tokens` 4000 이상.
- **프롬프트 캐싱**: 자막 블록에 `cache_control: {"type": "ephemeral"}` 적용. 4종 순차 호출 시 자막 입력 토큰 약 90% 절감.

## 11. 환경변수 (.env)
```
ANTHROPIC_API_KEY=
VIMEO_ACCESS_TOKEN=
INSTAGRAM_ACCESS_TOKEN=
IG_USER_ID=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
PORT=3000
```
※ 시크릿은 절대 코드/깃에 하드코딩하지 않는다.

## 12. 배포 계획
1. **로컬 개발·테스트**: `node src/server.js`, 파일 기반 저장.
2. **운영 배포**: Supabase DB + [Railway / Render] Express 서버.
   - Supabase Edge Functions는 실행 시간 제한(150초)으로 긴 영상 생성에 부적합. 서버는 별도 호스팅.
   - DB(jobs, contents, voice_profile)와 인증만 Supabase 활용.

## 13. 비기능 요구
- 한국어 품질 우선 (토큰 여유).
- 프롬프트·보이스 프로파일은 코드와 분리해 비개발자도 수정 가능.
- 각 생성 단계의 진행 상황을 UI에서 실시간 확인.
- 섹션 생성 실패 시 해당 섹션만 재시도 가능, 전체 재시작 불필요.
- `voice_profile` 갱신 전 타임스탬프 백업 자동 생성.
- 글자수 기준: 카페 서머리 2,000자 내외 / 인스타 캡션 1,000~1,300자 내외(해시태그 제외).
- 캐러셀 8~10컷, 캡쳐 가이드 5~8컷.
