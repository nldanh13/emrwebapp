'use strict';

// Biến tự định nghĩa của nghiên cứu: tính thêm cột cho file "Biến đã chọn" từ các cột đã có, không cần
// sửa code cho từng nghiên cứu. Năm kiểu:
//  - date_diff:     hiệu hai mốc thời gian (ngày lịch / giờ / phút). Vd. số ngày trước mổ, thời gian mổ.
//  - formula:       công thức số học trên các cột (+ - * / ^ và ngoặc). Vd. BMI = can_nang / (chieu_cao/100)^2.
//  - cut:           chia nhóm một cột số theo ngưỡng. Vd. nhóm tuổi, phân loại BMI.
//  - keyword_group: gom nhóm theo từ khóa hoặc mã ICD trong một/nhiều cột chữ. Vd. loại PT, vùng PT.
//  - note_number:   tìm con số sau một từ khóa trong tờ điều trị (Diễn biến/Y lệnh) theo ngày so với ngày
//                   mổ hoặc ngày vào viện. Vd. VAS ngày 1 sau mổ.
// Không đoán: thiếu dữ liệu nguồn hoặc không khớp thì để trống.

const KINDS = new Set(['date_diff', 'formula', 'cut', 'keyword_group', 'note_number']);
const MAX_DERIVED = 200;
const DAY_MS = 86400000;

const str = (v, n = 200) => String(v ?? '').trim().slice(0, n);

function slug(value, fallback = 'bien_moi') {
  const s = String(value || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/_+/g, '_')
    .slice(0, 60);
  if (!s) return fallback;
  return /^[A-Za-z_]/.test(s) ? s : `v_${s}`;
}

