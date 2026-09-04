// server/routes/details.js — /api/run-details, /api/run-postprocess, /api/has-processed, /api/cancel

'use strict';

const router = require('express').Router();
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { getRuntimePaths, ensureSessionAssets } = require('../services/session');
const { runWorker, fmtPyError }                = require('../services/python_runner');
const { enqueueHeavy, registerCancel, unregisterCancel, cancelSession } = require('../services/task_queue');
const { isValidDmy, normalizeDmy, dmyToIso }       = require('../utils/validation');
const { readJsonSafe, safeFilePart, writeJsonAtomic } = require('../utils/file');
const { ROOT_DIR }                             = require('../constants');
const { appendActivity }                       = require('../services/activity_logger');
const { refreshRuntimeV2 }                      = require('../services/runtime_v2');
const { postprocessOrders }                      = require('../services/order_pipeline');
const { getFeature }                             = require('../services/feature_registry');

function normalizePatientIdForOne(v) { return String(v || '').trim(); }
function dmyToDateForOne(s) {
  const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return Number.isNaN(d.getTime()) ? null : d;
}
function isDateInRangeForOne(dmy, from, to) {
  const d = dmyToDateForOne(dmy), a = dmyToDateForOne(from || dmy), b = dmyToDateForOne(to || from || dmy);
  if (!d || !a || !b) return true;
  return d >= a && d <= b;
}
function getRowPatientId(row) { return normalizePatientIdForOne(row?.ma_bn || row?.['Mã BN'] || row?.['Mã YT'] || row?.ma_yt || row?.MaBN || row?.Ma_BN || row?.mabn || row?.id); }

function normalizeDmyForKey(value) {
  return normalizeDmy(value) || String(value || '').trim();
}

function normalizeDateIsoForKey(value) {
  return dmyToIso(value) || String(value || '').trim();
}

function orderDayKey(row) {
  const pid = getRowPatientId(row);
  const day = normalizeDateIsoForKey(row?.ngay_lam || row?.['Ngày làm'] || row?.ngay || row?.date || '');
  return pid && day ? `${pid}::${day}` : '';
}

function stableHash(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value || {})).digest('hex').slice(0, 16);
}

function orderTextHash(row) {
  return stableHash({
    y_lenh: String(row?.['Y lệnh'] || row?.y_lenh || '').trim(),
    dien_bien: String(row?.['Diễn biến'] || row?.dien_bien || '').trim(),
  });
}

function sourceSegmentFromRow(row, idx = 0) {
  const sourceDate = normalizeDmyForKey(row?.source_date || row?.bridge_source_date || row?.ngay_lam || row?.['Ngày làm'] || '');
  const workDate = normalizeDmyForKey(row?.ngay_lam || row?.['Ngày làm'] || row?.ngay || row?.date || '');
  return {
    source_date: sourceDate,
    source_date_iso: normalizeDateIsoForKey(sourceDate),
    source_type: sourceDate && workDate && sourceDate !== workDate ? 'bridge_00_07' : 'main_day',
    has_content: !isEmptyOrderRow(row),
    text_hash: orderTextHash(row),
    source_index: idx,
  };
}

function isEmptyOrderRow(row) {
  return !String(row?.['Y lệnh'] || row?.y_lenh || '').trim() && !String(row?.['Diễn biến'] || row?.dien_bien || '').trim();
}

function mergeTextBlock(a, b) {
  const left = String(a || '').trim();
  const right = String(b || '').trim();
  if (!right) return left;
  if (!left) return right;
  if (left.includes(right)) return left;
  if (right.includes(left)) return right;
  const seen = new Set();
  const out = [];
  for (const line of `${left}\n${right}`.split('\n')) {
    const sig = line.trim();
    if (sig && seen.has(sig)) continue;
    if (sig) seen.add(sig);
    out.push(line.trimEnd());
  }
  return out.join('\n').trim();
}

