// server/routes/lab_results.js — Kết quả xét nghiệm trong ngày (chỉ đọc EMR)
//
// GET  /api/lab-results?date=dd/mm/yyyy        → kết quả đã lưu của ngày (không mở EMR)
// POST /api/lab-results/fetch                  → đọc EMR cho những người bệnh còn thiếu
//      body: { date, patients: [{ ma_bn, ho_ten, so_phong, thoi_gian_vao_khoa }], force_ids: [] }

'use strict';

const router = require('express').Router();
const path = require('path');

const { getRuntimePaths, ensureSessionAssets } = require('../services/session');
const { runWorker, fmtPyError } = require('../services/python_runner');
const { enqueueHeavy, registerCancel, unregisterCancel } = require('../services/task_queue');
const { readJsonSafe, writeJsonAtomic } = require('../utils/file');
const { isValidDmy } = require('../utils/validation');
const { ROOT_DIR } = require('../constants');
const { appendActivity } = require('../services/activity_logger');
const store = require('../services/lab_results_store');

const MAX_PATIENTS_PER_RUN = 80;
const running = new Map(); // sid → { at, by }

function patientIdOf(row) {
  return String(row?.ma_bn || row?.['Mã BN'] || row?.['Mã YT'] || row?.ma_yt || row?.id || '').trim();
}

// Dòng danh sách nội trú đã quét (có T/G vào) để worker kiểm đúng đợt điều trị trước khi mở hồ sơ.
function sourceRowFor(ctx, id, fallback = {}) {
  for (const file of [ctx.SORTED_PATH, ctx.RAW_PATH, ctx.PROCESSED_PATH]) {
    const rows = readJsonSafe(file, []);
    if (!Array.isArray(rows)) continue;
    const row = rows.find(r => patientIdOf(r) === id);
    if (row) return row;
  }
  const name = String(fallback.ho_ten || fallback.name || '').trim();
  const admit = String(fallback.thoi_gian_vao_khoa || fallback.tg_vao || '').trim();
  return {
    ma_bn: id, 'Mã BN': id, ho_ten: name, 'Họ tên': name,
    Vi_Tri: String(fallback.so_phong || fallback.room || ''),
    ...(admit ? { thoi_gian_vao_khoa: admit, tg_vao: admit, 'T/G vào': admit } : {}),
  };
}

function dayPayload(ctx, day) {
  const data = store.readStore(ctx);
  return { status: 'ok', date: day, items: data.days[day] || {} };
}

router.get('/lab-results', (req, res) => {
  const day = store.dmyKey(req.query.date);
  if (!day || !isValidDmy(day)) return res.status(400).json({ status: 'error', message: 'Ngày xem kết quả xét nghiệm phải có dạng dd/mm/yyyy.' });
  const ctx = getRuntimePaths(req);
  return res.json({ ...dayPayload(ctx, day), running: running.has(ctx.sid) });
});