function comparable(value) {
  return String(value ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

function num(value) {
  const s = String(value ?? '').trim().replace(',', '.');
  if (!/^[-+]?\d+(?:\.\d+)?$/.test(s)) return NaN;
  return Number(s);
}

function fmtNum(n, digits = 2) {
  if (!Number.isFinite(n)) return '';
  return String(Number(n.toFixed(digits)));
}

// "2026-03-01 08:30", "2026-03-01", "01/03/2026 08:30", "08:30 01/03/2026" → { ms, day, hasTime }.
function parseWhen(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (m) return when(+m[1], +m[2], +m[3], m[4], m[5]);
  m = s.match(/(\d{1,2}):(\d{2})\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return when(+m[5], +m[4], +m[3], m[1], m[2]);
  m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (m) return when(+m[3], +m[2], +m[1], m[4], m[5]);
  return null;
}
function when(y, mo, d, hh, mm) {
  const day = Date.UTC(y, mo - 1, d);
  if (!Number.isFinite(day)) return null;
  const hasTime = hh != null && mm != null;
  return { day, ms: day + (hasTime ? (+hh * 60 + +mm) * 60000 : 0), hasTime };
}

// ── Định nghĩa ──────────────────────────────────────────────────────────────
function sanitizeRules(rules) {
  return (Array.isArray(rules) ? rules : []).slice(0, 50).map(r => ({
    label: str(r?.label, 120),
    code: str(r?.code, 20),
    keywords: str(r?.keywords, 1000),
  })).filter(r => (r.label || r.code) && r.keywords);
}

function sanitizeParams(kind, p = {}) {
  if (kind === 'date_diff') {
    return { from: str(p.from, 90), to: str(p.to, 90), unit: ['days', 'hours', 'minutes'].includes(p.unit) ? p.unit : 'days' };
  }
  if (kind === 'formula') return { expression: str(p.expression, 500), digits: Math.max(0, Math.min(6, Number.isFinite(Number(p.digits)) ? Math.trunc(Number(p.digits)) : 2)) };
  if (kind === 'cut') {
    const breaks = (Array.isArray(p.breaks) ? p.breaks : String(p.breaks || '').split(/[;\s]+/))
      .map(num).filter(Number.isFinite).slice(0, 30);
    const sorted = [...new Set(breaks)].sort((a, b) => a - b);
    const labels = (Array.isArray(p.labels) ? p.labels : String(p.labels || '').split(';')).map(x => str(x, 80)).slice(0, 31);
    return { source: str(p.source, 90), breaks: sorted, labels };
  }
  if (kind === 'keyword_group') {
    const sources = (Array.isArray(p.sources) ? p.sources : String(p.sources || p.source || '').split(/[;,\s]+/))
      .map(x => str(x, 90)).filter(Boolean).slice(0, 10);
    return { sources, rules: sanitizeRules(p.rules), fallback: str(p.fallback, 120) };
  }
  if (kind === 'note_number') {
    const day = Number(p.day);
    return {
      keyword: str(p.keyword, 60),
      day_ref: p.day_ref === 'admission' ? 'admission' : 'surgery',
      day: Number.isFinite(day) ? Math.max(-30, Math.min(365, Math.trunc(day))) : 1,
      pick: ['first', 'last', 'max', 'min'].includes(p.pick) ? p.pick : 'max',
    };
  }
  return {};
}

function sanitizeDerivedVariables(list) {
  const out = [];
  const used = new Set();
  for (const d of (Array.isArray(list) ? list : []).slice(0, MAX_DERIVED)) {
    const kind = String(d?.kind || '');
    if (!KINDS.has(kind)) continue;
    let name = slug(d?.name || d?.label);
    let i = 2;
    const base = name;
    while (used.has(name)) name = `${base}_${i++}`;
    used.add(name);
    out.push({ id: `derived:${name}`, name, label: str(d?.label, 160) || name, kind, params: sanitizeParams(kind, d?.params || {}) });
  }
  return out;
}

// ── Công thức ───────────────────────────────────────────────────────────────
// Bộ đọc công thức tự viết (không dùng eval): số, tên cột, + - * / ^, ngoặc, dấu âm.
function tokenize(expr) {
  const tokens = [];
  const re = /\s*(?:(\d+(?:[.,]\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([-+*/^()]))/y;
  let pos = 0;
  const s = String(expr || '');
  while (pos < s.length) {
    if (/^\s*$/.test(s.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m) throw new Error(`Công thức có ký tự không đọc được ở vị trí ${pos + 1}.`);
    pos = re.lastIndex;
    if (m[1]) tokens.push({ t: 'num', v: Number(m[1].replace(',', '.')) });
    else if (m[2]) tokens.push({ t: 'id', v: m[2] });
    else tokens.push({ t: 'op', v: m[3] });
  }
  return tokens;
}

function parseFormula(expr) {
  const tokens = tokenize(expr);
  let i = 0;
  const peek = () => tokens[i];
  const take = v => { if (peek()?.v === v) { i += 1; return true; } return false; };
  function primary() {
    const tok = tokens[i++];
    if (!tok) throw new Error('Công thức bị thiếu ở cuối.');
    if (tok.t === 'num') return { k: 'num', v: tok.v };
    if (tok.t === 'id') return { k: 'col', v: tok.v };
    if (tok.v === '(') { const e = add(); if (!take(')')) throw new Error('Thiếu dấu đóng ngoặc.'); return e; }
    if (tok.v === '-') return { k: 'neg', a: power() };
    if (tok.v === '+') return power();
    throw new Error(`Không hiểu "${tok.v}" trong công thức.`);
  }
  function power() { const a = primary(); return take('^') ? { k: '^', a, b: power() } : a; }
  function mul() { let a = power(); for (;;) { if (take('*')) a = { k: '*', a, b: power() }; else if (take('/')) a = { k: '/', a, b: power() }; else return a; } }
  function add() { let a = mul(); for (;;) { if (take('+')) a = { k: '+', a, b: mul() }; else if (take('-')) a = { k: '-', a, b: mul() }; else return a; } }
  if (!tokens.length) throw new Error('Chưa nhập công thức.');
  const tree = add();
  if (i < tokens.length) throw new Error(`Thừa "${tokens[i].v}" trong công thức.`);
  return tree;
}

function formulaColumns(tree, out = new Set()) {
  if (!tree) return out;
  if (tree.k === 'col') out.add(tree.v);
  formulaColumns(tree.a, out);
  formulaColumns(tree.b, out);
  return out;
}

function evalFormula(tree, row) {
  switch (tree.k) {
    case 'num': return tree.v;
    case 'col': return num(row?.[tree.v]);
    case 'neg': return -evalFormula(tree.a, row);
    case '+': return evalFormula(tree.a, row) + evalFormula(tree.b, row);
    case '-': return evalFormula(tree.a, row) - evalFormula(tree.b, row);
    case '*': return evalFormula(tree.a, row) * evalFormula(tree.b, row);
    case '/': { const b = evalFormula(tree.b, row); return b === 0 ? NaN : evalFormula(tree.a, row) / b; }
    case '^': return evalFormula(tree.a, row) ** evalFormula(tree.b, row);
    default: return NaN;
  }
}

// ── Tính từng kiểu ──────────────────────────────────────────────────────────
function computeDateDiff(p, row) {
  const a = parseWhen(row?.[p.from]);
  const b = parseWhen(row?.[p.to]);
  if (!a || !b) return '';
  if (p.unit === 'days') return String(Math.round((b.day - a.day) / DAY_MS));
  // Giờ/phút cần giờ thật ở cả hai mốc; chỉ có ngày thì không đoán.
  if (!a.hasTime || !b.hasTime) return '';
  const minutes = (b.ms - a.ms) / 60000;
  return p.unit === 'minutes' ? String(Math.round(minutes)) : fmtNum(minutes / 60, 1);
}

function computeCut(p, row) {
  const v = num(row?.[p.source]);
  if (!Number.isFinite(v) || !p.breaks.length) return '';
  // Khoảng [ngưỡng trước, ngưỡng sau): ngưỡng thuộc nhóm phía trên.
  let idx = 0;
  while (idx < p.breaks.length && v >= p.breaks[idx]) idx += 1;
  return p.labels[idx] || String(idx + 1);
}

function keywordList(text) {
  return String(text || '').split(/[;\n]+/).map(comparable).filter(Boolean);
}

function computeKeywordGroup(p, row) {
  const hay = comparable(p.sources.map(c => row?.[c] ?? '').join(' \n '));
  if (!hay) return '';
  for (const rule of p.rules) {
    if (keywordList(rule.keywords).some(k => hay.includes(k))) return rule.code || rule.label;
  }
  return p.fallback || '';
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Số đứng sau từ khóa trong vòng 20 ký tự không phải số: "VAS: 3/10", "VAS 3 điểm", "mất máu khoảng 200 ml".
function numbersAfterKeyword(text, keyword) {
  const hay = comparable(text);
  const key = comparable(keyword);
  if (!hay || !key) return [];
  const re = new RegExp(`${escapeRegex(key)}[^0-9\\n]{0,20}?(\\d+(?:[.,]\\d+)?)`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(hay))) out.push(num(m[1]));
  return out.filter(Number.isFinite);
}

function computeNoteNumber(p, notes, refDate) {
  const ref = parseWhen(refDate);
  if (!ref || !p.keyword) return '';
  const hits = [];
  for (const note of notes || []) {
    const at = parseWhen(note?.note_datetime || note?.note_date);
    if (!at || Math.round((at.day - ref.day) / DAY_MS) !== p.day) continue;
    const values = numbersAfterKeyword(`${note?.clinical_text || ''}\n${note?.order_text || ''}`, p.keyword);
    for (const value of values) hits.push({ value, ms: at.ms });
  }
  if (!hits.length) return '';
  hits.sort((a, b) => a.ms - b.ms);
  if (p.pick === 'first') return fmtNum(hits[0].value);
  if (p.pick === 'last') return fmtNum(hits[hits.length - 1].value);
  const vals = hits.map(h => h.value);
  return fmtNum(p.pick === 'min' ? Math.min(...vals) : Math.max(...vals));
}

// Kiểm định nghĩa trước khi lưu: cột nguồn có tồn tại, công thức đọc được. Trả danh sách lỗi tiếng Việt.
function validateDerivedVariables(defs, availableColumns = []) {
  const known = new Set(availableColumns);
  const errors = [];
  for (const d of defs) {
    if (known.has(d.name)) errors.push(`${d.label}: tên cột "${d.name}" trùng cột đã có, đặt tên khác.`);
    const need = [];
    if (d.kind === 'date_diff') need.push(d.params.from, d.params.to);
    if (d.kind === 'cut') {
      need.push(d.params.source);
      if (!d.params.breaks.length) errors.push(`${d.label}: chưa nhập ngưỡng chia nhóm.`);
    }
    if (d.kind === 'keyword_group') {
      need.push(...d.params.sources);
      if (!d.params.rules.length) errors.push(`${d.label}: chưa có nhóm nào (mỗi nhóm cần tên và từ khóa).`);
    }
    if (d.kind === 'formula') {
      try { need.push(...formulaColumns(parseFormula(d.params.expression))); } catch (e) { errors.push(`${d.label}: ${e.message}`); }
    }
    if (d.kind === 'note_number' && !d.params.keyword) errors.push(`${d.label}: chưa nhập từ khóa cần tìm.`);
    for (const col of need) {
      if (!col) errors.push(`${d.label}: chưa chọn cột nguồn.`);
      else if (known.size && !known.has(col)) errors.push(`${d.label}: không có cột "${col}" trong file Biến đã chọn.`);
    }
    known.add(d.name);
  }
  return errors;
}

/**
 * Thêm các cột biến tự định nghĩa vào một dòng của file "Biến đã chọn" (sửa trực tiếp `row`).
 * Biến sau dùng được kết quả của biến trước (vd. BMI rồi phân loại BMI).
 * context: { notes: các dòng clinical_notes của lượt, surgery_date, admission_date }.
 */
function applyDerivedVariables(defs, row, context = {}) {
  for (const d of defs || []) {
    let value = '';
    try {
      if (d.kind === 'date_diff') value = computeDateDiff(d.params, row);
      else if (d.kind === 'formula') {
        d._tree = d._tree || parseFormula(d.params.expression);
        const v = evalFormula(d._tree, row);
        value = Number.isFinite(v) ? fmtNum(v, d.params.digits) : '';
      } else if (d.kind === 'cut') value = computeCut(d.params, row);
      else if (d.kind === 'keyword_group') value = computeKeywordGroup(d.params, row);
      else if (d.kind === 'note_number') {
        const ref = d.params.day_ref === 'admission' ? context.admission_date : context.surgery_date;
        value = computeNoteNumber(d.params, context.notes, ref);
      }
    } catch (_) {
      value = '';
    }
    row[d.name] = value;
  }
  return row;
}

// Đổi tên cột được tham chiếu (khi tên biến trùng cột đã có và phải thêm hậu tố).
function renameDerivedRefs(d, renames) {
  const r = c => renames.get(c) || c;
  const p = { ...d.params };
  if (d.kind === 'date_diff') { p.from = r(p.from); p.to = r(p.to); }
  if (d.kind === 'cut') p.source = r(p.source);
  if (d.kind === 'keyword_group') p.sources = p.sources.map(r);
  if (d.kind === 'formula') p.expression = p.expression.replace(/[A-Za-z_][A-Za-z0-9_]*/g, r);
  return { ...d, params: p };
}

const KIND_TEXT = {
  date_diff: 'Hiệu hai mốc thời gian',
  formula: 'Công thức',
  cut: 'Chia nhóm theo ngưỡng',
  keyword_group: 'Gom nhóm theo từ khóa/mã ICD',
  note_number: 'Số trong tờ điều trị',
};

// Mô tả cách tính cho Từ điển biến.
function describeDerived(d) {
  const p = d.params || {};
  if (d.kind === 'date_diff') return `${KIND_TEXT.date_diff}: ${p.to} − ${p.from} (${{ days: 'ngày', hours: 'giờ', minutes: 'phút' }[p.unit]})`;
  if (d.kind === 'formula') return `${KIND_TEXT.formula}: ${p.expression}`;
  if (d.kind === 'cut') {
    const labels = p.breaks.map((_, i) => p.labels[i] || String(i + 1)).concat(p.labels[p.breaks.length] || String(p.breaks.length + 1));
    return `${KIND_TEXT.cut} ${p.source} tại ${p.breaks.join('; ')} → ${labels.join(' / ')} (ngưỡng thuộc nhóm trên)`;
  }
  if (d.kind === 'keyword_group') return `${KIND_TEXT.keyword_group} trong ${p.sources.join(', ')}: ${p.rules.map(r => `${r.code || r.label} = "${r.keywords}"`).join('; ')}${p.fallback ? `; còn lại = ${p.fallback}` : ''}`;
  if (d.kind === 'note_number') return `${KIND_TEXT.note_number}: số sau "${p.keyword}" ngày ${p.day} so với ${p.day_ref === 'admission' ? 'ngày vào viện' : 'ngày mổ'} (${{ first: 'lần đầu', last: 'lần cuối', max: 'lớn nhất', min: 'nhỏ nhất' }[p.pick]})`;
  return '';
}

function derivedType(d) {
  if (d.kind === 'keyword_group') return 'category';
  if (d.kind === 'cut') return d.params.labels.some(Boolean) ? 'category' : 'number';
  return 'number';
}

module.exports = {
  KINDS,
  KIND_TEXT,
  sanitizeDerivedVariables,
  validateDerivedVariables,
  applyDerivedVariables,
  renameDerivedRefs,
  describeDerived,
  derivedType,
  parseFormula,
  numbersAfterKeyword,
};
