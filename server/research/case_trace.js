'use strict';

// Nhật ký lượt quét (action log) và vết từng ca (case trace) của Kho nghiên cứu; che định danh khi trả về.

const fs = require('fs');
const path = require('path');
const { redactLogLine } = require('../utils/log_redact');
const { nowIso } = require('./store_paths');
const { readJsonSafe, writeJsonAtomic, ensureDir } = require('../utils/file');

function appendResearchRunLog(runDir, line) {
  try {
    fs.appendFileSync(path.join(runDir, 'action_log.txt'), `${redactLogLine(line)}\n`, 'utf-8');
  } catch (_) {}
}

const CASE_TRACE_JSONL = 'research_case_trace.jsonl';

const CASE_TRACE_RECENT_JSON = 'research_case_trace_recent.json';

const CASE_TRACE_RECENT_LIMIT = 10;

function clipTraceText(value, limit = 900) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normalizeCaseTraceEvent(event = {}) {
  const tag = clipTraceText(event.tag || 'WARN', 80);
  const out = {
    ts: clipTraceText(event.ts || nowIso(), 40),
    tag,
    step: clipTraceText(event.step || '', 260),
    screen: clipTraceText(event.screen || '', 260),
    sees: clipTraceText(event.sees || '', 900),
    takes: clipTraceText(event.takes || '', 900),
    writes: clipTraceText(event.writes || '', 900),
    target: clipTraceText(event.target || '', 420),
  };
  if (event.data && typeof event.data === 'object' && !Array.isArray(event.data)) {
    out.data = {};
    for (const [k, v] of Object.entries(event.data)) {
      out.data[clipTraceText(k, 80)] = typeof v === 'object' ? v : clipTraceText(v, 500);
    }
  }
  return out;
}

function readCaseTraceRecent(runDir) {
  const p = path.join(runDir || '', CASE_TRACE_RECENT_JSON);
  const arr = readJsonSafe(p, []);
  return Array.isArray(arr) ? arr : [];
}

function writeCaseTraceRecent(runDir, recent) {
  try {
    writeJsonAtomic(path.join(runDir, CASE_TRACE_RECENT_JSON), (recent || []).slice(-CASE_TRACE_RECENT_LIMIT));
  } catch (_) {}
}

function appendResearchCaseTrace(runDir, meta = {}, events = [], options = {}) {
  if (!runDir) return null;
  ensureDir(runDir);
  const safeEvents = (Array.isArray(events) ? events : [])
    .filter(Boolean)
    .slice(-200)
    .map(normalizeCaseTraceEvent);
  const payload = {
    case_id: clipTraceText(meta.case_id || meta.source_key || `${meta.ma_bn || ''}|${meta.research_code || ''}|${Date.now()}`, 220),
    ts: nowIso(),
    mode: clipTraceText(options.mode || meta.mode || '', 80),
    status: clipTraceText(options.status || meta.status || '', 40),
    index: Number(meta.index || options.index || 0) || 0,
    total: Number(meta.total || options.total || 0) || 0,
    ma_bn: clipTraceText(meta.ma_bn || meta['Mã BN'] || '', 80),
    ho_ten: clipTraceText(meta.ho_ten || meta['Họ tên'] || '', 160),
    research_code: clipTraceText(meta.research_code || meta['Mã NC'] || '', 120),
    date_from: clipTraceText(meta.date_from || meta['Ngày vào viện'] || '', 80),
    date_to: clipTraceText(meta.date_to || meta['Ngày ra viện'] || '', 80),
    files: Array.isArray(meta.files || options.files) ? (meta.files || options.files).map(x => clipTraceText(x, 40)) : [],
    counts: options.counts || meta.counts || {},
    output: clipTraceText(options.output || meta.output || '', 260),
    events: safeEvents,
  };
  try {
    fs.appendFileSync(path.join(runDir, CASE_TRACE_JSONL), JSON.stringify(payload) + '\n', 'utf-8');
  } catch (_) {}
  const recent = readCaseTraceRecent(runDir).filter(x => x && x.case_id !== payload.case_id);
  recent.push(payload);
  writeCaseTraceRecent(runDir, recent);
  return payload;
}

const CASE_TRACE_CURRENT_JSON = 'research_case_trace_current.json';

// Ca đang xử lý dở (chưa commit) — worker ghi ngay khi bắt đầu 1 ca và sau
// mỗi bước, xoá (ghi null) khi ca kết thúc. Cho UI biết "đang quét ca nào,
// đã lấy được gì" thay vì chỉ thấy ca đã xong (khác với readCaseTraceRecent).
function readCurrentCaseTrace(runDir) {
  if (!runDir) return null;
  const data = readJsonSafe(path.join(runDir, CASE_TRACE_CURRENT_JSON), null);
  if (!data || typeof data !== 'object') return null;
  const events = Array.isArray(data.events) ? data.events : [];
  const last = events[events.length - 1] || null;
  return {
    case_id: clipTraceText(data.case_id || '', 220),
    ma_bn: clipTraceText(data.ma_bn || '', 80),
    ho_ten: clipTraceText(data.ho_ten || '', 160),
    research_code: clipTraceText(data.research_code || '', 120),
    index: Number(data.index || 0) || 0,
    total: Number(data.total || 0) || 0,
    started_at: clipTraceText(data.ts || '', 40),
    events_count: events.length,
    last_step: last ? {
      tag: clipTraceText(last.tag || '', 80),
      step: clipTraceText(last.step || '', 260),
      takes: clipTraceText(last.takes || '', 300),
    } : null,
  };
}

const HCHANH_CURRENT_CASE_SOURCES = [
  ['hchanh_auto_progress.json', 'Hồ sơ nền/Ra viện/Phẫu thuật'],
  ['order_history_auto_progress.json', 'Y lệnh'],
];

