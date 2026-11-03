// src/timestamp.js — 초 → "MM:SS". vimeo.js와 course.js가 함께 쓴다(course.js가 vimeo.js를 끌어오지 않게 분리).

export function formatTimestamp(seconds) {
  const total = Math.floor(seconds);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
