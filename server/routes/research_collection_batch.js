'use strict';

// Nhận danh sách Mã BN và lấy tuần tự từng người bệnh trong cùng một background task.
// Route này chỉ xử lý request có body.patientCodes; request 1 mã/collect-auto thông thường
// được chuyển tiếp cho research_collection_async.js hiện hữu.

const router = require('express').Router();
const path = require('path');

const collection = require('../research/collection');
const { getRuntimePaths } = require('../services/session');
const { enqueueHeavy, isCancelRequested } = require('../services/task_queue');
const { patientCode } = require('../research/table_io');
const { firstNonEmpty } = require('../research/encounter_context');
const {
  ARCHIVE_ID,
  archiveRunsDir,
  archiveSourcePath,
  cohortPath,
  nowIso,
  runsDir,
  todayDateInput,
} = require('../research/store_paths');
const {
  readArchive,
  readStudy,
  resolveArchiveRunIdForAction,
  resolveRunId,
  updateArchive,
  updateStudy,
} = require('../research/run_registry');
const { readResearchHchanhSourceRows } = require('../research/research_source');
const { researchHeadlessFromBody, fetchHchanhForResearchRun } = require('../research/hchanh_fetch');
const { runXnCdhaSubsetForCollection, scheduleNormalizeAfterCollection, syncCollectionLedger } = require('../research/collection_runtime');
const { appendResearchRunLog } = require('../research/case_trace');
const { beginResearchTask, updateResearchTask, finishResearchTask } = require('../research/progress_snapshot');
const { RESEARCH_SCOPE_LOCKS, researchScopeKey } = require('../research/research_http');

const MAX_BATCH_PATIENTS = 200;
const PATIENT_CODE_RE = /^[A-Za-z0-9._-]{1,64}$/;

function scopeFromRequest(req, studyIdParam = '') {
  if (!studyIdParam) {
    const archive = readArchive();
    const runId = resolveArchiveRunIdForAction(req.body?.runId || req.query?.runId || 'latest');
    if (!runId) return { error: 'Kho gốc chưa có run. Chạy Bước 1 — Quét danh sách trước.' };
    const runDir = path.join(archiveRunsDir(), runId);
    const fromDate = String(req.body?.fromDate || archive.scan_from_date || '').trim();
    const toDate = String(req.body?.toDate || archive.scan_to_date || todayDateInput()).trim();
    const src = readResearchHchanhSourceRows(runDir, archiveSourcePath(), {
      sourceRunId: runId,
      dateDefaults: { from_date: fromDate, to_date: toDate },
    });
    return {
      isArchive: true,
      scope: ARCHIVE_ID,
      runId,
      runDir,
      fromDate: src.date_context?.from_date || fromDate,
      toDate: src.date_context?.to_date || toDate,
      sourceRows: src.rows || [],
      study: null,
    };
  }

  const study = readStudy(studyIdParam);
  if (!study) return { error: 'Không tìm thấy nghiên cứu.', status: 404 };
  const runId = resolveRunId(study.id, 'latest');
  if (!runId) return { error: 'Nghiên cứu chưa có run.' };
  const runDir = path.join(runsDir(study.id), runId);
  const fromDate = String(req.body?.fromDate || '').trim();
  const toDate = String(req.body?.toDate || todayDateInput()).trim();
  const src = readResearchHchanhSourceRows(runDir, cohortPath(study.id), { sourceRunId: runId });
  return {
    isArchive: false,
    scope: study.id,
    runId,
    runDir,
    fromDate: src.date_context?.from_date || fromDate,
    toDate: src.date_context?.to_date || toDate,
    sourceRows: src.rows || [],
    study,
  };
}

