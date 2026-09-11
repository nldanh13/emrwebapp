// server/routes/board.js — /api/data, /api/save (xếp phòng giường)

'use strict';

const router = require('express').Router();
const fs     = require('fs');
const path   = require('path');

const {
  getRuntimePaths,
  getSessionId,
  buildRuntimePathsForSid,
  listKnownSessionIds,
  deleteSessionData,
} = require('../services/session');
const { readJsonSafe, writeJsonAtomic } = require('../utils/file');
const { parseDmy, sanitizeSessionId } = require('../utils/validation');
const { appendActivity } = require('../services/activity_logger');
const { refreshRuntimeV2 } = require('../services/runtime_v2');
const { canAccessSession } = require('../services/authz');
const { postprocessOrders } = require('../services/order_pipeline');

const DANGEROUS_ROW_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function hasDangerousRowKey(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return false;
  if (Array.isArray(value)) return value.some(item => hasDangerousRowKey(item, depth + 1));
  for (const [key, child] of Object.entries(value)) {
    if (DANGEROUS_ROW_KEYS.has(key)) return true;
    if (hasDangerousRowKey(child, depth + 1)) return true;
  }
  return false;
}

// GET /api/data — Lấy danh sách BN đã xếp phòng
router.get('/data', (req, res) => {
  const ctx  = getRuntimePaths(req);
  const data = readJsonSafe(ctx.SORTED_PATH, []);
  return res.json(Array.isArray(data) ? data : []);
});

// POST /api/save — Lưu thứ tự xếp phòng
router.post('/save', async (req, res) => {
  const ctx     = getRuntimePaths(req);
  const payload = Array.isArray(req.body) ? req.body : [];
  if (payload.length > 500) {
    return res.status(400).json({ status: 'error', message: 'Danh sách quá lớn (tối đa 500 bệnh nhân).' });
  }

  // Kiểm tra từng phần tử: phải là object có trường ma_bn hoặc Mã BN
  for (let i = 0; i < payload.length; i++) {
    const row = payload[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return res.status(400).json({ status: 'error', message: `Dòng ${i}: không phải object hợp lệ.` });
    }
    if (hasDangerousRowKey(row)) {
      return res.status(400).json({ status: 'error', message: `Dòng ${i}: chứa khóa JSON nguy hiểm.` });
    }
    const id = String(row['Mã BN'] ?? row['ma_bn'] ?? row['Mã YT'] ?? row['ma_yt'] ?? '').trim();
    if (!id) {
      return res.status(400).json({ status: 'error', message: `Dòng ${i}: thiếu mã bệnh nhân (ma_bn).` });
    }
  }

  try {
    writeJsonAtomic(ctx.SORTED_PATH, payload);
    const v2Sync = await refreshRuntimeV2(ctx, 'board_save');
    appendActivity(ctx, { kind: 'workflow.board.save', count: payload.length, v2_ok: Boolean(v2Sync?.ok) });
    return res.json({ status: 'ok', v2: v2Sync?.indexes || null });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: 'error', message: 'Không ghi được file xếp phòng.' });
  }
});

function rowPatientIdForRoom(row) {
  return String(
    row?.ma_bn || row?.['Mã BN'] || row?.['Mã YT'] || row?.ma_yt || row?.MaBN || row?.Ma_BN || row?.mabn || row?.id || ''
  ).trim();
}

function roomFromRowForFix(row) {
  return String(
    row?.so_phong || row?.room || row?.Vi_Tri || row?.phong_giuong ||
    row?.['Phòng'] || row?.['Vị trí'] || row?.vi_tri || ''
  ).trim();
}

// Phòng "đúng" hiện tại = phòng đã xếp gần nhất trên board (SORTED_PATH).
// Dữ liệu y lệnh (FINAL_PATH) lưu phòng tại thời điểm "Lấy chi tiết" — nếu
// lúc đó xếp nhầm phòng, sửa lại trên board sau đó không tự động lan sang
// các dòng y lệnh đã lấy trước đó (để giữ đúng lịch sử khi BN chuyển phòng
// thật). Hai endpoint dưới đây cho cách sửa tay khi biết chắc là gõ nhầm.
function buildCurrentRoomIndexForFix(ctx) {
  const out = new Map();
  const sortedRows = readJsonSafe(ctx.SORTED_PATH, []);
  for (const row of (Array.isArray(sortedRows) ? sortedRows : [])) {
    const id = rowPatientIdForRoom(row);
    const room = roomFromRowForFix(row);
    if (id && room) out.set(id, room);
  }
  return out;
}

