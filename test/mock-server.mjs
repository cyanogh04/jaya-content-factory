// 화면 흐름 확인용 가짜 서버 — 모델·비메오만 가짜(토큰 0), 저장은 실제 파일 폴백(outputs/)
// 실행: npm run dev:mock → http://localhost:3100 (토큰 0 — 화면·흐름만 본다. outputs/에 가짜 작업이 생기니 보고 나서 지운다)
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = process.cwd();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = (p) => pathToFileURL(path.join(root, p)).href;

mock.module(url('src/anthropic.js'), {
  namedExports: {
    MODELS: { VOICE: 'x', CAFE: 'x', CAPTION: 'x', CAROUSEL: 'x', CAPTURE: 'x' },
    callClaude: async ({ step }) => {
      await sleep(1200);
      if (step === '강의 파악') return '- 수업 이름: 자야쌤의 크롭데님쟈켓 수업\n- 강의 한 줄: 가짜 강의 지도';
      if (step === '강좌 파악') return '- 수업 이름: 자야쌤의 크롭데님쟈켓 수업\n- 강의 한 줄: 청자켓을 재단부터 완성까지 배우는 수업이다\n- 강별 배움:\n  1강 — 원단 결 잡기와 재단\n  2강 — 몸판 주머니와 커프스\n  3강 — 칼라와 마무리\n- 전체 흐름: 1강에서 재단, 2강에서 몸판, 3강에서 완성';
      if (step.includes('캐러셀')) return `# 인스타 캐러셀 기획안 — 크롭데님쟈켓\n\n## 기획 개요\n- **총 컷 수**: 10컷\n- **후크 후보**:\n  · A안 [공감형] 청자켓 만들다 멈춘 적 있으시죠? → 속마음\n  · B안 [반전형] 심지가 답이 아니었어요. → 통념 부정\n  · C안 [위기형] 다음 자켓에서도 거기서 멈춰요. → 서늘함\n  · 채택: A안 → 자막 근거가 세다\n\n${Array.from({ length: 10 }, (_, i) => `## CUT ${i + 1} — 역할: learn\n**카드 텍스트**\n- 헤드카피: ${i + 1}번째 컷이에요.\n- 서브카피: 가짜 서브카피예요.\n- 본문: 가짜 본문이에요.`).join('\n\n')}`;
      if (step.includes('카페')) return `[강의 오픈] 크롭데님쟈켓 강좌\n\n안녕하세요~ 디바예요!\n\n✔️ 1강 재단\n원단 결을 잡아요.\n✔️ 2강 몸판\n주머니를 달아요.\n✔️ 3강 완성\n칼라를 달아요.\n\n📷 캡쳐 1 [1강 00:30] 원단을 당기는 장면\n\n📷 캡쳐 2 [3강 12:00] 완성 장면\n\n[소잉클래스 수강 신청하기]http://www.sewingclass.co.kr`;
      if (step.includes('카피')) return '[]';
      return `가짜 결과 (${step})\n\n[1강 00:30] — 장면 / 왜 / 사용처`;
    },
  },
});
mock.module(url('src/vimeo.js'), {
  namedExports: {
    resolveVideoId: async (u) => `mock-${u.split('/').pop()}`,
    getTranscript: async (u) => {
      await sleep(800);
      const id = u.split('/').pop();
      const lines = Array.from({ length: 40 }, (_, i) => `[${String(Math.floor((i * 20) / 60)).padStart(2, '0')}:${String((i * 20) % 60).padStart(2, '0')}] 가짜 자막 ${id} ${i}`).join('\n');
      return { videoId: `mock-${id}`, title: `3강-크롭데님쟈켓(칼라+마무리 ${id})`, duration: 800, compressed: lines, full: lines };
    },
  },
});
mock.module(url('src/voice.js'), { namedExports: { load: async () => ({ tone: '테스트', representative_captions: ['예시'] }), learn: async () => ({ captionCount: 0 }) } });

process.env.PORT = process.env.PORT || '3100';
await import(url('src/server.js'));