function patientCodesFrom(req) {
  const raw = req.body?.patientCodes;
  if (raw === undefined || raw === null) return null;
  const values = Array.isArray(raw) ? raw : String(raw).split(/[\s,;]+/);
  const seen = new Set();
  const codes = [];
  for (const value of values) {
    const code = String(value || '').trim();
    if (!code || seen.has(code)) continue;
    if (!PATIENT_CODE_RE.test(code)) {
      const err = new Error('Danh sách có Mã BN không hợp lệ. Chỉ dùng chữ, số, dấu chấm, gạch ngang hoặc gạch dưới.');
      err.status = 400;
      throw err;
    }
    seen.add(code);
    codes.push(code);
    if (codes.length > MAX_BATCH_PATIENTS) {
      const err = new Error(`Mỗi lần chỉ lấy tối đa ${MAX_BATCH_PATIENTS} Mã BN.`);
      err.status = 400;
      throw err;
    }
  }
  if (!codes.length) {
    const err = new Error('Chưa có Mã BN để lấy dữ liệu.');
    err.status = 400;
    throw err;
  }
  return codes;
}

// Lỗi của một ca: các bước lấy dữ liệu không ném lỗi mà trả kết quả có lỗi (Python dừng giữa chừng,
// phần hành chánh lỗi...), nên phải đọc kết quả mới biết ca có lỗi hay không.
function caseErrorsFromResults(results = {}) {
  const errors = [];
  const hchanhErrors = Number(results.hchanh?.error || 0);
  if (results.hchanh?.spawnError || results.hchanh?.fatal) errors.push(`Hồ sơ/y lệnh: ${results.hchanh.spawnError || results.hchanh.fatal}`);
  else if (hchanhErrors > 0) errors.push(`Hồ sơ/y lệnh: ${hchanhErrors} phần lỗi`);
  if (results.xn_cdha?.error) errors.push(`XN/CĐHA: ${String(results.xn_cdha.error).split('\n')[0].slice(0, 200)}`);
  return errors;
}

async function runDirectPatientNoFinalize(ctx, sc, rows, requestedParts, headless, onStep = () => {}) {
  const wanted = requestedParts.length ? requestedParts : collection.PART_KEYS;
  const hchanhFiles = wanted.filter(p => ['profile', 'discharge', 'surgery', 'order_history'].includes(p));
  const xnCdhaParts = wanted.filter(p => ['xn', 'cdha'].includes(p));
  const results = {};

  if (isCancelRequested(ctx.sid)) return { cancelled: true, results };

  if (hchanhFiles.length) {
    onStep('đang lấy hồ sơ nền, ra viện, phẫu thuật, y lệnh');
    const forceKeys = new Set(rows.map(r => String(firstNonEmpty(r, ['Research key', 'research_key', 'source_key']) || '').trim()).filter(Boolean));
    results.hchanh = await fetchHchanhForResearchRun(ctx, sc.runDir, {
      sourceRows: rows,
      sourceRunId: sc.runId,
      files: hchanhFiles,
      headless,
      force: true,
      forceKeys,
      fallbackDateFrom: sc.fromDate,
      fallbackDateTo: sc.toDate,
      mode: 'hchanh_auto',
      refreshProvisional: true,
    });
  }

  if (isCancelRequested(ctx.sid) || results.hchanh?.cancelled) return { cancelled: true, results };

  if (xnCdhaParts.length) {
    onStep('đang lấy XN và CĐHA');
    const subset = rows.map(r => ({ ...r, refetch_parts: xnCdhaParts.join(';') }));
    results.xn_cdha = await runXnCdhaSubsetForCollection(ctx, {
      runDir: sc.runDir,
      runId: sc.runId,
      scope: sc.scope,
      isArchive: sc.isArchive,
      rows: subset,
      fromDate: sc.fromDate,
      toDate: sc.toDate,
      headless,
    });
  }

  if (isCancelRequested(ctx.sid) || results.xn_cdha?.stopped) return { cancelled: true, results };
  return { cancelled: false, results };
}

