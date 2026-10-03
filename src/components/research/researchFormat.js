
// ── helpers ──────────────────────────────────────────────────────────────────
function text(v) { return String(v ?? '').trim(); }

function lower(v) { return text(v).toLowerCase(); }

function pick(row, keys, fb = '') {
  for (const k of keys) if (text(row?.[k])) return text(row[k]);
  return fb;
}

function saveBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function parseDate(v) {
  const s = text(v);
  let m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return new Date(+m[3], +m[2]-1, +m[1]);
  m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(+m[1], +m[2]-1, +m[3]);
  return null;
}

function parseDateTime(v) {
  const s = text(v);
  let m = s.match(/(\d{1,2}):(\d{2})\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return new Date(+m[5], +m[4]-1, +m[3], +m[1], +m[2]);
  m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (m) return new Date(+m[3], +m[2]-1, +m[1], +m[4], +m[5]);
  m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]+(\d{1,2}):(\d{2}))?/);
  if (m) return new Date(+m[1], +m[2]-1, +m[3], +(m[4] || 0), +(m[5] || 0));
  return parseDate(s);
}

function compactNumber(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n.toLocaleString('vi-VN') : String(v || 0);
}

export {
  text,
  lower,
  pick,
  saveBlob,
  parseDate,
  parseDateTime,
  compactNumber,
};