function mergeOrderRowsNoDuplicate(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const order = [];
  const byKey = new Map();
  list.forEach((row, idx) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return;
    const key = orderDayKey(row) || `fallback::${idx}`;
    const current = byKey.get(key);
    if (!current) {
      const copy = { ...row };
      if (!Array.isArray(copy.source_segments)) copy.source_segments = [];
      if (!copy.source_segments.length) {
        copy.source_segments.push(sourceSegmentFromRow(copy, idx));
      } else {
        copy.source_segments = copy.source_segments.map((seg, segIdx) => ({
          ...seg,
          source_date: normalizeDmyForKey(seg.source_date || seg.bridge_source_date || copy.source_date || copy.bridge_source_date || copy.ngay_lam || ''),
          source_date_iso: normalizeDateIsoForKey(seg.source_date || seg.bridge_source_date || copy.source_date || copy.bridge_source_date || copy.ngay_lam || ''),
          text_hash: seg.text_hash || orderTextHash(copy),
          source_index: Number.isFinite(Number(seg.source_index)) ? Number(seg.source_index) : segIdx,
        }));
      }
      byKey.set(key, copy);
      order.push(key);
      return;
    }
    const incomingSegments = Array.isArray(row.source_segments) && row.source_segments.length
      ? row.source_segments.map((seg, segIdx) => ({
          ...seg,
          source_date: normalizeDmyForKey(seg.source_date || seg.bridge_source_date || row.source_date || row.bridge_source_date || row.ngay_lam || ''),
          source_date_iso: normalizeDateIsoForKey(seg.source_date || seg.bridge_source_date || row.source_date || row.bridge_source_date || row.ngay_lam || ''),
          text_hash: seg.text_hash || orderTextHash(row),
          source_index: Number.isFinite(Number(seg.source_index)) ? Number(seg.source_index) : segIdx,
        }))
      : [sourceSegmentFromRow(row, idx)];
    const sigs = new Set((current.source_segments || []).map(x => `${normalizeDateIsoForKey(x.source_date || x.source_date_iso)}|${x.source_type}|${x.text_hash || ''}`));
    for (const seg of incomingSegments) {
      const sig = `${normalizeDateIsoForKey(seg.source_date || seg.source_date_iso)}|${seg.source_type}|${seg.text_hash || ''}`;
      if (!sigs.has(sig)) {
        current.source_segments.push(seg);
        sigs.add(sig);
      }
    }
    if (!isEmptyOrderRow(row)) {
      current['Y lệnh'] = mergeTextBlock(current['Y lệnh'] || current.y_lenh, row['Y lệnh'] || row.y_lenh);
      current['Diễn biến'] = mergeTextBlock(current['Diễn biến'] || current.dien_bien, row['Diễn biến'] || row.dien_bien);
      for (const [k, v] of Object.entries(row)) {
        if (['Y lệnh', 'Diễn biến', 'y_lenh', 'dien_bien', 'source_segments'].includes(k)) continue;
        if (current[k] === undefined || current[k] === null || current[k] === '') current[k] = v;
      }
    }
  });
  return order.map(k => byKey.get(k));
}

function currentScanIdSet(rawRows) {
  const rows = Array.isArray(rawRows) ? rawRows : [];
  const ids = new Set();
  for (const row of rows) {
    const id = getRowPatientId(row);
    if (id) ids.add(id);
  }
  return ids;
}

function filterRowsToCurrentScan(rows, rawRows) {
  const list = Array.isArray(rows) ? rows : [];
  const rawIds = currentScanIdSet(rawRows);
  // Nếu chưa có raw scan hoặc raw không đọc được mã BN, không tự xoá để tránh mất dữ liệu do lỗi scan.
  if (!rawIds.size) return list;
  return list.filter(row => {
    const id = getRowPatientId(row);
    return id && rawIds.has(id);
  });
}

function mergeRecordsForPatients(oldRecords, newRecords, patientIds, dateFrom, dateTo) {
  const ids = patientIds instanceof Set ? patientIds : new Set(Array.isArray(patientIds) ? patientIds : []);
  const oldList = Array.isArray(oldRecords) ? oldRecords : [];
  const newList = Array.isArray(newRecords) ? newRecords : [];
  if (!ids.size) return mergeOrderRowsNoDuplicate([...oldList, ...newList]);
  const filtered = oldList.filter(r => {
    const id = getRowPatientId(r);
    if (!id || !ids.has(id)) return true;
    const d = r?.ngay_lam || r?.ngay_y_lenh || r?.ngay || r?.date || '';
    return !isDateInRangeForOne(d, dateFrom, dateTo);
  });
  return mergeOrderRowsNoDuplicate([...filtered, ...newList]);
}

function mergeRecordsForOnePatient(oldRecords, newRecords, patientId, dateFrom, dateTo) {
  const pid = normalizePatientIdForOne(patientId);
  return mergeRecordsForPatients(oldRecords, newRecords, new Set([pid].filter(Boolean)), dateFrom, dateTo);
}