function findRoomMismatches(ctx) {
  const roomById = buildCurrentRoomIndexForFix(ctx);
  if (!roomById.size) return [];
  const finalRows = readJsonSafe(ctx.FINAL_PATH, []);
  const byPatient = new Map();
  for (const row of (Array.isArray(finalRows) ? finalRows : [])) {
    const id = rowPatientIdForRoom(row);
    const correctRoom = id ? roomById.get(id) : '';
    if (!id || !correctRoom) continue;
    const dataRoom = roomFromRowForFix(row);
    if (!dataRoom || dataRoom === correctRoom) continue;
    if (!byPatient.has(id)) {
      byPatient.set(id, {
        ma_bn: id,
        ho_ten: String(row?.ho_ten || row?.['Họ tên'] || '').trim(),
        current_room: correctRoom,
        data_rooms: new Set(),
        affected_days: 0,
      });
    }
    const entry = byPatient.get(id);
    entry.data_rooms.add(dataRoom);
    entry.affected_days += 1;
  }
  return [...byPatient.values()].map(entry => ({
    ma_bn: entry.ma_bn,
    ho_ten: entry.ho_ten,
    current_room: entry.current_room,
    data_rooms: [...entry.data_rooms],
    affected_days: entry.affected_days,
  }));
}

// GET /api/room-mismatches — Phát hiện BN đang có dữ liệu y lệnh lưu phòng
// khác với phòng hiện tại trên board (thường do lỡ xếp nhầm phòng rồi sửa lại).
router.get('/room-mismatches', (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    return res.json({ mismatches: findRoomMismatches(ctx) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: 'error', message: 'Không kiểm tra được phòng lệch: ' + err.message });
  }
});

// POST /api/fix-rooms — Ghi đè phòng trong dữ liệu y lệnh đã lấy (FINAL_PATH)
// theo đúng phòng hiện tại trên board, cho các mã BN chỉ định (hoặc tất cả
// BN đang lệch nếu không truyền patientIds). Sau đó chạy lại phân loại để
// đồng bộ xuống dữ liệu đã xử lý — không cần lấy lại y lệnh từ EMR.
router.post('/fix-rooms', async (req, res) => {
  const ctx = getRuntimePaths(req);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const requestedIds = Array.isArray(body.patientIds)
    ? new Set(body.patientIds.map(x => String(x || '').trim()).filter(Boolean))
    : null;

  try {
    const roomById = buildCurrentRoomIndexForFix(ctx);
    if (!roomById.size) {
      return res.json({ status: 'ok', fixed_count: 0, fixed_patient_ids: [], message: 'Chưa có phòng nào trên board để đối chiếu.' });
    }

    const finalRows = readJsonSafe(ctx.FINAL_PATH, []);
    let fixedCount = 0;
    const fixedIds = new Set();
    const nextRows = (Array.isArray(finalRows) ? finalRows : []).map(row => {
      const id = rowPatientIdForRoom(row);
      if (!id) return row;
      if (requestedIds && !requestedIds.has(id)) return row;
      const correctRoom = roomById.get(id);
      if (!correctRoom) return row;
      const dataRoom = roomFromRowForFix(row);
      if (!dataRoom || dataRoom === correctRoom) return row;
      fixedCount += 1;
      fixedIds.add(id);
      return {
        ...row,
        so_phong: correctRoom,
        room: correctRoom,
        Vi_Tri: correctRoom,
        vi_tri: correctRoom,
        phong_giuong: correctRoom,
        'Phòng': correctRoom,
        'Vị trí': correctRoom,
      };
    });

    if (!fixedCount) {
      return res.json({ status: 'ok', fixed_count: 0, fixed_patient_ids: [], message: 'Không có dòng nào lệch phòng để sửa.' });
    }

    writeJsonAtomic(ctx.FINAL_PATH, nextRows);
    await postprocessOrders(ctx, { reason: 'room_fix' });
    appendActivity(ctx, { kind: 'workflow.board.fix_rooms', fixed_count: fixedCount, patient_ids: [...fixedIds] });

    return res.json({
      status: 'ok',
      fixed_count: fixedCount,
      fixed_patient_ids: [...fixedIds],
      message: `Đã đồng bộ lại phòng cho ${fixedIds.size} bệnh nhân (${fixedCount} dòng y lệnh).`,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ status: 'error', message: 'Không sửa được phòng: ' + err.message });
  }
});

