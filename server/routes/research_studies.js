'use strict';

// Route nghiên cứu riêng: tạo/xóa nghiên cứu, cohort, cấu hình phân tích, dữ liệu, dataset, lấy dữ liệu và chuẩn hóa theo từng nghiên cứu.

const router = require('express').Router();
const { readStudy, resolveRunId, listStudies, updateStudy, validatePatientCsv, tablePathFor, sortRowsForTable, resolveStudyRunIdFast, readStudyProgressMeta, resolveStudyRunIdForAction, isStoppedRunResult, safeRunId, chooseStudyRunIdForResume, archiveTablePath } = require('../research/run_registry');
const { datasetVerifyResponse, researchResponseShouldRedact, lockedResearchRoute, sendCsvFile } = require('../research/research_http');
const path = require('path');
const { runsDir, cleanStudyId, uniqueStudyId, ARCHIVE_ID, studyDir, nowIso, studyMetaPath, cohortPath, TABLES, MAX_TABLE_ROWS, EXPORT_SENSITIVE_COLUMNS, archiveRunsDir } = require('../research/store_paths');
const { listDatasetSnapshots, finalizeAnalysisDataset, cleanResearchGenerated } = require('../research/dataset_store');
const fs = require('fs');
const { CASE_TRACE_RECENT_LIMIT, readResearchCaseTrace, redactCaseTracePayload } = require('../research/case_trace');
const { ANALYSIS_PRESETS, cleanCustomFields } = require('../research/analysis_presets');
const { ensureDir, writeJsonAtomic, writeFileAtomic, nowFileStamp, readJsonSafe, safeFilePart } = require('../utils/file');
const { sanitizeVariableSelection } = require('../research/selection_runtime');
const { RESEARCH_STORE_DIR, ROOT_DIR } = require('../constants');
const { appendSecurityAudit } = require('../services/security_audit');
const { firstNonEmpty } = require('../research/encounter_context');
const { importArchiveToStudy, normalizeStudyLatest, normalizeRunOutputs } = require('../research/normalize');
const { readCsvTable, countCsvRows } = require('../research/table_io');
const { redactCsvTable } = require('../research/export_utils');
const { buildCoverageSummary, buildResearchProgressSnapshot } = require('../research/progress_snapshot');
const { buildEncodedDataset } = require('../research/encoded_dataset');
const { khoOverlayNote } = require('../research/patient_db_overlay');
const { getRuntimePaths } = require('../services/session');
const { readResearchHchanhSourceRows } = require('../research/research_source');
const { hchanhDefaultFiles, fetchHchanhForResearchRun, researchHeadlessFromBody, orderHistoryDefaultFiles, orderHistoryRunLabel } = require('../research/hchanh_fetch');
const { enqueueHeavy, registerCancel, unregisterCancel } = require('../services/task_queue');
const { SCRIPT_PATH } = require('../research/worker_paths');
const { runPython, fmtPyError } = require('../services/python_runner');

router.get('/research/studies/:studyId/datasets/verify', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const runId = resolveRunId(study.id, String(req.query.runId || 'latest'));
    return res.json(datasetVerifyResponse(runId, runId ? path.join(runsDir(study.id), runId) : ''));
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/studies/:studyId/datasets', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const runId = resolveRunId(study.id, String(req.query.runId || 'latest'));
    const runDir = runId ? path.join(runsDir(study.id), runId) : '';
    return res.json({ status: 'ok', run_id: runId || '', datasets: runDir ? listDatasetSnapshots(runDir) : [] });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/studies/:studyId/log', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const runId = resolveRunId(study.id, String(req.query.runId || 'latest'));
    if (!runId) return res.json({ status: 'ok', lines: [], run_id: '' });
    const logPath = path.join(runsDir(study.id), runId, 'action_log.txt');
    const maxLines = Math.min(2000, Number(req.query.lines || 500));
    if (!fs.existsSync(logPath)) return res.json({ status: 'ok', lines: [], run_id: runId, exists: false });
    const text = fs.readFileSync(logPath, 'utf-8');
    const all  = text.split('\n').filter(l => l.trim());
    const lines = all.slice(-maxLines);
    return res.json({ status: 'ok', lines, total: all.length, run_id: runId, exists: true });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/studies/:studyId/case-trace', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const runId = resolveRunId(study.id, String(req.query.runId || 'latest'));
    if (!runId) return res.json({ status: 'ok', cases: [], run_id: '' });
    const runDir = path.join(runsDir(study.id), runId);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit || CASE_TRACE_RECENT_LIMIT)));
    const cases = readResearchCaseTrace(runDir, limit);
    const redact = researchResponseShouldRedact(req);
    return res.json({ status: 'ok', run_id: runId, cases: redact ? redactCaseTracePayload(cases) : cases, limit, redacted: redact });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/studies', (_req, res) => {
  return res.json({ status: 'ok', studies: listStudies() });
});