// POST /api/run-details — Lấy Y lệnh từng BN từ EMR
router.post('/run-details', async (req, res) => {
  const ctx        = getRuntimePaths(req);
  const requestedRows = Array.isArray(req.body) ? req.body : [];
  const rawData = readJsonSafe(ctx.RAW_PATH, []);
  const sortedData = filterRowsToCurrentScan(requestedRows, rawData);
  const removedByScan = requestedRows.length - sortedData.length;
  console.log(`>>> [${ctx.sid}] Nhận ${requestedRows.length} BN để lấy chi tiết.` + (removedByScan > 0 ? ` Đã bỏ ${removedByScan} BN không còn trong danh sách scan mới.` : ''));

  const { date_from: dateFrom = '', date_to: dateTo = '', rooms = '', partial = '', scope = '' } = req.query;
  const partialMode = partial === '1' || partial === 'true';

  if (dateFrom && !isValidDmy(dateFrom)) return res.status(400).json({ status: 'error', message: 'date_from không đúng định dạng dd/mm/yyyy' });
  if (dateTo   && !isValidDmy(dateTo))   return res.status(400).json({ status: 'error', message: 'date_to không đúng định dạng dd/mm/yyyy' });
  if (requestedRows.length > 0 && sortedData.length === 0 && currentScanIdSet(rawData).size > 0) {
    return res.status(400).json({ status: 'error', message: 'Không còn BN nào trong danh sách scan mới để lấy y lệnh. Hãy quét lại hoặc kiểm tra danh sách phòng.' });
  }

  try {
    ensureSessionAssets(ctx.dir, ROOT_DIR);
    await enqueueHeavy(ctx.sid, async () => {
      const safeScope = String(scope || (partialMode ? 'partial' : 'all')).replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'details';
      const detailsInputPath = partialMode ? path.join(ctx.dir, `details_input_${safeScope}.json`) : ctx.SORTED_PATH;
      const detailsOutPath = partialMode ? path.join(ctx.dir, `KetQua_YLenh_${safeScope}.json`) : ctx.FINAL_PATH;

      writeJsonAtomic(detailsInputPath, sortedData);
      if (!partialMode) writeJsonAtomic(ctx.SORTED_PATH, sortedData);

      const args = ['--input', detailsInputPath, '--out', detailsOutPath];
      if (dateFrom) args.push('--from', dateFrom);
      if (dateTo)   args.push('--to', dateTo);
      if (rooms)    args.push('--rooms', rooms.replace(/[\r\n\t]/g, ' ').slice(0, 500));

      let result;
      try {
        result = await runWorker('details', args, {
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
          runtimeDir: ctx.dir,
        });
      } finally {
        unregisterCancel(ctx.sid);
      }

      if (result.spawnError)      return res.status(500).json({ status: 'error', message: `Không khởi động được Python: ${result.spawnError}` });
      if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: 'Timeout khi lấy chi tiết' });

      if (result.code === 0) {
        const newRecords = readJsonSafe(detailsOutPath, []);
        if (!Array.isArray(newRecords) || newRecords.length === 0) {
          return res.status(500).json({
            status: 'error',
            message: 'Không lấy được y lệnh nào. Kiểm tra log server và thư mục .runtime/sessions/<session>/logs.',
          });
        }
        const nonEmptyNew = newRecords.filter(r => String(r?.['Y lệnh'] || '').trim() || String(r?.['Diễn biến'] || '').trim()).length;
        if (nonEmptyNew === 0) {
          return res.status(500).json({
            status: 'error',
            message: 'Có tạo file nhưng toàn bộ Y lệnh/Diễn biến rỗng. Kiểm tra log server và ảnh debug trong thư mục logs.',
          });
        }

        let finalRecords = mergeOrderRowsNoDuplicate(newRecords);
        if (!partialMode) {
          writeJsonAtomic(ctx.FINAL_PATH, finalRecords);
        }
        if (partialMode) {
          const selectedIds = new Set(sortedData.map(getRowPatientId).filter(Boolean));
          const oldRecords = readJsonSafe(ctx.FINAL_PATH, []);
          finalRecords = mergeRecordsForPatients(oldRecords, newRecords, selectedIds, dateFrom, dateTo);
          writeJsonAtomic(ctx.FINAL_PATH, finalRecords);
        }

        const finalNonEmpty = finalRecords.filter(r => String(r?.['Y lệnh'] || '').trim() || String(r?.['Diễn biến'] || '').trim()).length;
        const v2Sync = await refreshRuntimeV2(ctx, partialMode ? 'details_partial' : 'details_all');
        appendActivity(ctx, {
          kind: 'workflow.details.success',
          scope: partialMode ? 'partial' : 'all',
          fetched_count: newRecords.length,
          total_count: finalRecords.length,
          non_empty_count: finalNonEmpty,
          v2: v2Sync?.indexes || null,
        });
        const msgPrefix = partialMode ? 'Thành công! Đã cập nhật phạm vi đã chọn' : 'Thành công! Đã lấy';
        return res.json({
          status: 'ok',
          message: `${msgPrefix} ${newRecords.length} dòng, ${nonEmptyNew} dòng có nội dung. Tổng hiện có ${finalRecords.length} dòng.`,
          count: finalRecords.length,
          fetched_count: newRecords.length,
          non_empty_count: finalNonEmpty,
          v2: v2Sync?.indexes || null,
        });
      }

      return res.status(500).json({ status: 'error', message: fmtPyError('Python lỗi khi lấy y lệnh.', result) });
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

// POST /api/run-details-one — Chỉ lấy lại y lệnh cho 1 người bệnh, rồi merge vào dữ liệu hiện có
router.post('/run-details-one', async (req, res) => {
  const ctx = getRuntimePaths(req);
  const body = req.body || {};
  const patientId = normalizePatientIdForOne(body.patientId || body.ma_bn || body.id);
  const dateFrom = String(body.dateFrom || body.date_from || body.ngay_lam || '').trim();
  const dateTo = String(body.dateTo || body.date_to || dateFrom || '').trim();
  if (!patientId) return res.status(400).json({ status: 'error', message: 'Thiếu mã bệnh nhân để lấy y lệnh 1 người.' });
  if (dateFrom && !isValidDmy(dateFrom)) return res.status(400).json({ status: 'error', message: 'dateFrom không đúng định dạng dd/mm/yyyy' });
  if (dateTo && !isValidDmy(dateTo)) return res.status(400).json({ status: 'error', message: 'dateTo không đúng định dạng dd/mm/yyyy' });
  try {
    ensureSessionAssets(ctx.dir, ROOT_DIR);
    await enqueueHeavy(ctx.sid, async () => {
      const sources = [readJsonSafe(ctx.SORTED_PATH, []), readJsonSafe(ctx.RAW_PATH, []), readJsonSafe(ctx.PROCESSED_PATH, [])];
      let row = null;
      for (const src of sources) {
        if (!Array.isArray(src)) continue;
        row = src.find(r => getRowPatientId(r) === patientId);
        if (row) break;
      }
      const bodyAdmissionTime = body.thoi_gian_vao_khoa || body.tg_vao || body.thoi_gian_vao || '';
      const bodyDepartmentName = body.ten_khoa_dieu_tri || body.khoa_dieu_tri || body.khoa_chuyen_den || '';
      if (!row) row = {
        ma_bn: patientId, 'Mã BN': patientId,
        ho_ten: body.ho_ten || body.name || '', 'Họ tên': body.ho_ten || body.name || '',
        Vi_Tri: body.so_phong || body.room || '',
      };
      if (bodyAdmissionTime && !row.thoi_gian_vao_khoa && !row.tg_vao) {
        row.thoi_gian_vao_khoa = bodyAdmissionTime;
        row.tg_vao = bodyAdmissionTime;
        row['T/G vào'] = bodyAdmissionTime;
      }
      if (bodyDepartmentName && !row.ten_khoa_dieu_tri && !row.khoa_dieu_tri && !row.khoa_chuyen_den) {
        row.ten_khoa_dieu_tri = bodyDepartmentName;
        row.khoa_dieu_tri = bodyDepartmentName;
        row.khoa_chuyen_den = bodyDepartmentName;
        row['Khoa chuyển đến'] = bodyDepartmentName;
      }
      const patientFilePart = safeFilePart(patientId) || 'unknown';
      const oneInputPath = path.join(ctx.dir, 'details_one_' + patientFilePart + '.json');
      const oneOutPath = path.join(ctx.dir, 'KetQua_YLenh_one_' + patientFilePart + '.json');
      writeJsonAtomic(oneInputPath, [row]);
      const args = ['--input', oneInputPath, '--out', oneOutPath];
      if (dateFrom) args.push('--from', dateFrom);
      if (dateTo) args.push('--to', dateTo);
      let result;
      try { result = await runWorker('details', args, { onSpawn: killFn => registerCancel(ctx.sid, killFn), runtimeDir: ctx.dir }); }
      finally { unregisterCancel(ctx.sid); }
      if (result.spawnError)      return res.status(500).json({ status: 'error', message: 'Không khởi động được Python: ' + result.spawnError });
      if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: 'Timeout khi lấy y lệnh 1 người' });
      if (result.code !== 0)      return res.status(500).json({ status: 'error', message: fmtPyError('Python lỗi khi lấy y lệnh 1 người.', result) });
      const newRecords = readJsonSafe(oneOutPath, []);
      if (!Array.isArray(newRecords) || newRecords.length === 0) return res.status(500).json({ status: 'error', message: 'Không lấy được y lệnh cho người bệnh này.' });
      const oldRecords = readJsonSafe(ctx.FINAL_PATH, []);
      writeJsonAtomic(ctx.FINAL_PATH, mergeRecordsForOnePatient(oldRecords, newRecords, patientId, dateFrom, dateTo));
      const classifyFeature = getFeature('orders.classify');
      const requestedPostprocess = ![false, 0, '0', 'false', 'no'].includes(
        body.postprocess ?? body.autoPostprocess ?? req.query.postprocess ?? true,
      );
      let postprocess = { status: 'skipped', reason: requestedPostprocess ? 'feature-disabled' : 'requested-fetch-only' };
      let responseStatus = 200;

      if (requestedPostprocess && classifyFeature?.enabled !== false) {
        try {
          postprocess = await postprocessOrders(ctx, { reason: 'details_one_postprocess' });
        } catch (err) {
          // Dữ liệu y lệnh đã lấy vẫn có giá trị. Không biến lỗi phân loại thành mất kết quả bước lấy dữ liệu.
          responseStatus = 207;
          postprocess = {
            status: 'failed',
            code: String(err.code || 'ORDER_POSTPROCESS_FAILED'),
            message: String(err.message || err).slice(0, 1000),
          };
          await refreshRuntimeV2(ctx, 'details_one_fetch_partial');
        }
      } else {
        await refreshRuntimeV2(ctx, requestedPostprocess ? 'details_one_classify_disabled' : 'details_one_fetch_only');
      }

      appendActivity(ctx, {
        kind: 'workflow.details_one.success',
        count: newRecords.length,
        postprocess_status: postprocess.status,
        postprocess_reason: postprocess.reason || '',
      });
      const status = postprocess.status === 'failed' ? 'partial' : 'ok';
      const suffix = postprocess.status === 'succeeded'
        ? ' Đã phân loại lại dữ liệu.'
        : (postprocess.status === 'failed' ? ' Đã giữ dữ liệu lấy được nhưng bước phân loại lỗi.' : ' Bước phân loại đã được bỏ qua.');
      return res.status(responseStatus).json({
        status,
        message: 'Đã cập nhật y lệnh cho 1 người bệnh (' + patientId + '), ' + newRecords.length + ' dòng.' + suffix,
        count: newRecords.length,
        postprocess,
      });
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

// GET /api/run-postprocess — Phân loại thuốc / dịch truyền từ KetQua_YLenh
router.get('/run-postprocess', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    ensureSessionAssets(ctx.dir, ROOT_DIR);
    await enqueueHeavy(ctx.sid, async () => {
      try {
        const result = await postprocessOrders(ctx, { reason: 'postprocess' });
        appendActivity(ctx, { kind: 'workflow.postprocess.success', v2_ok: result.v2_ok });
        return res.json({ status: 'ok', message: 'Thành công!', v2: result.v2 });
      } catch (err) {
        return res.status(Number(err.status) || 500).json({
          status: 'error',
          code: err.code || 'ORDER_POSTPROCESS_FAILED',
          message: String(err.message || err),
        });
      }
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

// GET /api/has-processed — Kiểm tra file DuLieu_PhanLoai.json có tồn tại không
router.get('/has-processed', (req, res) => {
  const ctx = getRuntimePaths(req);
  return res.json({ exists: fs.existsSync(ctx.PROCESSED_PATH) });
});

// POST /api/cancel — Huỷ tác vụ Python đang chạy
router.post('/cancel', (req, res) => {
  const ctx      = getRuntimePaths(req);
  const cancelled = cancelSession(ctx.sid);
  return res.json({
    status:  'ok',
    message: cancelled ? 'Đã gửi lệnh huỷ.' : 'Không có tác vụ đang chạy.',
  });
});

module.exports = router;