// GET /api/data-info — Metadata cho màn hình lựa chọn "dùng data cũ / lấy mới"
router.get('/data-info', (req, res) => {
  const ctx = getRuntimePaths(req);

  function fileInfo(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      const stat = fs.statSync(filePath);
      return { exists: true, modified: stat.mtimeMs, size_kb: Math.round(stat.size / 1024) };
    } catch (_) { return null; }
  }

  function recordCount(filePath) {
    try {
      const data = readJsonSafe(filePath, null);
      if (Array.isArray(data)) return data.length;
      if (data && typeof data === 'object') return Object.keys(data).length;
      return 0;
    } catch (_) { return 0; }
  }

  const rawInfo       = fileInfo(ctx.RAW_PATH);
  const sortedInfo    = fileInfo(ctx.SORTED_PATH);
  const finalInfo     = fileInfo(ctx.FINAL_PATH);
  const processedInfo = fileInfo(ctx.PROCESSED_PATH);
  const patientsInfo  = fileInfo(ctx.PATIENTS_PATH);
  const boardInfo     = fileInfo(ctx.BOARD_STATE_PATH);
  const orderDaysInfo = fileInfo(ctx.ORDER_DAYS_PATH);
  const classDaysInfo = fileInfo(ctx.CLASSIFIED_DAYS_PATH);
  const indexes       = readJsonSafe(ctx.INDEXES_PATH, null);

  return res.json({
    raw:       rawInfo       ? { ...rawInfo,       count: recordCount(ctx.RAW_PATH)       } : null,
    sorted:    sortedInfo    ? { ...sortedInfo,    count: recordCount(ctx.SORTED_PATH)    } : null,
    final:     finalInfo     ? { ...finalInfo,     count: recordCount(ctx.FINAL_PATH)     } : null,
    processed: processedInfo ? { ...processedInfo, count: recordCount(ctx.PROCESSED_PATH) } : null,
    v2: {
      patients:        patientsInfo  ? { ...patientsInfo,  count: indexes?.patients_count ?? recordCount(ctx.PATIENTS_PATH) } : null,
      board_state:     boardInfo     ? { ...boardInfo,     count: indexes?.selected_count ?? recordCount(ctx.BOARD_STATE_PATH) } : null,
      order_days:      orderDaysInfo ? { ...orderDaysInfo, count: indexes?.order_days_count ?? recordCount(ctx.ORDER_DAYS_PATH) } : null,
      classified_days: classDaysInfo ? { ...classDaysInfo, count: indexes?.classified_days_count ?? recordCount(ctx.CLASSIFIED_DAYS_PATH) } : null,
      indexes: indexes || null,
    },
  });
});

function fileInfo(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    return { exists: true, modified: stat.mtimeMs, size_kb: Math.round(stat.size / 1024) };
  } catch (_) { return null; }
}

function recordCount(filePath) {
  try {
    const data = readJsonSafe(filePath, null);
    if (Array.isArray(data)) return data.length;
    if (data && typeof data === 'object') return Object.keys(data).length;
    return 0;
  } catch (_) { return 0; }
}

function uniqueDatesFromRows(rows) {
  if (!Array.isArray(rows)) return [];
  const values = new Set();
  const keys = ['ngay_lam', 'ngay_y_lenh', 'ngay', 'date', 'source_date'];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    for (const key of keys) {
      const value = String(row[key] || '').trim();
      if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value)) values.add(value);
    }
  }
  return [...values].sort((a, b) => parseDmy(b) - parseDmy(a));
}

function patientCountFromRows(rows) {
  if (!Array.isArray(rows)) return 0;
  const ids = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row.ma_bn || row.MaBN || row['Mã BN'] || row.ma_yt || row['Mã YT'] || '').trim();
    if (id) ids.add(id);
  }
  return ids.size || rows.length;
}