// fetchHchanhForResearchRun() (bên dưới) đã tự ghi progress[key].status =
// 'running' vào hchanh_auto_progress.json / order_history_auto_progress.json
// NGAY TRƯỚC khi spawn worker cho từng ca, và cập nhật lại done/partial/error
// sau khi xong — nên "ca đang chạy" đã có sẵn trên đĩa, không cần thêm cơ chế
// mới như research_case_trace_current.json (vốn chỉ dành cho script Python
// tự lặp qua nhiều ca trong 1 tiến trình như lay_lich_su_xn_cdha.py).
function readCurrentHchanhCase(runDir) {
  if (!runDir) return null;
  // Nếu 1 lần chạy trước bị crash/kill đúng lúc đang xử lý 1 ca, entry đó
  // giữ nguyên status='running' vĩnh viễn trên đĩa (không ai ghi đè nữa nếu
  // ca đó không sớm được thử lại). Nếu chỉ lấy entry 'running' ĐẦU TIÊN gặp
  // trong object, mấy entry treo kiểu này sẽ che mất ca đang chạy THẬT — vì
  // vậy phải so started_at, chọn đúng entry 'running' MỚI NHẤT (worker luôn
  // set lại started_at=now mỗi lần đánh dấu 1 ca là running, kể cả lần thử
  // lại), để tự động bỏ qua các entry treo cũ.
  let best = null;
  let bestModuleLabel = '';
  let bestTs = -Infinity;
  for (const [file, moduleLabel] of HCHANH_CURRENT_CASE_SOURCES) {
    const progress = readJsonSafe(path.join(runDir, file), {}) || {};
    for (const item of Object.values(progress)) {
      if (!item || typeof item !== 'object' || item.status !== 'running') continue;
      const ts = Date.parse(item.started_at || '') || 0;
      if (ts >= bestTs) {
        bestTs = ts;
        best = item;
        bestModuleLabel = moduleLabel;
      }
    }
  }
  if (!best) return null;
  const files = Array.isArray(best.files) ? best.files.join(', ') : '';
  return {
    case_id: clipTraceText(best.encounter_id || best.ma_bn || '', 220),
    ma_bn: clipTraceText(best.ma_bn || '', 80),
    ho_ten: clipTraceText(best.ho_ten || '', 160),
    research_code: clipTraceText(best.research_code || '', 120),
    index: 0,
    total: 0,
    started_at: clipTraceText(best.started_at || '', 40),
    events_count: 0,
    last_step: { tag: 'RUNNING', step: `Đang lấy ${bestModuleLabel}`, takes: files },
  };
}

function readResearchCaseTrace(runDir, limit = CASE_TRACE_RECENT_LIMIT) {
  const max = Math.max(1, Math.min(50, Number(limit || CASE_TRACE_RECENT_LIMIT)));
  const recent = readCaseTraceRecent(runDir);
  if (recent.length) return recent.slice(-max).reverse();
  const p = path.join(runDir || '', CASE_TRACE_JSONL);
  if (!p || !fs.existsSync(p)) return [];
  try {
    return fs.readFileSync(p, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .slice(-max)
      .map(line => { try { return JSON.parse(line); } catch (_) { return null; } })
      .filter(Boolean)
      .reverse();
  } catch (_) {
    return [];
  }
}

function maskTraceIdentifier(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (s.length <= 4) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}${'*'.repeat(Math.min(6, Math.max(4, s.length - 4)))}`;
}

function redactTraceText(value) {
  let text = String(value || '');
  if (!text) return text;
  text = text.replace(/(usid=)[^&\s]+/gi, '$1[REDACTED]');
  text = text.replace(/(keyword=)\d{5,}/gi, '$1[MA_BN]');
  text = text.replace(/(ma_bn=)\d{5,}/gi, '$1[MA_BN]');
  text = text.replace(/(Mã BN=)\d{5,}/gi, '$1[MA_BN]');
  text = text.replace(/(Họ tên=)[^;|]+/gi, '$1[REDACTED]');
  text = text.replace(/(input_|output_)(\d{4})_\d{5,}_/g, '$1$2_[MA_BN]_');
  text = text.replace(/[A-Z]:\\[^|]+?(.runtime[/\\]research|hchanh_auto_raw|order_history_auto_raw)/gi, '[LOCAL_PATH]\\$1');
  return clipTraceText(text, 900);
}

function redactCaseTracePayload(cases = []) {
  return (Array.isArray(cases) ? cases : []).map(c => ({
    ...c,
    ma_bn: maskTraceIdentifier(c?.ma_bn),
    ho_ten: c?.ho_ten ? '[REDACTED]' : '',
    events: Array.isArray(c?.events) ? c.events.map(ev => ({
      ...ev,
      step: redactTraceText(ev?.step),
      screen: redactTraceText(ev?.screen),
      sees: redactTraceText(ev?.sees),
      takes: redactTraceText(ev?.takes),
      writes: redactTraceText(ev?.writes),
      target: redactTraceText(ev?.target),
    })) : [],
  }));
}

module.exports = {
  appendResearchRunLog,
  CASE_TRACE_JSONL,
  CASE_TRACE_RECENT_JSON,
  CASE_TRACE_RECENT_LIMIT,
  clipTraceText,
  normalizeCaseTraceEvent,
  readCaseTraceRecent,
  writeCaseTraceRecent,
  appendResearchCaseTrace,
  CASE_TRACE_CURRENT_JSON,
  readCurrentCaseTrace,
  HCHANH_CURRENT_CASE_SOURCES,
  readCurrentHchanhCase,
  readResearchCaseTrace,
  maskTraceIdentifier,
  redactTraceText,
  redactCaseTracePayload,
};
