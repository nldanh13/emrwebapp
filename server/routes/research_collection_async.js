'use strict';

// Trả lời ngay cho tác vụ thu thập dài để trình duyệt/proxy không phải giữ một HTTP
// request hàng chục phút. Route này được mount trước research.js và do đó chặn hai
// endpoint collect-auto cũ; collection-status/progress vẫn dùng route hiện có.
// Nếu body.patientCode có giá trị, chỉ lấy lại dữ liệu của đúng Mã BN đó.

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
const { normalizeRunOutputs } = require('../research/normalize');
const {
  refreshPolicyFor,
  runCollectionOrchestration,
  runXnCdhaSubsetForCollection,
  syncCollectionLedger,
} = require('../research/collection_runtime');
const { beginResearchTask, updateResearchTask, finishResearchTask } = require('../research/progress_snapshot');
const { RESEARCH_SCOPE_LOCKS, researchScopeKey } = require('../research/research_http');

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

function maxAttemptsFrom(body, study) {
  const fromBody = Number(body?.maxAttempts);
  if (Number.isInteger(fromBody) && fromBody >= 1 && fromBody <= 10) return fromBody;
  const fromStudy = Number(study?.data_requirements?.max_attempts);
  if (Number.isInteger(fromStudy) && fromStudy >= 1 && fromStudy <= 10) return fromStudy;
  return collection.DEFAULT_MAX_ATTEMPTS;
}

function directPatientCodeFrom(req) {
  const code = String(req.body?.patientCode || '').trim();
  if (!code) return '';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(code)) {
    const err = new Error('Mã BN không hợp lệ. Chỉ dùng chữ, số, dấu chấm, gạch ngang hoặc gạch dưới.');
    err.status = 400;
    throw err;
  }
  return code;
}