function sessionSummary(sid, currentSid) {
  const ctx = buildRuntimePathsForSid(sid);
  const rawInfo = fileInfo(ctx.RAW_PATH);
  const processedInfo = fileInfo(ctx.PROCESSED_PATH);
  const sortedInfo = fileInfo(ctx.SORTED_PATH);
  const finalInfo = fileInfo(ctx.FINAL_PATH);
  const infos = [rawInfo, processedInfo, sortedInfo, finalInfo].filter(Boolean);
  if (!infos.length) return null;

  const processedRows = readJsonSafe(ctx.PROCESSED_PATH, []);
  const rawRows = readJsonSafe(ctx.RAW_PATH, []);
  const sortedRows = readJsonSafe(ctx.SORTED_PATH, []);
  const rowsForDates = Array.isArray(processedRows) && processedRows.length
    ? processedRows
    : Array.isArray(rawRows) && rawRows.length
      ? rawRows
      : sortedRows;
  const dataDates = uniqueDatesFromRows(rowsForDates);
  const modified = Math.max(...infos.map(x => x.modified || 0));
  const primary = processedInfo ? 'processed' : rawInfo ? 'raw' : sortedInfo ? 'sorted' : 'final';
  const count = processedInfo
    ? patientCountFromRows(processedRows)
    : rawInfo
      ? patientCountFromRows(rawRows)
      : recordCount(ctx.SORTED_PATH);

  return {
    sid,
    is_current: sid === currentSid,
    label: sid === 'default' ? 'Dữ liệu mặc định' : 'Session ' + sid.slice(0, 8),
    primary,
    count,
    modified,
    data_dates: dataDates,
    date_latest: dataDates[0] || '',
    date_oldest: dataDates[dataDates.length - 1] || '',
    files: {
      raw: rawInfo ? { ...rawInfo, count: recordCount(ctx.RAW_PATH) } : null,
      sorted: sortedInfo ? { ...sortedInfo, count: recordCount(ctx.SORTED_PATH) } : null,
      final: finalInfo ? { ...finalInfo, count: recordCount(ctx.FINAL_PATH) } : null,
      processed: processedInfo ? { ...processedInfo, count: recordCount(ctx.PROCESSED_PATH) } : null,
    },
  };
}

// GET /api/data-sessions — Liệt kê tất cả dữ liệu cũ trong .runtime/sessions
router.get('/data-sessions', (req, res) => {
  const currentSid = getSessionId(req);
  const sessions = listKnownSessionIds()
    .filter(sid => canAccessSession(req.auth, sid))
    .map(sid => sessionSummary(sid, currentSid))
    .filter(Boolean)
    .sort((a, b) => {
      const da = a.date_latest ? parseDmy(a.date_latest) : 0;
      const db = b.date_latest ? parseDmy(b.date_latest) : 0;
      if (db !== da) return db - da;
      if ((b.modified || 0) !== (a.modified || 0)) return (b.modified || 0) - (a.modified || 0);
      return String(a.sid).localeCompare(String(b.sid));
    });
  return res.json({ sessions });
});

// DELETE /api/data-sessions/:sid — Xoá dữ liệu session cũ
router.delete('/data-sessions/:sid', (req, res) => {
  let sid;
  try { sid = sanitizeSessionId(req.params.sid || ''); }
  catch (_) { return res.status(400).json({ status: 'error', message: 'Session không hợp lệ.' }); }

  const summary = sessionSummary(sid, getSessionId(req));
  if (!summary) return res.status(404).json({ status: 'error', message: 'Không tìm thấy dữ liệu để xoá.' });

  try {
    if (!canAccessSession(req.auth, sid)) return res.status(403).json({ status: 'error', message: 'Không có quyền với session này.' });
    const permanent = String(req.query.permanent || '') === '1';
    const result = deleteSessionData(sid, { permanent, reason: `manual_by_${req.auth?.id || 'unknown'}` });
    appendActivity(getRuntimePaths(req), {
      kind: permanent ? 'workflow.session.delete_permanent' : 'workflow.session.archive',
      actor: req.auth,
      target_sid: sid,
      archive_path: result.archive_path || '',
    });
    return res.json({
      status: 'ok',
      sid,
      archived: Boolean(result.archived),
      deleted: Boolean(result.deleted),
      message: result.deleted ? 'Đã xoá vĩnh viễn dữ liệu.' : 'Đã chuyển dữ liệu vào kho lưu trữ an toàn.',
    });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: 'Không xoá được dữ liệu: ' + err.message });
  }
});

module.exports = router;