async function handleBatch(req, res, studyIdParam = '') {
  const ctx = getRuntimePaths(req);
  let lockKey = '';
  let lockToken = null;

  try {
    const patientCodes = patientCodesFrom(req);
    if (patientCodes === null) return false;

    const sc = scopeFromRequest(req, studyIdParam);
    if (sc.error) {
      res.status(sc.status || 400).json({ status: 'error', message: sc.error });
      return true;
    }
    if (!sc.sourceRows.length) {
      res.status(400).json({ status: 'error', message: 'Chưa có danh sách lượt điều trị (research_source.csv). Hãy quét danh sách trước.' });
      return true;
    }

    const rowsByCode = new Map();
    for (const row of sc.sourceRows) {
      const code = String(patientCode(row) || '').trim();
      if (!code) continue;
      if (!rowsByCode.has(code)) rowsByCode.set(code, []);
      rowsByCode.get(code).push(row);
    }

    const cases = [];
    let missingCount = 0;
    for (const code of patientCodes) {
      const rows = rowsByCode.get(code) || [];
      if (!rows.length) {
        missingCount += 1;
        continue;
      }
      cases.push({ code, rows });
    }
    if (!cases.length) {
      res.status(404).json({
        status: 'error',
        message: 'Không Mã BN nào trong danh sách có trong danh sách đã quét. Hãy quét danh sách hoặc kiểm tra lại Mã BN.',
      });
      return true;
    }

    lockKey = researchScopeKey(req);
    const holder = RESEARCH_SCOPE_LOCKS.get(lockKey);
    if (holder) {
      res.status(409).json({
        status: 'error',
        code: 'RESEARCH_SCOPE_BUSY',
        message: `Kho này đang chạy "${holder.label}" (từ ${holder.since}). Chờ tác vụ đó xong hoặc bấm Dừng rồi thử lại.`,
        busy: { label: holder.label, since: holder.since },
      });
      return true;
    }

    const label = `Thu thập trực tiếp ${cases.length} người bệnh`;
    lockToken = { label, since: nowIso(), sid: ctx.sid };
    RESEARCH_SCOPE_LOCKS.set(lockKey, lockToken);

    const body = { ...(req.body || {}) };
    const requestedParts = Array.isArray(body.parts)
      ? body.parts.filter(p => collection.PART_KEYS.includes(p))
      : [];
    const headless = researchHeadlessFromBody(body);

    const task = beginResearchTask(sc.runDir, {
      type: 'collect_patient_batch',
      label,
      status: 'queued',
      scope: sc.scope,
      run_id: sc.runId,
      message: `Đã nhận ${cases.length}/${patientCodes.length} Mã BN; sẽ lấy tuần tự từng ca.`,
    });

    if (sc.isArchive) updateArchive({ active_run_id: sc.runId, active_mode: 'collect_patient_batch' });

    res.status(202).json({
      status: 'accepted',
      message: `Đã nhận ${cases.length} Mã BN. Hệ thống sẽ lấy tuần tự từng ca ở backend.`,
      run_id: sc.runId,
      task_id: task.id,
      direct_patient_batch: true,
      requested_count: patientCodes.length,
      accepted_count: cases.length,
      missing_count: missingCount,
    });

    const queued = enqueueHeavy(ctx.sid, async () => {
      let completed = 0;
      let failed = 0;
      let cancelled = false;
      const progress = (index, step) => updateResearchTask(sc.runDir, task.id, {
        status: 'running',
        message: `Ca ${index + 1}/${cases.length}: ${step}. Đã xong ${completed}; lỗi ${failed}.`,
        current: index + 1,
        total: cases.length,
        completed,
        failed,
      });

      try {
        for (let index = 0; index < cases.length; index += 1) {
          if (isCancelRequested(ctx.sid)) {
            cancelled = true;
            break;
          }

          progress(index, 'bắt đầu');

          try {
            const one = await runDirectPatientNoFinalize(ctx, sc, cases[index].rows, requestedParts, headless, step => progress(index, step));
            if (one?.cancelled || isCancelRequested(ctx.sid)) {
              cancelled = true;
              break;
            }
            // Bước lấy dữ liệu báo lỗi qua kết quả (không ném lỗi): ca có lỗi thì tính là lỗi.
            const caseErrors = caseErrorsFromResults(one?.results);
            if (caseErrors.length) {
              failed += 1;
              appendResearchRunLog(sc.runDir, `[${new Date().toLocaleString('vi-VN')}] Lấy trực tiếp ca ${index + 1}/${cases.length} (Mã BN ${cases[index].code}) có lỗi: ${caseErrors.join(' | ')}`);
            } else {
              completed += 1;
            }
          } catch (err) {
            if (isCancelRequested(ctx.sid)) {
              cancelled = true;
              break;
            }
            failed += 1;
            console.error('[research direct patient batch] one case failed:', String(err?.message || err));
          }
        }

        // Chuẩn hóa một lần sau cả lô (kể cả khi dừng giữa chừng), xếp hàng chạy nền ở tiến trình
        // riêng: không chặn máy chủ và không giữ khóa Thu thập.
        if (completed > 0 || failed > 0) {
          syncCollectionLedger(sc.runDir, sc.sourceRows);
          scheduleNormalizeAfterCollection({
            runDir: sc.runDir, runId: sc.runId, isArchive: sc.isArchive, study: sc.study, sourceRows: sc.sourceRows,
            reason: `Sau khi lấy trực tiếp ${cases.length} người bệnh`,
            onDone: () => (sc.isArchive ? updateArchive({ last_normalized_at: nowIso() }) : updateStudy(sc.scope, { last_normalized_at: nowIso() })),
          });
        }

        const metaPatch = {
          last_run_id: sc.runId,
          last_run_at: nowIso(),
          last_collect_at: nowIso(),
        };
        if (sc.isArchive) updateArchive({ ...metaPatch, active_run_id: '', active_mode: '', ...(cancelled ? { stopped_at: nowIso() } : {}) });
        else updateStudy(sc.scope, metaPatch);

        const message = cancelled
          ? `Đã dừng: hoàn tất ${completed}/${cases.length} ca, lỗi ${failed}. Phần đã lấy được vẫn được giữ.`
          : `Xong: hoàn tất ${completed}/${cases.length} ca, lỗi ${failed}${missingCount ? `, ${missingCount} mã không có trong danh sách đã quét` : ''}${failed ? ' (chi tiết lỗi từng ca trong Xem log chạy)' : ''}. Chuẩn hóa đang chạy nền.`;
        const finalStatus = cancelled ? 'cancelled' : (completed === 0 && failed > 0 ? 'error' : 'done');
        finishResearchTask(sc.runDir, task.id, finalStatus, {
          message,
          current: Math.min(completed + failed, cases.length),
          total: cases.length,
          completed,
          failed,
          missing: missingCount,
        });
        return { cancelled, completed, failed, missing: missingCount };
      } catch (err) {
        cancelled = isCancelRequested(ctx.sid);
        if (sc.isArchive) updateArchive({ active_run_id: '', active_mode: '', ...(cancelled ? { stopped_at: nowIso() } : {}) });
        finishResearchTask(sc.runDir, task.id, cancelled ? 'cancelled' : 'error', {
          message: cancelled ? 'Đã dừng theo yêu cầu.' : String(err?.message || err),
        });
        if (cancelled) return { cancelled: true, completed, failed };
        throw err;
      }
    }, {
      taskType: 'research_collect_patient_batch',
      metadata: { scope_key: lockKey, run_id: sc.runId, patient_count: cases.length },
    });
    lockToken.queue_task_id = queued.taskId || '';

    void queued.catch(err => {
      console.error('[research direct patient batch]', err);
    }).finally(() => {
      if (RESEARCH_SCOPE_LOCKS.get(lockKey) === lockToken) RESEARCH_SCOPE_LOCKS.delete(lockKey);
    });

    return true;
  } catch (err) {
    if (lockKey && lockToken && RESEARCH_SCOPE_LOCKS.get(lockKey) === lockToken) {
      RESEARCH_SCOPE_LOCKS.delete(lockKey);
    }
    console.error(err);
    if (!res.headersSent) res.status(err.status || 500).json({ status: 'error', message: String(err.message || err) });
    return true;
  }
}

router.post('/research/archive/collect-auto', async (req, res, next) => {
  if (req.body?.patientCodes === undefined) return next();
  await handleBatch(req, res);
});

router.post('/research/studies/:studyId/collect-auto', async (req, res, next) => {
  if (req.body?.patientCodes === undefined) return next();
  await handleBatch(req, res, req.params.studyId);
});

module.exports = router;
module.exports._test = { caseErrorsFromResults };
