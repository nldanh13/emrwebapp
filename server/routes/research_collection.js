'use strict';

// Route thu thập tự động của Kho nghiên cứu (kho gốc và từng nghiên cứu): chạy thu thập, trạng thái, ngoại lệ, duyệt lượt chưa ghép, đủ dùng, chính sách làm mới.

const router = require('express').Router();
const { scheduleNormalizeAfterCollection, collectionEncounterReviewPayload, collectionEncounterOverrideState, COLLECTION_ENCOUNTER_OVERRIDES_FILE, syncCollectionLedger, refreshPolicyFor, runCollectionOrchestration, redactCollectionRows, unitKeysForRun, unresolvedEncountersForRun, COLLECTION_REPORT_FILE, collectionStatusSummary, COLLECTION_EXCEPTIONS_FILE, COLLECTION_EXCEPTION_COLUMNS, studyReadinessForRun, COLLECTION_CHANGES_FILE } = require('../research/collection_runtime');
const { firstNonEmpty } = require('../research/encounter_context');
const { nowIso, archiveRunsDir, todayDateInput, archiveSourcePath, ARCHIVE_ID, runsDir, cohortPath } = require('../research/store_paths');
const { readCsvTable, patientCode, writeCsv } = require('../research/table_io');
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic, readJsonSafe } = require('../utils/file');
const { readArchive, resolveArchiveRunIdForAction, readStudy, resolveRunId, updateArchive, updateStudy } = require('../research/run_registry');
const { readResearchHchanhSourceRows } = require('../research/research_source');
const collection = require('../research/collection');
const { getRuntimePaths } = require('../services/session');
const { researchHeadlessFromBody } = require('../research/hchanh_fetch');
const { beginResearchTask, updateResearchTask, finishResearchTask } = require('../research/progress_snapshot');
const { enqueueHeavy } = require('../services/task_queue');
const { researchResponseShouldRedact, sendCsvFile, lockedResearchRoute } = require('../research/research_http');

