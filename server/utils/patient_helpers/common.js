'use strict';

function sanitizeDisplayText(raw) {
  if (!raw) return raw;
  return String(raw)
    // "phúth" → "phút" (lỗi thừa 'h' do regex g/ph → giọt/phút + h thừa)
    .replace(/phúth\b/g, 'phút')
    // "giọt/phúth" variant
    .replace(/giọt\/phúth/g, 'giọt/phút');
}


function dedupeStrings(values = []) {
  const out  = [];
  const seen = new Set();
  for (const value of values) {
    const s   = String(value || '').trim();
    const key = s.toLowerCase();
    if (!s || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function dedupeBy(items = [], keyFn = item => JSON.stringify(item)) {
  const out  = [];
  const seen = new Set();
  for (const item of (items || [])) {
    if (item == null) continue;
    const key = String(keyFn(item) || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function firstNonEmpty(values = []) {
  for (const value of values) {
    const s = String(value || '').trim();
    if (s) return s;
  }
  return '';
}

module.exports = { sanitizeDisplayText, dedupeStrings, dedupeBy, firstNonEmpty };