async function runDirectPatient(ctx, sc, rows, requestedParts, headless) {
  const wanted = requestedParts.length ? requestedParts : collection.PART_KEYS;
  const hchanhFiles = wanted.filter(p => ['profile', 'discharge', 'surgery', 'order_history'].includes(p));
  const xnCdhaParts = wanted.filter(p => ['xn', 'cdha'].includes(p));
  const results = {};

  if (isCancelRequested(ctx.sid)) return { cancelled: true, results };

  if (hchanhFiles.length) {
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

  results.normalized = normalizeRunOutputs(sc.runDir, { sourceRunId: sc.runId });
  syncCollectionLedger(sc.runDir, sc.sourceRows);
  return { cancelled: false, results };
}

async function handleCollectAccepted(req, res, studyIdParam = '') {
  const ctx = getRuntimePaths(req);
  let lockKey = '';
  let lockToken = null;

  try {
    const sc = scopeFromRequest(req, studyIdParam);
    if (sc.error) return res.status(sc.status || 400).json({ status: 'error', message: sc.error });
    if (!sc.sourceRows.length) {
      return res.status(400).json({ status: 'error', message: 'Chưa có danh sách lượt điều trị (research_source.csv). Hãy quét danh sách hoặc nạp cohort trước.' });
    }

    const directPatientCode = directPatientCodeFrom(req);
    const directRows = directPatientCode
      ? sc.sourceRows.filter(r => String(patientCode(r) || '').trim() === directPatientCode)
      : [];
    if (directPatientCode && !directRows.length) {
      return res.status(404).json({
        status: 'error',
        message: 'Không tìm thấy Mã BN này trong danh sách đã quét. Hãy quét lại danh sách hoặc kiểm tra Mã BN.',
      });
    }

    lockKey = researchScopeKey(req);
    const holder = RESEARCH_SCOPE_LOCKS.get(lockKey);
    if (holder) {
      return res.status(409).json({
        status: 'error',
        code: 'RESEARCH_SCOPE_BUSY',
        message: `Kho này đang chạy "${holder.label}" (từ ${holder.since}). Chờ tác vụ đó xong hoặc bấm Dừng rồi thử lại.`,
        busy: { label: holder.label, since: holder.since },
      });
    }

    const label = directPatientCode ? 'Thu thập trực tiếp 1 người bệnh' : 'Thu thập tự động';
    // Lưu sid của session sở hữu job vào lock nội bộ. Không trả sid ra API /research/running.
    // Nhờ vậy nút Dừng vẫn huỷ đúng worker kể cả người dùng reload/mở tab khác.
    lockToken = { label, since: nowIso(), sid: ctx.sid };
    RESEARCH_SCOPE_LOCKS.set(lockKey, lockToken);

    const body = { ...(req.body || {}) };
    const requestedParts = Array.isArray(body.parts)
      ? body.parts.filter(p => collection.PART_KEYS.includes(p))
      : [];
    const headless = researchHeadlessFromBody(body);
    const maxAttempts = maxAttemptsFrom(body, sc.study);
    const force = body.force === true;
    const refreshProvisional = body.refreshProvisional === true;
    const retryBlocked = body.retryBlocked === true;
    const limit = Number.isFinite(Number(body.limit)) ? Math.max(0, Math.trunc(Number(body.limit))) : 0;
    const refreshParts = Array.isArray(body.refreshParts) ? body.refreshParts.filter(p => collection.PART_KEYS.includes(p)) : [];
    const refreshKeys = Array.isArray(body.refreshKeys) && body.refreshKeys.length ? body.refreshKeys.map(String).slice(0, 20000) : null;

    const task = beginResearchTask(sc.runDir, {
      type: directPatientCode ? 'collect_patient' : 'collect_auto',
      label,
      status: 'queued',
      scope: sc.scope,
      run_id: sc.runId,
      message: directPatientCode
        ? 'Đã nhận yêu cầu lấy trực tiếp một người bệnh.'
        : 'Đã nhận yêu cầu thu thập tự động (chỉ lấy phần thiếu/lỗi/đã thay đổi).',
    });

    if (sc.isArchive) {
      updateArchive({ active_run_id: sc.runId, active_mode: directPatientCode ? 'collect_patient' : 'collect_auto' });
    }

    // Quan trọng: trả lời HTTP ngay. Trước đây response chỉ được gửi sau khi toàn bộ worker
    // chạy xong nên trình duyệt/proxy thường ngắt request và hiện "Failed to fetch" dù
    // backend vẫn đang chạy bình thường.
    res.status(202).json({
      status: 'accepted',
      message: directPatientCode
        ? 'Đã nhận yêu cầu lấy Mã BN này. Tác vụ đang chạy ở backend; có thể chuyển tab và xem tiến độ.'
        : 'Đã nhận yêu cầu thu thập. Tác vụ đang chạy ở backend; có thể chuyển tab và xem tiến độ.',
      run_id: sc.runId,
      task_id: task.id,
      direct_patient: Boolean(directPatientCode),
    });

    const queued = enqueueHeavy(ctx.sid, async () => {
      if (isCancelRequested(ctx.sid)) {
        finishResearchTask(sc.runDir, task.id, 'cancelled', { message: 'Đã dừng trước khi worker bắt đầu.' });
        return { cancelled: true };
      }

      updateResearchTask(sc.runDir, task.id, {
        status: 'running',
        message: directPatientCode
          ? 'Đang lấy trực tiếp dữ liệu người bệnh từ EMR.'
          : 'Đang thu thập tự động. Có thể chuyển tab, tiến độ vẫn được lưu ở backend.',
      });

      try {
        let result;
        if (directPatientCode) {
          result = await runDirectPatient(ctx, sc, directRows, requestedParts, headless);
        } else {
          const options = {
            runDir: sc.runDir,
            runId: sc.runId,
            scope: sc.scope,
            isArchive: sc.isArchive,
            sourceRows: sc.sourceRows,
            fromDate: sc.fromDate,
            toDate: sc.toDate,
            headless,
            maxAttempts,
            force,
            refreshProvisional,
            retryBlocked,
            parts: requestedParts.length ? requestedParts : collection.PART_KEYS,
            limit,
            refreshParts,
            refreshKeys,
            refreshPolicy: refreshPolicyFor(sc.isArchive, sc.study),
            study: sc.study,
          };
          result = await runCollectionOrchestration(ctx, options);
        }

        const cancelled = directPatientCode ? Boolean(result?.cancelled) : Boolean(result?.report?.cancelled);
        const metaPatch = {
          last_run_id: sc.runId,
          last_run_at: nowIso(),
          last_normalized_at: nowIso(),
          last_collect_at: nowIso(),
        };
        if (sc.isArchive) updateArchive({ ...metaPatch, active_run_id: '', active_mode: '', ...(cancelled ? { stopped_at: nowIso() } : {}) });
        else updateStudy(sc.scope, metaPatch);

        const report = result?.report || null;
        const message = directPatientCode
          ? (cancelled ? 'Đã dừng lấy trực tiếp người bệnh. Phần đã lấy được vẫn được giữ.' : 'Đã lấy trực tiếp người bệnh và chuẩn hóa lại dữ liệu.')
          : `${report?.cancelled ? 'Đã dừng' : 'Xong'}: lấy ${report?.fetched_encounters || 0} lượt, bỏ qua ${report?.skipped_unchanged || 0} lượt không đổi, lỗi còn tồn ${report?.selenium_errors_open || 0} phần.`;
        finishResearchTask(sc.runDir, task.id, cancelled ? 'cancelled' : (report?.errors?.length ? 'error' : 'done'), { message });
        return result;
      } catch (err) {
        const cancelled = isCancelRequested(ctx.sid);
        if (sc.isArchive) updateArchive({ active_run_id: '', active_mode: '', stopped_at: nowIso() });
        finishResearchTask(sc.runDir, task.id, cancelled ? 'cancelled' : 'error', {
          message: cancelled ? 'Đã dừng theo yêu cầu.' : String(err?.message || err),
        });
        if (cancelled) return { cancelled: true };
        throw err;
      }
    }, {
      taskType: directPatientCode ? 'research_collect_patient' : 'research_collect_auto',
      metadata: { scope_key: lockKey, run_id: sc.runId },
    });
    lockToken.queue_task_id = queued.taskId || '';

    void queued.catch(err => {
      console.error('[research collect background]', err);
    }).finally(() => {
      if (RESEARCH_SCOPE_LOCKS.get(lockKey) === lockToken) RESEARCH_SCOPE_LOCKS.delete(lockKey);
    });

    return undefined;
  } catch (err) {
    if (lockKey && lockToken && RESEARCH_SCOPE_LOCKS.get(lockKey) === lockToken) {
      RESEARCH_SCOPE_LOCKS.delete(lockKey);
    }
    console.error(err);
    if (!res.headersSent) return res.status(err.status || 500).json({ status: 'error', message: String(err.message || err) });
    return undefined;
  }
}

router.post('/research/archive/collect-auto', (req, res) => handleCollectAccepted(req, res));
router.post('/research/studies/:studyId/collect-auto', (req, res) => handleCollectAccepted(req, res, req.params.studyId));

module.exports = router;
