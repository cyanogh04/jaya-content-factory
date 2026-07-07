// src/notion.js — Notion API 저장 모듈
// 강의 1개 결과물(4종) → Notion 데이터베이스 페이지 1개로 저장

const NOTION_VERSION = '2022-06-28';
const NOTION_API = 'https://api.notion.com/v1';

/** 긴 텍스트를 Notion 2000자 제한에 맞춰 paragraph 블록 배열로 분할 */
function textToBlocks(heading, content) {
  const blocks = [
    {
      object: 'block',
      type: 'heading_2',
      heading_2: { rich_text: [{ type: 'text', text: { content: heading } }] },
    },
  ];

  const MAX = 1900;
  let remaining = (content || '').trim();
  while (remaining.length > 0) {
    let chunk;
    if (remaining.length <= MAX) {
      chunk = remaining;
      remaining = '';
    } else {
      let cut = remaining.lastIndexOf('\n', MAX);
      if (cut <= 0) cut = MAX;
      chunk = remaining.slice(0, cut);
      remaining = remaining.slice(cut).trimStart();
    }
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: chunk } }] },
    });
  }
  return blocks;
}

/**
 * 강의 결과물을 Notion 데이터베이스에 저장.
 * @returns {Promise<{url: string, id: string}>}
 */
export async function saveLectureToNotion({ title, vimeoUrl, cafe, caption, carousel, capture }) {
  const notionKey = process.env.NOTION_API_KEY;
  const dbId = process.env.NOTION_DATABASE_ID;

  if (!notionKey || !dbId) {
    throw new Error(
      'NOTION_API_KEY 또는 NOTION_DATABASE_ID가 .env에 없습니다. ' +
      'Notion Integration 토큰과 저장할 데이터베이스 ID를 설정해주세요.'
    );
  }

  const today = new Date().toISOString().slice(0, 10);

  const children = [
    ...textToBlocks('📋 카페 서머리', cafe),
    { object: 'block', type: 'divider', divider: {} },
    ...textToBlocks('📸 인스타 캡션', caption),
    { object: 'block', type: 'divider', divider: {} },
    ...textToBlocks('🎠 캐러셀 기획', carousel),
    { object: 'block', type: 'divider', divider: {} },
    ...textToBlocks('📷 캡쳐 가이드', capture),
  ];

  const MAX_BLOCKS = 99;
  const firstChunk = children.slice(0, MAX_BLOCKS);
  const remaining = children.slice(MAX_BLOCKS);

  const notionHeaders = {
    Authorization: `Bearer ${notionKey}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };

  const res = await fetch(`${NOTION_API}/pages`, {
    method: 'POST',
    headers: notionHeaders,
    body: JSON.stringify({
      parent: { database_id: dbId },
      properties: {
        '제목': { title: [{ type: 'text', text: { content: title } }] },
        '날짜': { date: { start: today } },
        '비메오URL': { url: vimeoUrl },
      },
      children: firstChunk,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    const msg = data?.message || data?.code || JSON.stringify(data);
    throw new Error(`노션 저장 실패: ${msg}`);
  }

  // 100블록 초과 시 분할 추가
  for (let i = 0; i < remaining.length; i += MAX_BLOCKS) {
    const chunk = remaining.slice(i, i + MAX_BLOCKS);
    const appendRes = await fetch(`${NOTION_API}/blocks/${data.id}/children`, {
      method: 'PATCH',
      headers: notionHeaders,
      body: JSON.stringify({ children: chunk }),
    });
    const appendData = await appendRes.json();
    if (!appendRes.ok) {
      const msg = appendData?.message || JSON.stringify(appendData);
      throw new Error(`노션 블록 추가 실패: ${msg}`);
    }
  }

  console.log(`노션 저장 완료: ${data.url}`);
  return { url: data.url, id: data.id };
}