router.post('/lab-results/fetch', async (req, res) => {
  const ctx = getRuntimePaths(req);
  const body = req.body || {};
  const day = store.dmyKey(body.date);
  if (!day || !isValidDmy(day)) return res.status(400).json({ status: 'error', message: 'Ngày lấy kết quả xét nghiệm phải có dạng dd/mm/yyyy.' });
  const requested = (Array.isArray(body.patients) ? body.patients : [])
    .map(p => ({ id: patientIdOf(p), raw: p || {} }))
    .filter(p => p.id);
  const uniq = [...new Map(requested.map(p => [p.id, p])).values()];
  if (!uniq.length) return res.status(400).json({ status: 'error', message: 'Chưa chọn người bệnh nào để lấy kết quả xét nghiệm.' });
  if (uniq.length > MAX_PATIENTS_PER_RUN) {
    return res.status(400).json({ status: 'error', message: `Mỗi lần lấy tối đa ${MAX_PATIENTS_PER_RUN} người bệnh. Chọn bớt phòng rồi bấm lại.` });
  }

  const forceIds = Array.isArray(body.force_ids) ? body.force_ids.map(String) : [];
  const ids = store.patientsToFetch(store.readStore(ctx), day, uniq.map(p => p.id), { forceIds });
  const skipped = uniq.length - ids.length;
  if (!ids.length) {
    return res.json({
      ...dayPayload(ctx, day),
      fetched: 0,
      skipped,
      message: 'Kết quả xét nghiệm đã có đủ, không cần mở EMR. Bấm "Lấy lại" ở từng người bệnh nếu muốn đọc lại.',
    });
  }

  const already = running.get(ctx.sid);
  if (already) {
    return res.status(409).json({ status: 'error', code: 'LAB_ALREADY_RUNNING', message: `Đang có lượt lấy kết quả xét nghiệm${already.by ? ` do ${already.by} bấm` : ''}. Chờ lượt đó xong rồi bấm lại.` });
  }
  running.set(ctx.sid, { at: Date.now(), by: String(req.auth?.name || '') });

  try {
    ensureSessionAssets(ctx.dir, ROOT_DIR);
    await enqueueHeavy(ctx.sid, async () => {
      const rows = ids.map(id => sourceRowFor(ctx, id, uniq.find(p => p.id === id)?.raw));
      const stamp = `${Date.now()}`;
      const inputPath = path.join(ctx.dir, `lab_day_input_${stamp}.json`);
      const outPath = path.join(ctx.dir, `lab_day_out_${stamp}.json`);
      writeJsonAtomic(inputPath, rows);
      let result;
      try {
        result = await runWorker('lab-day', ['--input', inputPath, '--out', outPath, '--day', day], {
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
          runtimeDir: ctx.dir,
        });
      } finally {
        unregisterCancel(ctx.sid);
      }
      // Worker ghi sau từng người bệnh: dừng giữa chừng hay lỗi vẫn giữ phần đã đọc.
      const out = readJsonSafe(outPath, null);
      const results = out && out.ngay === day && out.results && typeof out.results === 'object' ? out.results : {};
      const fetched = Object.keys(results).length;
      if (fetched) writeStore(ctx, day, results);

      const errors = Object.entries(results).filter(([, r]) => r?.status === 'error');
      const withLab = Object.values(results).filter(r => r?.status === 'ok').length;
      appendActivity(ctx, { kind: 'lab_results.fetch', date: day, requested: ids.length, fetched, with_lab: withLab, errors: errors.length });

      if (!fetched) {
        if (result.spawnError) return res.status(500).json({ status: 'error', message: `Không khởi động được Python: ${result.spawnError}` });
        if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: 'Quá thời gian chờ khi đọc kết quả xét nghiệm. Bấm lại để lấy tiếp.' });
        return res.status(500).json({ status: 'error', message: fmtPyError('Chưa đọc được kết quả xét nghiệm nào.', result) });
      }
      const notDone = ids.length - fetched;
      const warning = [
        errors.length ? `${errors.length} người bệnh chưa đọc được kết quả XN (xem lý do ở tab Kết quả XN của từng người).` : '',
        notDone > 0 ? `Còn ${notDone} người bệnh chưa đọc tới do lượt đọc dừng giữa chừng. Bấm lại để lấy tiếp.` : '',
      ].filter(Boolean).join(' ');
      return res.json({
        ...dayPayload(ctx, day),
        fetched,
        skipped,
        message: `Đã đọc kết quả xét nghiệm ${fetched} người bệnh: ${withLab} người có xét nghiệm ngày ${day}.${skipped ? ` ${skipped} người đã có đủ kết quả nên không mở lại EMR.` : ''}`,
        warning,
      });
    });
  } catch (err) {
    console.error('[LAB] Lỗi lấy kết quả xét nghiệm:', String(err?.message || err));
    if (!res.headersSent) res.status(500).json({ status: 'error', message: 'Không lấy được kết quả xét nghiệm. Thử lại sau ít phút.' });
  } finally {
    running.delete(ctx.sid);
  }
});

function writeStore(ctx, day, results) {
  store.writeStore(ctx, store.mergeResults(store.readStore(ctx), day, results));
}

module.exports = router;