function handleCollectionEncounterReviews(req, res, studyIdParam = '') {
  try {
    const sc = collectionScopeFromRequest(req, studyIdParam);
    if (sc.error) return res.status(sc.status || 400).json({ status: 'error', message: sc.error });
    if (req.method === 'GET') return res.json(collectionEncounterReviewPayload(sc));

    const sourceKey = String(req.body?.source_key || '').trim();
    const action = String(req.body?.action || '').trim();
    if (!sourceKey || sourceKey.length > 500) return res.status(400).json({ status: 'error', message: 'Research key không hợp lệ.' });
    const sourceRow = sc.sourceRows.find(r => String(firstNonEmpty(r, ['Research key', 'research_key', 'source_key']) || '').trim() === sourceKey);
    if (!sourceRow) return res.status(404).json({ status: 'error', message: 'Không còn tìm thấy dòng nguồn này.' });

    const state = collectionEncounterOverrideState(sc.runDir);
    if (action === 'clear') {
      delete state.decisions[sourceKey];
    } else if (action === 'unresolved') {
      state.decisions[sourceKey] = { status: 'unresolved', encounter_id: '', updated_at: nowIso() };
    } else if (action === 'link') {
      const encounterId = String(req.body?.encounter_id || '').trim();
      const encounterRows = readCsvTable(path.join(sc.runDir, 'encounters.csv'), Number.MAX_SAFE_INTEGER).rows || [];
      const target = encounterRows.find(r => String(r.encounter_id || '').trim() === encounterId && !encounterId.startsWith('enc_unresolved_'));
      if (!target) return res.status(404).json({ status: 'error', message: 'Lượt điều trị được chọn không còn tồn tại.' });
      if (String(patientCode(sourceRow) || '').trim() !== String(target.patient_code || '').trim()) {
        return res.status(400).json({ status: 'error', message: 'Không thể ghép hai Mã BN khác nhau.' });
      }
      state.decisions[sourceKey] = { status: 'linked', encounter_id: encounterId, updated_at: nowIso() };
    } else {
      return res.status(400).json({ status: 'error', message: 'Thao tác rà soát không hợp lệ.' });
    }
    state.updated_at = nowIso();
    writeJsonAtomic(path.join(sc.runDir, COLLECTION_ENCOUNTER_OVERRIDES_FILE), state);
    if (sc.sourceRows.length) syncCollectionLedger(sc.runDir, sc.sourceRows);
    return res.json(collectionEncounterReviewPayload(sc));
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
}

function collectionScopeFromRequest(req, studyIdParam = '') {
  if (!studyIdParam) {
    const archive = readArchive();
    const runId = resolveArchiveRunIdForAction(req.body?.runId || req.query?.runId || 'latest');
    if (!runId) return { error: 'Kho gốc chưa có run. Chạy Bước 1 — Quét danh sách trước.' };
    const runDir = path.join(archiveRunsDir(), runId);
    const fromDate = String(req.body?.fromDate || archive.scan_from_date || '').trim();
    const toDate = String(req.body?.toDate || archive.scan_to_date || todayDateInput()).trim();
    const src = readResearchHchanhSourceRows(runDir, archiveSourcePath(), { sourceRunId: runId, dateDefaults: { from_date: fromDate, to_date: toDate } });
    return { isArchive: true, scope: ARCHIVE_ID, runId, runDir, fromDate: src.date_context?.from_date || fromDate, toDate: src.date_context?.to_date || toDate, sourceRows: src.rows || [], study: null, refreshPolicy: refreshPolicyFor(true, null) };
  }
  const study = readStudy(studyIdParam);
  if (!study) return { error: 'Không tìm thấy nghiên cứu.', status: 404 };
  const runId = resolveRunId(study.id, 'latest');
  if (!runId) return { error: 'Nghiên cứu chưa có run.' };
  const runDir = path.join(runsDir(study.id), runId);
  const fromDate = String(req.body?.fromDate || '').trim();
  const toDate = String(req.body?.toDate || todayDateInput()).trim();
  const src = readResearchHchanhSourceRows(runDir, cohortPath(study.id), { sourceRunId: runId });
  return { isArchive: false, scope: study.id, runId, runDir, fromDate: src.date_context?.from_date || fromDate, toDate: src.date_context?.to_date || toDate, sourceRows: src.rows || [], study, refreshPolicy: refreshPolicyFor(false, study) };
}

function maxAttemptsFrom(req, study) {
  const fromBody = Number(req.body?.maxAttempts);
  if (Number.isInteger(fromBody) && fromBody >= 1 && fromBody <= 10) return fromBody;
  const fromStudy = Number(study?.data_requirements?.max_attempts);
  if (Number.isInteger(fromStudy) && fromStudy >= 1 && fromStudy <= 10) return fromStudy;
  return collection.DEFAULT_MAX_ATTEMPTS;
}

async function handleCollectAuto(req, res, studyIdParam = '') {
  const ctx = getRuntimePaths(req);
  try {
    const sc = collectionScopeFromRequest(req, studyIdParam);
    if (sc.error) return res.status(sc.status || 400).json({ status: 'error', message: sc.error });
    if (!sc.sourceRows.length) return res.status(400).json({ status: 'error', message: 'Chưa có danh sách lượt điều trị (research_source.csv). Hãy quét danh sách hoặc nạp cohort trước.' });
    const requestedParts = Array.isArray(req.body?.parts) ? req.body.parts.filter(p => collection.PART_KEYS.includes(p)) : [];
    const options = {
      runDir: sc.runDir, runId: sc.runId, scope: sc.scope, isArchive: sc.isArchive, sourceRows: sc.sourceRows,
      fromDate: sc.fromDate, toDate: sc.toDate, headless: researchHeadlessFromBody(req.body),
      maxAttempts: maxAttemptsFrom(req, sc.study),
      force: req.body?.force === true,
      refreshProvisional: req.body?.refreshProvisional === true,
      retryBlocked: req.body?.retryBlocked === true,
      parts: requestedParts.length ? requestedParts : collection.PART_KEYS,
      limit: Number.isFinite(Number(req.body?.limit)) ? Math.max(0, Math.trunc(Number(req.body.limit))) : 0,
      // "Làm mới": người dùng chọn kiểm tra lại các phần này (tùy chọn chỉ vài lượt).
      refreshParts: Array.isArray(req.body?.refreshParts) ? req.body.refreshParts.filter(p => collection.PART_KEYS.includes(p)) : [],
      refreshKeys: Array.isArray(req.body?.refreshKeys) && req.body.refreshKeys.length ? req.body.refreshKeys.map(String).slice(0, 20000) : null,
      refreshPolicy: sc.refreshPolicy,
      study: sc.study,
    };
    // Chạy lại: bỏ cảnh báo fatal của lần trước (lần này gặp lỗi thật thì worker ghi lại).
    try { const oldAlert = path.join(sc.runDir, 'fatal_alert.json'); if (fs.existsSync(oldAlert)) fs.unlinkSync(oldAlert); } catch (_) {}
    const task = beginResearchTask(sc.runDir, {
      type: 'collect_auto', label: 'Thu thập tự động', status: 'queued', scope: sc.scope, run_id: sc.runId,
      message: 'Đã nhận yêu cầu thu thập tự động (chỉ lấy phần thiếu/lỗi/đã thay đổi).',
    });
    if (sc.isArchive) updateArchive({ active_run_id: sc.runId, active_mode: 'collect_auto' });
    await enqueueHeavy(ctx.sid, async () => {
      updateResearchTask(sc.runDir, task.id, { status: 'running', message: 'Đang thu thập tự động.' });
      try {
        const { report, normalized } = await runCollectionOrchestration(ctx, options);
        const metaPatch = { last_run_id: sc.runId, last_run_at: nowIso(), last_collect_at: nowIso() };
        if (sc.isArchive) updateArchive({ ...metaPatch, active_run_id: '', active_mode: '' });
        else updateStudy(sc.scope, metaPatch);
        // Chuẩn hóa là quy trình riêng: xếp hàng chạy nền, không giữ khóa Thu thập.
        const gotData = Number(report.fetched_encounters || 0) + Number(report.parts_backfilled || 0) + Number(report.parts_changed || 0) > 0;
        if (gotData) {
          scheduleNormalizeAfterCollection({
            runDir: sc.runDir, runId: sc.runId, isArchive: sc.isArchive, study: sc.study, sourceRows: sc.sourceRows,
            reason: 'Sau thu thập tự động',
            onDone: () => (sc.isArchive ? updateArchive({ last_normalized_at: nowIso() }) : updateStudy(sc.scope, { last_normalized_at: nowIso() })),
          });
        }
        const message = `${report.cancelled ? 'Đã dừng' : 'Xong'}${gotData ? ' (chuẩn hóa đang chạy nền)' : ''}: lấy ${report.fetched_encounters} lượt, bỏ qua ${report.skipped_unchanged} lượt không đổi, lấy bù ${report.parts_backfilled} phần, kiểm tra lại ${report.parts_rechecked} phần (${report.parts_changed} phần có thay đổi), lỗi còn tồn ${report.selenium_errors_open} phần, không ghép chắc ${report.unmatched_encounters} lượt.`;
        finishResearchTask(sc.runDir, task.id, report.cancelled ? 'cancelled' : (report.errors.length ? 'error' : 'done'), { message });
        const redact = researchResponseShouldRedact(req);
        return res.json({
          status: 'ok', message, run_id: sc.runId, cancelled: report.cancelled,
          report: { ...report, exceptions: redactCollectionRows(report.exceptions.slice(0, 500), redact) },
          normalized,
        });
      } catch (err) {
        if (sc.isArchive) updateArchive({ active_run_id: '', active_mode: '', stopped_at: nowIso() });
        finishResearchTask(sc.runDir, task.id, 'error', { message: String(err?.message || err) });
        throw err;
      }
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(err.status || 500).json({ status: 'error', message: String(err.message || err) });
  }
}

function handleCollectionStatus(req, res, studyIdParam = '') {
  try {
    const sc = collectionScopeFromRequest(req, studyIdParam);
    if (sc.error) return res.status(sc.status || 400).json({ status: 'error', message: sc.error });
    const keys = unitKeysForRun(sc.runDir, sc.sourceRows);
    const ledger = sc.sourceRows.length ? syncCollectionLedger(sc.runDir, sc.sourceRows) : { encounters: {} };
    const maxAttempts = maxAttemptsFrom(req, sc.study);
    const plan = collection.planCollection(ledger, { keys, maxAttempts, refreshPolicy: sc.refreshPolicy });
    const exceptions = collection.exceptionRows(ledger, { keys, maxAttempts, unmatchedEncounters: unresolvedEncountersForRun(sc.runDir) });
    const lastReport = readJsonSafe(path.join(sc.runDir, COLLECTION_REPORT_FILE), null);
    const redact = researchResponseShouldRedact(req);
    return res.json({
      status: 'ok',
      run_id: sc.runId,
      max_attempts: maxAttempts,
      refresh_policy: sc.refreshPolicy,
      summary: collectionStatusSummary(ledger, keys),
      next_plan: plan.summary,
      last_report: lastReport ? { ...lastReport, exceptions: undefined } : null,
      exceptions_total: exceptions.length,
      exceptions: redactCollectionRows(exceptions.slice(0, 500), redact),
    });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
}

function handleCollectionExceptionsExport(req, res, studyIdParam = '') {
  try {
    const sc = collectionScopeFromRequest(req, studyIdParam);
    if (sc.error) return res.status(sc.status || 400).json({ status: 'error', message: sc.error });
    const keys = unitKeysForRun(sc.runDir, sc.sourceRows);
    const ledger = sc.sourceRows.length ? syncCollectionLedger(sc.runDir, sc.sourceRows) : { encounters: {} };
    const rows = collection.exceptionRows(ledger, { keys, maxAttempts: maxAttemptsFrom(req, sc.study), unmatchedEncounters: unresolvedEncountersForRun(sc.runDir) });
    writeCsv(path.join(sc.runDir, COLLECTION_EXCEPTIONS_FILE), COLLECTION_EXCEPTION_COLUMNS, rows);
    return sendCsvFile(res, path.join(sc.runDir, COLLECTION_EXCEPTIONS_FILE), `${sc.scope}_ngoai_le_thu_thap`, { redact: researchResponseShouldRedact(req) });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
}

lockedResearchRoute(router, 'post', '/research/archive/collect-auto', 'Thu thập tự động', (req, res) => handleCollectAuto(req, res));

lockedResearchRoute(router, 'post', '/research/studies/:studyId/collect-auto', 'Thu thập tự động', (req, res) => handleCollectAuto(req, res, req.params.studyId));

router.get('/research/archive/collection-status', (req, res) => handleCollectionStatus(req, res));

router.get('/research/studies/:studyId/collection-status', (req, res) => handleCollectionStatus(req, res, req.params.studyId));

router.get('/research/archive/collection-exceptions', (req, res) => handleCollectionExceptionsExport(req, res));

router.get('/research/studies/:studyId/collection-exceptions', (req, res) => handleCollectionExceptionsExport(req, res, req.params.studyId));

router.get('/research/archive/encounter-reviews', (req, res) => handleCollectionEncounterReviews(req, res));

lockedResearchRoute(router, 'post', '/research/archive/encounter-reviews', 'Duyệt lượt chưa ghép', (req, res) => handleCollectionEncounterReviews(req, res));

router.get('/research/studies/:studyId/encounter-reviews', (req, res) => handleCollectionEncounterReviews(req, res, req.params.studyId));

lockedResearchRoute(router, 'post', '/research/studies/:studyId/encounter-reviews', 'Duyệt lượt chưa ghép', (req, res) => handleCollectionEncounterReviews(req, res, req.params.studyId));

// Đủ dùng của các lượt trong run nghiên cứu, theo phần bắt buộc + điều kiện dữ liệu của đề cương.
router.get('/research/studies/:studyId/readiness', (req, res) => {
  try {
    const sc = collectionScopeFromRequest(req, req.params.studyId);
    if (sc.error) return res.status(sc.status || 400).json({ status: 'error', message: sc.error });
    const result = studyReadinessForRun(sc.study, sc.runDir, sc.sourceRows, { write: true, maxAttempts: maxAttemptsFrom(req, sc.study) });
    return res.json({ status: 'ok', run_id: sc.runId, requirements: result.requirements, counts: result.counts, total: result.total, rows: result.rows.slice(0, 2000) });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

// Các lượt trong KHO GỐC đạt điều kiện của một nghiên cứu (không ghi file).
router.get('/research/archive/readiness', (req, res) => {
  try {
    const study = readStudy(String(req.query?.studyId || ''));
    if (!study) return res.status(404).json({ status: 'error', message: 'Cần studyId của một nghiên cứu có thật.' });
    const sc = collectionScopeFromRequest(req);
    if (sc.error) return res.status(sc.status || 400).json({ status: 'error', message: sc.error });
    const result = studyReadinessForRun(study, sc.runDir, sc.sourceRows, { maxAttempts: maxAttemptsFrom(req, study) });
    return res.json({ status: 'ok', run_id: sc.runId, study_id: study.id, requirements: result.requirements, counts: result.counts, total: result.total, rows: result.rows.slice(0, 2000) });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

// Chính sách làm mới riêng từng phần (số ngày kể từ lần kiểm tra gần nhất; trống = không
// tự kiểm tra lại). Kho gốc và mỗi nghiên cứu có chính sách riêng.
router.post('/research/archive/refresh-policy', (req, res) => {
  try {
    const policy = collection.sanitizeRefreshPolicy(req.body?.refresh_policy || req.body || {});
    updateArchive({ refresh_policy: policy });
    return res.json({ status: 'ok', refresh_policy: policy });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.post('/research/studies/:studyId/refresh-policy', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const policy = collection.sanitizeRefreshPolicy(req.body?.refresh_policy || req.body || {});
    updateStudy(study.id, { refresh_policy: policy });
    return res.json({ status: 'ok', refresh_policy: policy });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

// Lịch sử thay đổi nội dung (phần nào, phiên bản nào, thêm/bớt bao nhiêu dòng).
function handleCollectionChanges(req, res, studyIdParam = '') {
  try {
    const sc = collectionScopeFromRequest(req, studyIdParam);
    if (sc.error) return res.status(sc.status || 400).json({ status: 'error', message: sc.error });
    const rows = readCsvTable(path.join(sc.runDir, COLLECTION_CHANGES_FILE), Number.MAX_SAFE_INTEGER).rows || [];
    return res.json({ status: 'ok', run_id: sc.runId, total: rows.length, changes: rows.slice(-1000).reverse() });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
}

router.get('/research/archive/collection-changes', (req, res) => handleCollectionChanges(req, res));

router.get('/research/studies/:studyId/collection-changes', (req, res) => handleCollectionChanges(req, res, req.params.studyId));

// Yêu cầu dữ liệu của đề cương: phần bắt buộc + dữ liệu phải có (ví dụ CT).
router.post('/research/studies/:studyId/data-requirements', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const dataRequirements = collection.sanitizeDataRequirements(req.body?.data_requirements || req.body || {});
    const updated = updateStudy(study.id, { data_requirements: { ...dataRequirements, updated_at: nowIso() } });
    return res.json({ status: 'ok', study: updated, requirements: collection.requirementsFromStudy(updated) });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

module.exports = router;