router.get('/research/analysis-presets', (_req, res) => {
  const out = Object.entries(ANALYSIS_PRESETS).map(([id, p]) => ({
    id,
    label: p.label,
    inference_fields: p.inference_fields.map(f => ({ key: f.key, label: f.label })),
  }));
  return res.json({ status: 'ok', presets: out });
});

router.post('/research/studies', (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ status: 'error', message: 'Cần nhập tên nghiên cứu.' });
    const id = req.body?.id ? cleanStudyId(req.body.id) : uniqueStudyId(name);
    if (id === ARCHIVE_ID) return res.status(400).json({ status: 'error', message: 'Mã này đang dùng cho kho dữ liệu gốc.' });
    if (fs.existsSync(studyDir(id))) return res.status(409).json({ status: 'error', message: 'Mã nghiên cứu đã tồn tại.' });
    ensureDir(studyDir(id));

    // Validate analysis_config
    const rawPreset = String(req.body?.analysis_config?.preset || 'general');
    const presetId  = ANALYSIS_PRESETS[rawPreset] ? rawPreset : 'general';
    const customFields = cleanCustomFields(req.body?.analysis_config?.custom_fields, presetId, true);
    const rawVariableSelection = req.body?.variable_selection || req.body?.analysis_config?.variable_selection || null;
    const variable_selection = rawVariableSelection ? sanitizeVariableSelection(rawVariableSelection) : null;
    const analysis_config = { preset: presetId, custom_fields: customFields };
    if (variable_selection) analysis_config.variable_selection = variable_selection;

    const meta = {
      id,
      name,
      description: String(req.body?.description || '').trim(),
      type: 'archive_derived',
      analysis_config,
      variable_selection,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    writeJsonAtomic(studyMetaPath(id), meta);
    return res.json({ status: 'ok', study: readStudy(id) });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.post('/research/studies/:studyId/analysis-config', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });

    const rawPreset = String(req.body?.preset || 'general');
    const presetId  = ANALYSIS_PRESETS[rawPreset] ? rawPreset : 'general';
    const customFields = cleanCustomFields(req.body?.custom_fields, presetId, true);
    const analysis_config = { preset: presetId, custom_fields: customFields };
    if (study.analysis_config?.variable_selection) analysis_config.variable_selection = study.analysis_config.variable_selection;
    const updated = updateStudy(study.id, { analysis_config });
    return res.json({ status: 'ok', message: `Đã cập nhật cấu hình phân tích: ${ANALYSIS_PRESETS[presetId].label}.`, study: updated });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/studies/:studyId', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    return res.json({ status: 'ok', study });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute(router, 'post', '/research/studies/:studyId/cohort', 'Nạp cohort', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const csv = String(req.body?.csv || '');
    const parsed = validatePatientCsv(csv, 'CSV cần có cột Mã BN.');
    writeFileAtomic(cohortPath(study.id), csv.replace(/^\ufeff/, ''), 'utf-8');
    const original = String(req.body?.filename || 'cohort.csv').trim();
    updateStudy(study.id, { cohort_filename: original || 'cohort.csv', cohort_uploaded_at: nowIso(), cohort_source: 'upload' });
    return res.json({ status: 'ok', study: readStudy(study.id), columns: parsed.columns, count: parsed.count });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute(router, 'delete', '/research/studies/:studyId', 'Xóa nghiên cứu', (req, res) => {
  try {
    const { studyId } = req.params;
    const study = readStudy(studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    // Không xóa vĩnh viễn: chuyển cả thư mục (runs, cohort, study.json, SQLite) vào
    // research_store/_deleted/<id>_<thời điểm>/ để còn khôi phục được nếu xóa nhầm.
    // Dọn hẳn thư mục _deleted là việc của admin theo chính sách lưu trữ của bệnh viện.
    const trashDir = path.join(RESEARCH_STORE_DIR, '_deleted');
    ensureDir(trashDir);
    const target = path.join(trashDir, `${study.id}_${nowFileStamp()}`);
    fs.renameSync(studyDir(study.id), target);
    appendSecurityAudit({
      kind: 'research.study_deleted',
      actor: { id: String(req.auth?.id || ''), role: String(req.auth?.role || '') },
      study_id: study.id,
      moved_to: path.relative(RESEARCH_STORE_DIR, target),
    });
    return res.json({ status: 'ok', message: `Đã xóa nghiên cứu "${study.name}" (thư mục được chuyển vào _deleted, admin có thể khôi phục).` });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

// Lưu cohort từ danh sách đã lọc trên frontend (mảng rows JSON → ghi thành cohort.csv)
lockedResearchRoute(router, 'post', '/research/studies/:studyId/cohort-from-filtered', 'Nạp cohort', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ status: 'error', message: 'Danh sách rỗng.' });
    const normalizedRows = rows.map((row, idx) => {
      const next = { ...(row || {}) };
      const code = firstNonEmpty(next, ['Mã BN', 'Ma BN', 'MABN', 'patient_code']);
      if (code && !next['Mã BN']) next['Mã BN'] = code;
      const name = firstNonEmpty(next, ['Họ tên', 'Ho ten', 'patient_name']);
      if (name && !next['Họ tên']) next['Họ tên'] = name;
      const researchCode = firstNonEmpty(next, ['Mã NC', 'Ma NC', 'research_code']) || `NC${String(idx + 1).padStart(4, '0')}`;
      if (!next['Mã NC']) next['Mã NC'] = researchCode;
      if (!next['Ngày vào viện'] && next.admission_date) next['Ngày vào viện'] = next.admission_date;
      if (!next['Ngày ra viện'] && next.discharge_date) next['Ngày ra viện'] = next.discharge_date;
      if (!next['Chẩn đoán'] && next.diagnosis_raw) next['Chẩn đoán'] = next.diagnosis_raw;
      if (!next['Tuổi'] && next.age) next['Tuổi'] = next.age;
      if (!next['Giới'] && next.sex) next['Giới'] = next.sex;
      return next;
    });
    const colSet = new Set(['Mã NC', 'Mã BN', 'Họ tên', 'Giới', 'Tuổi', 'Ngày vào viện', 'Ngày ra viện', 'Chẩn đoán']);
    for (const row of normalizedRows) Object.keys(row).forEach(k => colSet.add(k));
    const cols = Array.from(colSet);
    const escape = v => { const s = String(v ?? ''); return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = '\ufeff' + cols.map(escape).join(',') + '\n'
      + normalizedRows.map(r => cols.map(c => escape(r[c] ?? '')).join(',')).join('\n');
    writeFileAtomic(cohortPath(study.id), csv.replace(/^\ufeff/, ''), 'utf-8');
    updateStudy(study.id, {
      cohort_filename: 'cohort.csv',
      cohort_uploaded_at: nowIso(),
      cohort_source: 'filtered',
      cohort_count: rows.length,
    });
    return res.json({ status: 'ok', study: readStudy(study.id), count: rows.length });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute(router, 'post', '/research/studies/:studyId/import-from-archive', 'Nhập từ kho gốc', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const result = importArchiveToStudy(study, {
      admitFrom: String(req.body?.admitFrom || ''),
      admitTo: String(req.body?.admitTo || ''),
      dischargeFrom: String(req.body?.dischargeFrom || ''),
      dischargeTo: String(req.body?.dischargeTo || ''),
    });
    return res.json({ status: 'ok', message: `Đã tạo danh sách ${result.count} Mã BN từ kho gốc. Bấm Lấy thêm dữ liệu EMR để quét dữ liệu riêng cho nghiên cứu.`, ...result });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/studies/:studyId/data', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const tableKey = TABLES[req.query.table] ? String(req.query.table) : 'patients';
    const runId = resolveRunId(study.id, String(req.query.runId || 'latest'));
    const filePath = tablePathFor(study.id, tableKey, runId || 'latest');
    const data = filePath ? readCsvTable(filePath, MAX_TABLE_ROWS) : { columns: [], rows: [], count: 0, limited: false, exists: false };
    const displayRows = sortRowsForTable(tableKey, data.rows);
    const redact = researchResponseShouldRedact(req);
    const output = redact ? redactCsvTable(data.columns, displayRows, EXPORT_SENSITIVE_COLUMNS) : { columns: data.columns, rows: displayRows, removed_columns: [] };
    return res.json({
      status: 'ok',
      study,
      table: { key: tableKey, ...TABLES[tableKey] },
      run_id: runId || '',
      columns: output.columns,
      rows: output.rows,
      redacted: redact,
      removed_columns: output.removed_columns,
      count: data.count,
      limited: data.limited,
      exists: data.exists,
      max_rows: MAX_TABLE_ROWS,
    });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/studies/:studyId/export', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const tableKey = TABLES[req.query.table] ? String(req.query.table) : 'analysis_ready';
    const runId = resolveRunId(study.id, String(req.query.runId || 'latest'));
    const filePath = tablePathFor(study.id, tableKey, runId || 'latest');
    return sendCsvFile(res, filePath, `${study.id}_${runId || 'latest'}_${tableKey}`, { redact: researchResponseShouldRedact(req) });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/studies/:studyId/coverage', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const runId = resolveRunId(study.id, String(req.query.runId || 'latest'));
    const runDir = runId ? path.join(runsDir(study.id), runId) : '';
    return res.json({ status: 'ok', coverage: buildCoverageSummary(runDir) });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/studies/:studyId/progress', (req, res) => {
  try {
    const runId = resolveStudyRunIdFast(req.params.studyId, String(req.query.runId || 'latest'));
    const study = readStudyProgressMeta(req.params.studyId, runId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const runDir = runId ? path.join(runsDir(study.id), runId) : '';
    const progress = buildResearchProgressSnapshot(runDir, study, { isArchive: false });
    return res.json({ status: 'ok', run_id: runId || '', progress });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute(router, 'post', '/research/studies/:studyId/finalize-dataset', 'Tạo dataset cuối', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const runId = resolveRunId(study.id, String(req.query.runId || 'latest'));
    if (!runId) return res.status(400).json({ status: 'error', message: 'Nghiên cứu chưa có run.' });
    const result = finalizeAnalysisDataset(path.join(runsDir(study.id), runId));
    const updated = updateStudy(study.id, { last_finalized_at: nowIso() });
    return res.json({ status: 'ok', message: `Đã tạo analysis_final.csv (${result.count} dòng).`, study: updated, ...result });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err), coverage: err.coverage || undefined });
  }
});

lockedResearchRoute(router, 'post', '/research/studies/:studyId/build-encoded-dataset', 'Tạo dataset mã hóa', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const runId = resolveRunId(study.id, String(req.query.runId || 'latest'));
    if (!runId) return res.status(400).json({ status: 'error', message: 'Nghiên cứu chưa có run.' });
    const result = buildEncodedDataset(path.join(runsDir(study.id), runId));
    const updated = updateStudy(study.id, { last_encoded_at: nowIso() });
    return res.json({ status: 'ok', message: `Đã tạo/cập nhật dữ liệu encoded cho ${runId}.`, study: updated, ...result });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute(router, 'post', '/research/studies/:studyId/clean-generated', 'Dọn dữ liệu sinh ra', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const runId = resolveRunId(study.id, String(req.query.runId || 'latest'));
    if (!runId) return res.status(400).json({ status: 'error', message: 'Nghiên cứu chưa có run.' });
    const result = cleanResearchGenerated(path.join(runsDir(study.id), runId), {
      encoded: req.body?.encoded !== false,
      debug: req.body?.debug !== false,
      derived: req.body?.derived === true,
    });
    const updated = updateStudy(study.id, { last_cleaned_at: nowIso() });
    return res.json({ status: 'ok', message: `Đã dọn file phụ cho ${runId}.`, study: updated, run_id: runId, ...result });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute(router, 'post', '/research/studies/:studyId/normalize', 'Chuẩn hóa', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const result = normalizeStudyLatest(study.id);
    const updated = result.counts?.cached ? study : updateStudy(study.id, { last_normalized_at: nowIso() });
    return res.json({ status: 'ok', message: result.counts?.cached ? 'Dữ liệu nghiên cứu đã chuẩn hóa sẵn, không cần chạy lại.' : `Đã chuẩn hóa dữ liệu nghiên cứu.${khoOverlayNote(result.counts)}`, study: updated, ...result });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute(router, 'post', '/research/studies/:studyId/fetch-hchanh', 'Lấy dữ liệu hành chánh', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    if (!fs.existsSync(cohortPath(study.id))) return res.status(400).json({ status: 'error', message: 'Chưa có danh sách bệnh nhân cho nghiên cứu này.' });

    const runId = resolveStudyRunIdForAction(study.id, req.body?.runId || 'latest');
    const runDir = path.join(runsDir(study.id), runId);
    ensureDir(runDir);

    // Nếu nghiên cứu riêng chưa có run XN/CĐHA, dùng cohort làm nguồn nền cho run hành chánh.
    const initialPath = path.join(runDir, 'du_lieu_ban_dau.csv');
    const samplePath = path.join(runDir, 'mau_nghien_cuu.csv');
    if (!fs.existsSync(initialPath)) fs.copyFileSync(cohortPath(study.id), initialPath);
    if (!fs.existsSync(samplePath)) fs.copyFileSync(cohortPath(study.id), samplePath);
    const manifestPath = path.join(runDir, 'manifest.json');
    const manifest = readJsonSafe(manifestPath, {}) || {};
    const archiveSourceManifest = study.cohort_source_run_id
      ? readJsonSafe(path.join(archiveRunsDir(), safeFilePart(study.cohort_source_run_id), 'manifest.json'), {}) || {}
      : {};
    const dateDefaults = {
      from_date: String(req.body?.fromDate || manifest.from_date || archiveSourceManifest.from_date || '').trim(),
      to_date: String(req.body?.toDate || manifest.to_date || archiveSourceManifest.to_date || '').trim(),
    };
    writeJsonAtomic(manifestPath, {
      created_at: manifest.created_at || nowIso(),
      updated_at: nowIso(),
      source: manifest.source || 'study_hchanh_auto',
      source_run_id: manifest.source_run_id || study.cohort_source_run_id || '',
      from_date: manifest.from_date || dateDefaults.from_date || '',
      to_date: manifest.to_date || dateDefaults.to_date || '',
      patients_count: manifest.patients_count || countCsvRows(cohortPath(study.id)),
      ...manifest,
    });

    const sourceInfo = readResearchHchanhSourceRows(runDir, cohortPath(study.id), { sourceRunId: runId, dateDefaults });
    const { rows, file, base_file: baseFile, date_context: dateContext } = sourceInfo;
    if (!rows.length) return res.status(400).json({ status: 'error', message: `Không tìm thấy danh sách Mã BN để lấy hành chánh tự động trong run ${runId}. Hãy kiểm tra đã có du_lieu_ban_dau.csv/cohort.csv hoặc bấm Bước 1 trước.` });
    const files = hchanhDefaultFiles(req.body?.files);
    const limit = Number.isFinite(Number(req.body?.limit)) ? Math.max(0, Math.trunc(Number(req.body.limit))) : 0;

    await enqueueHeavy(ctx.sid, async () => {
      const fetched = await fetchHchanhForResearchRun(ctx, runDir, {
        sourceRows: rows,
        sourceRunId: runId,
        files,
        headless: researchHeadlessFromBody(req.body),
        force: req.body?.force === true,
        refreshProvisional: req.body?.refreshProvisional === true,
        fallbackDateFrom: dateContext?.from_date || String(req.body?.fromDate || ''),
        fallbackDateTo: dateContext?.to_date || String(req.body?.toDate || ''),
        limit,
        mode: 'hchanh_auto',
      });
      const normalized = normalizeRunOutputs(runDir, { sourceRunId: runId });
      const updated = updateStudy(study.id, {
        last_run_id: runId,
        last_run_at: nowIso(),
        last_normalized_at: nowIso(),
        last_hchanh_auto_at: nowIso(),
      });
      return res.json({
        status: 'ok',
        message: `Đã tự động lấy hành chánh từ EMR cho nghiên cứu: xử lý=${fetched.processed}, bỏ qua=${fetched.skipped}, OK=${fetched.ok}, cần xem=${fetched.attention}, lỗi=${fetched.error}.`,
        study: updated,
        run_id: runId,
        source_file: path.basename(file || ''),
        source_base_file: path.basename(baseFile || ''),
        source_date_from: dateContext?.from_date || '',
        source_date_to: dateContext?.to_date || '',
        fetched,
        normalized,
      });
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute(router, 'post', '/research/studies/:studyId/fetch-order-history', 'Lấy lịch sử y lệnh', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    if (!fs.existsSync(cohortPath(study.id))) return res.status(400).json({ status: 'error', message: 'Chưa có danh sách bệnh nhân cho nghiên cứu này.' });

    const runId = resolveStudyRunIdForAction(study.id, req.body?.runId || 'latest');
    const runDir = path.join(runsDir(study.id), runId);
    ensureDir(runDir);

    const initialPath = path.join(runDir, 'du_lieu_ban_dau.csv');
    const samplePath = path.join(runDir, 'mau_nghien_cuu.csv');
    if (!fs.existsSync(initialPath)) fs.copyFileSync(cohortPath(study.id), initialPath);
    if (!fs.existsSync(samplePath)) fs.copyFileSync(cohortPath(study.id), samplePath);
    const manifestPath = path.join(runDir, 'manifest.json');
    const manifest = readJsonSafe(manifestPath, {}) || {};
    const archiveSourceManifest = study.cohort_source_run_id
      ? readJsonSafe(path.join(archiveRunsDir(), safeFilePart(study.cohort_source_run_id), 'manifest.json'), {}) || {}
      : {};
    const dateDefaults = {
      from_date: String(req.body?.fromDate || manifest.from_date || archiveSourceManifest.from_date || '').trim(),
      to_date: String(req.body?.toDate || manifest.to_date || archiveSourceManifest.to_date || '').trim(),
    };
    writeJsonAtomic(manifestPath, {
      created_at: manifest.created_at || nowIso(),
      updated_at: nowIso(),
      source: manifest.source || 'study_order_history_auto',
      source_run_id: manifest.source_run_id || study.cohort_source_run_id || '',
      from_date: manifest.from_date || dateDefaults.from_date || '',
      to_date: manifest.to_date || dateDefaults.to_date || '',
      patients_count: manifest.patients_count || countCsvRows(cohortPath(study.id)),
      ...manifest,
    });

    const sourceInfo = readResearchHchanhSourceRows(runDir, cohortPath(study.id), { sourceRunId: runId, dateDefaults });
    const { rows, file, base_file: baseFile, date_context: dateContext } = sourceInfo;
    if (!rows.length) return res.status(400).json({ status: 'error', message: `Không tìm thấy danh sách Mã BN để lấy lịch sử y lệnh trong run ${runId}. Hãy kiểm tra đã có du_lieu_ban_dau.csv/cohort.csv hoặc bấm Bước 1 trước.` });

    const files = orderHistoryDefaultFiles(req.body?.files);
    const limit = Number.isFinite(Number(req.body?.limit)) ? Math.max(0, Math.trunc(Number(req.body.limit))) : 0;

    await enqueueHeavy(ctx.sid, async () => {
      const fetched = await fetchHchanhForResearchRun(ctx, runDir, {
        sourceRows: rows,
        sourceRunId: runId,
        files,
        headless: researchHeadlessFromBody(req.body),
        force: req.body?.force === true,
        refreshProvisional: req.body?.refreshProvisional === true,
        fallbackDateFrom: dateContext?.from_date || String(req.body?.fromDate || ''),
        fallbackDateTo: dateContext?.to_date || String(req.body?.toDate || ''),
        limit,
        mode: 'order_history_auto',
      });
      const normalized = normalizeRunOutputs(runDir, { sourceRunId: runId });
      const updated = updateStudy(study.id, {
        last_run_id: runId,
        last_run_at: nowIso(),
        last_normalized_at: nowIso(),
        last_order_history_auto_at: nowIso(),
      });
      return res.json({
        status: 'ok',
        message: `Đã tự động lấy ${orderHistoryRunLabel(files)} từ EMR cho nghiên cứu: xử lý=${fetched.processed}, bỏ qua=${fetched.skipped}, OK=${fetched.ok}, cần xem=${fetched.attention}, lỗi=${fetched.error}.`,
        study: updated,
        run_id: runId,
        source_file: path.basename(file || ''),
        source_base_file: path.basename(baseFile || ''),
        source_date_from: dateContext?.from_date || '',
        source_date_to: dateContext?.to_date || '',
        fetched,
        normalized,
      });
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute(router, 'post', '/research/studies/:studyId/patient-info', 'Lấy thông tin người bệnh', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    if (!fs.existsSync(cohortPath(study.id))) return res.status(400).json({ status: 'error', message: 'Chưa có danh sách bệnh nhân cho nghiên cứu này.' });
    if (!fs.existsSync(SCRIPT_PATH)) return res.status(500).json({ status: 'error', message: 'Thiếu script lấy dữ liệu nghiên cứu.' });
    const runId = resolveStudyRunIdForAction(study.id, req.body?.runId || 'latest');
    const runDir = path.join(runsDir(study.id), runId);
    ensureDir(runDir);
    const initialPath = path.join(runDir, 'du_lieu_ban_dau.csv');
    const samplePath = path.join(runDir, 'mau_nghien_cuu.csv');
    if (!fs.existsSync(initialPath)) fs.copyFileSync(cohortPath(study.id), initialPath);
    if (!fs.existsSync(samplePath)) fs.copyFileSync(cohortPath(study.id), samplePath);
    const archiveSourceManifest = study.cohort_source_run_id
      ? readJsonSafe(path.join(archiveRunsDir(), safeFilePart(study.cohort_source_run_id), 'manifest.json'), {}) || {}
      : {};
    const sourceInfo = readResearchHchanhSourceRows(runDir, cohortPath(study.id), {
      sourceRunId: runId,
      dateDefaults: { from_date: archiveSourceManifest.from_date || '', to_date: archiveSourceManifest.to_date || '' },
    });
    const inputPath = sourceInfo.file || cohortPath(study.id);
    const args = [
      '-u', SCRIPT_PATH,
      '--input', inputPath,
      '--project-id', study.id,
      '--run-id', runId,
      '--out-root', RESEARCH_STORE_DIR,
      '--patient-info-only',
    ];
    if (researchHeadlessFromBody(req.body)) args.push('--headless');

    await enqueueHeavy(ctx.sid, async () => {
      let result;
      try {
        result = await runPython(args, {
          cwd: ROOT_DIR,
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
          extraEnv: { RESEARCH_INPUT_NAME: path.basename(inputPath) },
        });
      } finally {
        unregisterCancel(ctx.sid);
      }

      if (result.spawnError) return res.status(500).json({ status: 'error', message: `Không khởi động được Python: ${result.spawnError}` });
      if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: 'Timeout khi lấy thông tin khác. Dữ liệu đã lưu từng mã BN, bấm lại để chạy tiếp.' });
      if (isStoppedRunResult(result)) {
        const normalized = normalizeRunOutputs(path.join(runsDir(study.id), runId), { sourceRunId: runId });
        const updated = updateStudy(study.id, { last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso(), stopped_at: nowIso() });
        return res.json({ status: 'ok', stopped: true, message: 'Đã dừng. Thông tin khác đã lấy vẫn được giữ; bấm lại để chạy tiếp.', study: updated, run_id: runId, normalized });
      }
      if (result.code !== 0) return res.status(500).json({ status: 'error', message: fmtPyError('Python lỗi khi lấy thông tin khác từ D/s Bệnh nhân. Dữ liệu đã lưu nếu chạy được một phần.', result) });

      const normalized = normalizeRunOutputs(path.join(runsDir(study.id), runId), { sourceRunId: runId });
      const updated = updateStudy(study.id, { last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso() });
      return res.json({ status: 'ok', message: 'Đã lấy thông tin khác: Điện thoại, Số CMND/CCCD, BHYT, địa chỉ từ D/s Bệnh nhân.', study: updated, run_id: runId, normalized });
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute(router, 'post', '/research/studies/:studyId/run', 'Lấy dữ liệu', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    if (!fs.existsSync(cohortPath(study.id))) return res.status(400).json({ status: 'error', message: 'Chưa có danh sách bệnh nhân cho nghiên cứu này.' });
    if (!fs.existsSync(SCRIPT_PATH)) return res.status(500).json({ status: 'error', message: 'Thiếu script lấy dữ liệu nghiên cứu.' });

    const runId = safeRunId(req.body?.runId || (req.body?.resume === false ? nowFileStamp() : chooseStudyRunIdForResume(study.id))) || nowFileStamp();
    const args = [
      '-u', SCRIPT_PATH,
      '--input', cohortPath(study.id),
      '--project-id', study.id,
      '--run-id', runId,
      '--out-root', RESEARCH_STORE_DIR,
    ];
    if (req.body?.fromDate) args.push('--from-date', String(req.body.fromDate));
    if (req.body?.toDate) args.push('--to-date', String(req.body.toDate));
    if (researchHeadlessFromBody(req.body)) args.push('--headless');
    const archiveInitialListPath = study.cohort_source === 'archive' && study.cohort_source_run_id
      ? archiveTablePath('initial_list', study.cohort_source_run_id)
      : '';
    if (archiveInitialListPath && fs.existsSync(archiveInitialListPath)) {
      args.push('--archive-initial-list', archiveInitialListPath);
    }

    updateStudy(study.id, { active_run_id: runId, active_mode: 'deep' });

    await enqueueHeavy(ctx.sid, async () => {
      try {
      let result;
      try {
        result = await runPython(args, {
          cwd: ROOT_DIR,
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
          extraEnv: { RESEARCH_INPUT_NAME: path.basename(cohortPath(study.id)) },
        });
      } finally {
        unregisterCancel(ctx.sid);
      }

      if (result.spawnError) return res.status(500).json({ status: 'error', message: `Không khởi động được Python: ${result.spawnError}` });
      if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: 'Timeout khi lấy dữ liệu nghiên cứu. Tiến độ đã lưu, bấm Lấy thêm/tiếp tục để chạy tiếp từ ca chưa xong.' });
      if (isStoppedRunResult(result)) {
        const normalized = normalizeRunOutputs(path.join(runsDir(study.id), runId), { sourceRunId: runId });
        const updated = updateStudy(study.id, { last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso(), stopped_at: nowIso() });
        return res.json({ status: 'ok', stopped: true, message: 'Đã dừng. Các ca đã đủ dữ liệu đã lưu; ca đang dở sẽ được lấy lại khi bấm Lấy thêm/tiếp tục.', study: updated, run_id: runId, normalized });
      }
      if (result.code !== 0) return res.status(500).json({ status: 'error', message: fmtPyError('Python lỗi khi lấy dữ liệu nghiên cứu. Tiến độ đã lưu nếu đã chạy được một phần.', result) });

      const normalized = normalizeRunOutputs(path.join(runsDir(study.id), runId), { sourceRunId: runId });
      const updated = updateStudy(study.id, { last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso(), active_run_id: '', active_mode: '' });
      return res.json({ status: 'ok', message: 'Đã lấy và chuẩn hóa dữ liệu nghiên cứu.', study: updated, run_id: runId, normalized });
      } finally {
        updateStudy(study.id, { active_run_id: '', active_mode: '' });
      }
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

module.exports = router;
