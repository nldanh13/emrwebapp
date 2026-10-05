// server/routes/research.js — Route Kho nghiên cứu (kho gốc và các route dùng chung).
//
// Cấu trúc phần Kho nghiên cứu:
//   server/routes/research.js            route kho gốc: danh sách, dữ liệu, lấy dữ liệu, chuẩn hóa, dataset
//   server/routes/research_studies.js    route nghiên cứu riêng
//   server/routes/research_collection.js route thu thập tự động (kho gốc + nghiên cứu)
//   server/research/*.js                 logic, không phụ thuộc Express:
//     store_paths, run_registry          hằng số, đường dẫn kho/nghiên cứu, danh sách run, metadata
//     table_io, csv_reader               đọc/ghi CSV (đọc theo khối, đếm dòng, cache)
//     research_source, source_merge      nguồn chuẩn (Mã NC, Research key) và gộp nguồn thành đợt
//     encounter_context                  ngày giờ, khóa đợt, ghép dòng vào đúng lượt
//     value_normalizers, analysis_presets  chuẩn hóa giá trị lâm sàng, preset phân tích
//     normalize, normalized_schema       chuẩn hóa một run ra bảng chuẩn hóa/analysis_ready/QA/SQLite
//     patient_link                       bảng liên kết Mã BN ↔ patient_key (mã giả danh)
//     hchanh_fetch, patient_db_overlay   lấy hành chánh qua worker; dùng Kho người bệnh
//     collection, collection_runtime     thu thập tự động: sổ theo dõi, giao dịch, phiên bản
//     progress_snapshot, case_trace      tiến độ/trạng thái tác vụ, nhật ký và vết từng ca
//     dataset_store, encoded_dataset     dataset cuối (bản bất biến có checksum), bảng mã hóa
//     variable_catalog, variable_selection, selection_runtime  danh mục biến, chọn biến
//     patient_history, research_db       tra cứu người bệnh, đồng bộ SQLite
//     research_http                      che định danh, xuất CSV theo dòng, khóa theo kho

'use strict';

const router = require('express').Router();
const fs = require('fs');
const path = require('path');

const { ROOT_DIR, RESEARCH_STORE_DIR } = require('../constants');
const { ensureDir, writeFileAtomic, nowFileStamp, readJsonSafe } = require('../utils/file');
const { runPython, fmtPyError } = require('../services/python_runner');
const { getRuntimePaths } = require('../services/session');
const { enqueueHeavy, registerCancel, unregisterCancel, isCancelRequested } = require('../services/task_queue');
const variableSelection = require('../research/variable_selection');
const { redactCsvTable, isSensitiveColumn } = require('../research/export_utils');
const dataDictionary = require('../research/data_dictionary');
const { ARCHIVE_ID, EXPORT_SENSITIVE_COLUMNS, MAX_TABLE_ROWS, TABLES, archiveDir, archiveRunsDir, archiveSourcePath, cohortPath, ensureArchiveStore, nowIso, runsDir, todayDateInput } = require('../research/store_paths');
const { patientCode, readCsvTable, writeCsv, writeCsvUnion } = require('../research/table_io');
const { appendSecurityAudit } = require('../services/security_audit');
const { buildContextMap, contextForRow, encounterMatchMethod, encounterMatchStatus } = require('../research/encounter_context');
const { CASE_TRACE_RECENT_LIMIT, appendResearchRunLog, readResearchCaseTrace, redactCaseTracePayload, readLiveProgress } = require('../research/case_trace');
const { activeResearchTask, beginResearchTask, buildCoverageSummary, buildResearchProgressSnapshot, finishResearchTask, hchanhEntryFileStatus, isRowMissingXnCdha, resetXnCdhaProgress, rowResearchCode, sourceRowsForXnCdhaRefetch, updateResearchTask } = require('../research/progress_snapshot');
const { NORMALIZED_COLUMNS } = require('../research/normalized_schema');
const { combineEncounterSources } = require('../research/source_merge');
const { cleanResearchGenerated, cleanupStaleDatasetStaging, finalizeAnalysisDataset, listDatasetSnapshots, verifyAllDatasetSnapshots, verifyDatasetSnapshot, writeDatasetSnapshot } = require('../research/dataset_store');
const { buildEncodedDataset } = require('../research/encoded_dataset');
const { buildPatientHistory } = require('../research/patient_history');
const { VARIABLE_CATALOG_MAX_ROWS, buildVariableCatalog, summarizeVariableColumns } = require('../research/variable_catalog');
const { resolveStudyRunIdFast } = require('../research/run_registry');
const { archiveTablePath, chooseArchiveRunIdForResume, isStoppedRunResult, readArchive, readArchiveProgressMeta, readStudy, resolveArchiveRunId, resolveArchiveRunIdFast, resolveArchiveRunIdForAction, resolveRunId, safeRunId, sortRowsForTable, updateArchive, updateStudy, validatePatientCsv } = require('../research/run_registry');
const { ensureResearchSourceRows, flattenHchanhIntoResearchRun, normalizeResearchSourceRows, readResearchHchanhSourceRows, researchHchanhMeta } = require('../research/research_source');
const { fetchHchanhForResearchRun, hchanhDefaultFiles, hchanhFileStatusPatch, orderHistoryDefaultFiles, orderHistoryRunLabel, researchHeadlessFromBody } = require('../research/hchanh_fetch');
const { addRowsToResultDayIndex, buildResultDayIndex, ingestAllResearchResultsToPatientDb, khoOverlayNote, overlayHchanhFromPatientDb, overlayResultsFromPatientDb, resultDayIndexHasRange } = require('../research/patient_db_overlay');
const { sanitizeVariableSelection, summarizeSelectionForRun } = require('../research/selection_runtime');
const { buildPipelineInfo } = require('../research/pipeline_info');
const { buildStudySuggestions } = require('../research/study_suggestions');
const { normalizeInputSignature, normalizeRunOutputs } = require('../research/normalize');
const { runNormalizeJob, normalizeRunning } = require('../research/normalize_runner');
const { SCRIPT_PATH } = require('../research/worker_paths');
const { appendCollectionVersions, readCollectionPartRows, readCollectionVersionIds, recoverCollectionTransactions, recoverPythonPatientCommits, runCollectionOrchestration, studyReadinessForRun, syncCollectionLedger } = require('../research/collection_runtime');
const { watchResearchScope, setRunningSignature } = require('../services/research_watch');
const { RESEARCH_SCOPE_LOCKS, datasetVerifyResponse, listRunningResearch, withScopeRunning, identifiedAccessStatus, lockedResearchRoute, researchResponseShouldRedact, researchScopeKey, sendCsvFile } = require('../research/research_http');

const VARIABLE_PREVIEW_MAX_SOURCE_ROWS = Math.max(5000, Number(process.env.EMR_VARIABLE_PREVIEW_MAX_SOURCE_ROWS || 1000000));
const VARIABLE_PREVIEW_MAX_ENCOUNTERS = Math.max(100, Number(process.env.EMR_VARIABLE_PREVIEW_MAX_ENCOUNTERS || 50000));

router.post('/research/archive/dismiss-alert', (_req, res) => {
  try {
    const runId = resolveArchiveRunId('latest');
    if (runId) {
      const alertPath = path.join(archiveRunsDir(), runId, 'fatal_alert.json');
      if (fs.existsSync(alertPath)) fs.unlinkSync(alertPath);
    }
    return res.json({ status: 'ok' });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/archive', (_req, res) => {
  return res.json({ status: 'ok', archive: readArchive() });
});

lockedResearchRoute(router, 'post', '/research/archive/source', 'Nạp danh sách nguồn', (req, res) => {
  try {
    ensureArchiveStore();
    const csv = String(req.body?.csv || '');
    const parsed = validatePatientCsv(csv, 'CSV tổng cần có cột Mã BN. Nên có thêm Ngày vào viện và Ngày ra viện để lọc nghiên cứu.');
    writeFileAtomic(archiveSourcePath(), csv.replace(/^\ufeff/, ''), 'utf-8');
    const original = String(req.body?.filename || 'source.csv').trim();
    const archive = updateArchive({ source_filename: original || 'source.csv', source_uploaded_at: nowIso() });
    return res.json({ status: 'ok', archive, columns: parsed.columns, count: parsed.count });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/identified-access', (req, res) => {
  res.json({ status: 'ok', ...identifiedAccessStatus(req) });
});

router.get('/research/archive/patient-history', (req, res) => {
  const startedAt = Date.now();
  try {
    if (researchResponseShouldRedact(req)) {
      const err = new Error('Tra cứu người bệnh trả dữ liệu có định danh (họ tên, lịch sử điều trị). Cần thêm identified=1, vai trò supervisor/admin, và bật EMR_ALLOW_IDENTIFIED_RESEARCH_EXPORT=1.');
      err.status = 403;
      throw err;
    }
    const runId = resolveArchiveRunId(String(req.query.runId || 'latest'));
    const runDir = runId ? path.join(archiveRunsDir(), runId) : '';
    const data = buildPatientHistory(runDir, String(req.query.q || ''));
    const elapsed = Date.now() - startedAt;
    // Không in từ khóa tra cứu (có thể là họ tên/Mã BN) ra console.
    if (elapsed > 1200) console.warn(`[RESEARCH][LOOKUP] ${elapsed}ms | q_len=${String(req.query.q || '').length} | source=${data.data_source || '?'}`);

    // Không bao giờ trả một response lịch sử quá lớn làm Express/V8 lỗi Invalid string length.
    let eventRows = 0;
    for (const patient of data.patients || []) {
      for (const enc of patient.encounters || []) {
        eventRows += Number(enc?.labs?.length || 0)
          + Number(enc?.imaging?.length || 0)
          + Number(enc?.medications?.length || 0)
          + Number(enc?.surgeries?.length || 0);
      }
    }
    if (eventRows > 12000) {
      return res.status(413).json({
        status: 'error',
        code: 'RESEARCH_LOOKUP_TOO_LARGE',
        message: 'Kết quả chi tiết quá lớn. Hãy tra cứu bằng mã BN/mã NC cụ thể hơn.',
        candidate_count: Number(data.total_matches || 0),
      });
    }
    return res.json({ status: 'ok', run_id: runId || '', ...data, request_ms: elapsed });
  } catch (err) {
    // Khóa định danh là trạng thái cấu hình, không phải lỗi: không in stack ra console.
    if (!String(err.code || '').startsWith('IDENTIFIED_ACCESS_')) console.error('[RESEARCH][LOOKUP][ERROR]', err);
    return res.status(err.status || 400).json({ status: 'error', code: err.code || '', message: String(err.message || err) });
  }
});

router.get('/research/archive/variable-catalog', (req, res) => {
  try {
    const redact = researchResponseShouldRedact(req);
    const runId = resolveArchiveRunId(String(req.query.runId || 'latest'));
    const runDir = runId ? path.join(archiveRunsDir(), runId) : '';
    const catalog = buildVariableCatalog(runDir, { redact });
    return res.json({ status: 'ok', run_id: runId || '', redacted: redact, catalog });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

// Gợi ý đề tài từ dữ liệu đang có trong kho (nhóm người bệnh đủ lớn + biến + điều kiện).
router.get('/research/archive/study-suggestions', (req, res) => {
  try {
    const runId = resolveArchiveRunId(String(req.query.runId || 'latest'));
    const runDir = runId ? path.join(archiveRunsDir(), runId) : '';
    if (!runDir || !fs.existsSync(runDir)) return res.json({ status: 'ok', suggestions: [], total_encounters: 0 });
    return res.json({ status: 'ok', ...buildStudySuggestions(runDir) });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

// Nhật ký quy trình dữ liệu (quét → thu thập → chuẩn hóa → lưu) cho tab Tổng quát.
router.get('/research/archive/pipeline', (req, res) => {
  try {
    const runId = resolveArchiveRunId(String(req.query.runId || 'latest'));
    const runDir = runId ? path.join(archiveRunsDir(), runId) : '';
    return res.json({ status: 'ok', pipeline: buildPipelineInfo(archiveDir(), runDir) });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.post('/research/archive/variable-preview', (req, res) => {
  try {
    const selection = sanitizeVariableSelection(req.body?.variable_selection || req.body || {});
    if (!selection.selected_variables?.length) return res.status(400).json({ status: 'error', message: 'Chọn ít nhất 1 biến để xem trước.' });
    const runId = resolveArchiveRunId(String(selection.run_id || req.body?.runId || 'latest'));
    const runDir = runId ? path.join(archiveRunsDir(), runId) : '';
    if (!runDir || !fs.existsSync(runDir)) return res.status(400).json({ status: 'error', message: 'Chưa có dữ liệu chuẩn hóa để xem trước.' });

    const startedAt = Date.now();
    const { dataset, summary, source_total: sourceTotal, source_limited: sourceLimited } = summarizeSelectionForRun(runDir, selection, {
      maxEncounters: VARIABLE_PREVIEW_MAX_ENCOUNTERS,
      maxSourceRows: VARIABLE_PREVIEW_MAX_SOURCE_ROWS,
    });
    const redact = researchResponseShouldRedact(req);
    const sensitiveOutput = new Set(dataset.manifest.variables
      .filter(variable => redact && isSensitiveColumn(variable.name))
      .map(variable => variable.output_column));
    const redacted = redact
      ? redactCsvTable(dataset.columns.filter(column => !sensitiveOutput.has(column)), dataset.rows, EXPORT_SENSITIVE_COLUMNS)
      : { columns: dataset.columns, rows: dataset.rows, removed_columns: [] };
    const limit = Math.max(1, Math.min(100, Number(req.body?.limit || 20)));
    return res.json({
      status: 'ok',
      run_id: runId,
      redacted: redact,
      summary,
      variables: dataset.manifest.variables,
      columns: redacted.columns,
      // Màn hình Tạo nghiên cứu chỉ hiện thống kê; dữ liệu từng lượt chỉ trả khi được yêu cầu rõ.
      rows: req.body?.include_rows ? redacted.rows.slice(0, limit) : [],
      preview_limit: limit,
      source_total: sourceTotal,
      source_limited: sourceLimited,
      elapsed_ms: Date.now() - startedAt,
      removed_columns: [...(redacted.removed_columns || []), ...sensitiveOutput],
    });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

// Xuất dữ liệu ngay từ kho theo danh sách biến + điều kiện (không cần tạo nghiên cứu, không
// quét lại EMR). Mỗi lượt điều trị đạt điều kiện một dòng; cột biến đặt theo tên trên phiếu
// khảo sát; luôn ẩn định danh (cột định danh bị loại cả theo tên biến gốc lẫn tên mới).
// Chỉ giữ cột nhận diện dòng; còn lại đúng các biến người dùng đã chọn (không lặp tuổi/giới...).
const EXPORT_BASE_HEADERS = {
  research_code: 'Mã NC', patient_key: 'Mã người bệnh (giả danh)', anchor_datetime: 'Thời điểm mốc',
};
router.post('/research/archive/variable-export', (req, res) => {
  try {
    const selection = sanitizeVariableSelection(req.body?.variable_selection || req.body || {});
    if (!selection.selected_variables?.length) return res.status(400).json({ status: 'error', message: 'Chọn ít nhất 1 biến để xuất.' });
    const runId = resolveArchiveRunId(String(selection.run_id || 'latest'));
    const runDir = runId ? path.join(archiveRunsDir(), runId) : '';
    if (!runDir || !fs.existsSync(runDir)) return res.status(400).json({ status: 'error', message: 'Kho chưa có dữ liệu chuẩn hóa để xuất.' });
    const { dataset } = summarizeSelectionForRun(runDir, selection);
    const sensitive = new Set(dataset.manifest.variables.filter(v => isSensitiveColumn(v.name)).map(v => v.output_column));
    const used = new Set();
    const header = (col) => {
      const variable = dataset.manifest.variables.find(v => v.output_column === col);
      let name = String((variable ? (variable.survey_label || variable.label) : EXPORT_BASE_HEADERS[col]) || col).trim() || col;
      for (let i = 2; used.has(name); i += 1) name = `${variable?.survey_label || col} (${i})`;
      used.add(name);
      return name;
    };
    const keep = dataset.columns.filter(col => !sensitive.has(col) && (EXPORT_BASE_HEADERS[col] || dataset.manifest.variables.some(v => v.output_column === col)));
    const headers = keep.map(header);
    const rows = dataset.rows.map(row => Object.fromEntries(keep.map((col, i) => [headers[i], row[col] ?? ''])));
    const file = path.join(runDir, `.variable_export_${process.pid}_${Date.now()}.csv`);
    writeCsv(file, headers, rows);
    appendSecurityAudit({
      kind: 'research.variable_export',
      actor: { id: String(req.auth?.id || ''), role: String(req.auth?.role || '') },
      scope: { run_id: runId, variables: selection.selected_variables.length, conditions: (selection.conditions || []).length, rows: rows.length },
    });
    const name = String(req.body?.name || 'du_lieu_nghien_cuu').slice(0, 80);
    res.on('finish', () => fs.unlink(file, () => {}));
    res.on('close', () => fs.unlink(file, () => {}));
    return sendCsvFile(res, file, `${name}_${runId}`, { redact: true });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/archive/data', (req, res) => {
  try {
    const archive = readArchive();
    const tableKey = TABLES[req.query.table] ? String(req.query.table) : 'patients';
    const runId = resolveArchiveRunId(String(req.query.runId || 'latest'));
    const filePath = archiveTablePath(tableKey, runId || 'latest');
    const data = filePath ? readCsvTable(filePath, MAX_TABLE_ROWS) : { columns: [], rows: [], count: 0, limited: false, exists: false };
    const displayRows = sortRowsForTable(tableKey, data.rows);
    const redact = researchResponseShouldRedact(req);
    const output = redact ? redactCsvTable(data.columns, displayRows, EXPORT_SENSITIVE_COLUMNS) : { columns: data.columns, rows: displayRows, removed_columns: [] };
    return res.json({
      status: 'ok',
      archive,
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

router.get('/research/archive/export', (req, res) => {
  try {
    const tableKey = TABLES[req.query.table] ? String(req.query.table) : 'analysis_ready';
    const runId = resolveArchiveRunId(String(req.query.runId || 'latest'));
    const filePath = archiveTablePath(tableKey, runId || 'latest');
    return sendCsvFile(res, filePath, `archive_${runId || 'latest'}_${tableKey}`, { redact: researchResponseShouldRedact(req) });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/archive/coverage', (req, res) => {
  try {
    const runId = resolveArchiveRunId(String(req.query.runId || 'latest'));
    const runDir = runId ? path.join(archiveRunsDir(), runId) : '';
    return res.json({ status: 'ok', coverage: buildCoverageSummary(runDir) });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/data-dictionary', (_req, res) => {
  return res.json({
    status: 'ok',
    version: dataDictionary.DICTIONARY_VERSION,
    conventions: dataDictionary.CONVENTIONS,
    tables: dataDictionary.TABLES,
    raw_tables: dataDictionary.RAW_TABLES,
    known_issues: dataDictionary.KNOWN_ISSUES,
  });
});

router.get('/research/archive/datasets', (req, res) => {
  try {
    const runId = resolveArchiveRunId(String(req.query.runId || 'latest'));
    const runDir = runId ? path.join(archiveRunsDir(), runId) : '';
    return res.json({ status: 'ok', run_id: runId || '', datasets: runDir ? listDatasetSnapshots(runDir) : [] });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/archive/datasets/verify', (req, res) => {
  try {
    const runId = resolveArchiveRunId(String(req.query.runId || 'latest'));
    return res.json(datasetVerifyResponse(runId, runId ? path.join(archiveRunsDir(), runId) : ''));
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});
router.use(require('./research_studies'));

// Tác vụ đang chạy của kho và các nghiên cứu (nhẹ: đọc khóa trong bộ nhớ và file trạng thái).
router.get('/research/running', (_req, res) => {
  try {
    const running = listRunningResearch((key, lane) => {
      const studyId = key.startsWith('study:') ? key.slice(6) : '';
      // key là phạm vi (đã bỏ hậu tố làn); task chỉ là của Thu thập, tiến độ chuẩn hóa đọc riêng.
      let runDir = '';
      let studyName = '';
      if (studyId) {
        studyName = String(readStudy(studyId)?.name || '');
        const runId = resolveStudyRunIdFast(studyId, 'latest');
        runDir = runId ? path.join(runsDir(studyId), runId) : '';
      } else {
        const runId = resolveArchiveRunIdFast('latest');
        runDir = runId ? path.join(archiveRunsDir(), runId) : '';
      }
      const task = runDir ? activeResearchTask(runDir) : null;
      // Chuẩn hóa ghi bước đang chạy (từ tiến trình con) vào normalize_state.json.
      const normState = runDir ? readJsonSafe(path.join(runDir, 'normalize_state.json'), null) : null;
      return {
        study_name: studyName,
        normalize: lane === 'normalize' && normState?.status === 'running' ? {
          stage: String(normState.stage || 'Bắt đầu'), stage_index: Number(normState.stage_index || 0),
          stage_total: Number(normState.stage_total || 8), started_at: String(normState.started_at || ''),
        } : null,
        task: task && lane !== 'normalize' ? { label: task.label, status: task.status, message: task.message || '', summary: task.summary || {}, heartbeat_at: task.heartbeat_at || '' } : null,
        // Ca đang lấy + lần ghi tiến độ gần nhất (không phải câu thông báo lúc bắt đầu).
        progress: runDir && lane !== 'normalize' ? readLiveProgress(runDir) : null,
      };
    });
    return res.json({ status: 'ok', running, server_time: nowIso() });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

// Kênh sự kiện (/api/events) báo khi danh sách tác vụ đang chạy đổi: giao diện không phải hỏi theo giờ.
setRunningSignature(() => [...RESEARCH_SCOPE_LOCKS.entries()].map(([k, v]) => `${k}|${v?.label || ''}|${v?.since || ''}`).sort().join(';'));

router.get('/research/archive/progress', (req, res) => {
  try {
    const runId = resolveArchiveRunIdFast(String(req.query.runId || 'latest'));
    const archive = readArchiveProgressMeta(runId);
    const runDir = runId ? path.join(archiveRunsDir(), runId) : '';
    watchResearchScope('archive', runDir);
    const progress = withScopeRunning(buildResearchProgressSnapshot(runDir, archive, { isArchive: true }), 'archive');
    return res.json({ status: 'ok', run_id: runId || '', progress });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute(router, 'post', '/research/archive/finalize-dataset', 'Tạo dataset cuối', (_req, res) => {
  try {
    const runId = resolveArchiveRunIdForAction('latest');
    if (!runId) return res.status(400).json({ status: 'error', message: 'Kho gốc chưa có run.' });
    const result = finalizeAnalysisDataset(path.join(archiveRunsDir(), runId));
    const archive = updateArchive({ last_finalized_at: nowIso() });
    return res.json({ status: 'ok', message: `Đã tạo analysis_final.csv (${result.count} dòng).`, archive, ...result });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err), coverage: err.coverage || undefined });
  }
});

lockedResearchRoute(router, 'post', '/research/archive/build-encoded-dataset', 'Tạo dataset mã hóa', (_req, res) => {
  try {
    const runId = resolveArchiveRunIdForAction('latest');
    if (!runId) return res.status(400).json({ status: 'error', message: 'Kho gốc chưa có run.' });
    const result = buildEncodedDataset(path.join(archiveRunsDir(), runId));
    const archive = updateArchive({ last_encoded_at: nowIso() });
    return res.json({ status: 'ok', message: `Đã tạo/cập nhật dữ liệu encoded cho ${runId}.`, archive, ...result });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute(router, 'post', '/research/archive/clean-generated', 'Dọn dữ liệu sinh ra', (req, res) => {
  try {
    const runId = resolveArchiveRunIdForAction('latest');
    if (!runId) return res.status(400).json({ status: 'error', message: 'Kho gốc chưa có run.' });
    const result = cleanResearchGenerated(path.join(archiveRunsDir(), runId), {
      encoded: req.body?.encoded !== false,
      debug: req.body?.debug !== false,
      derived: req.body?.derived === true,
    });
    const archive = updateArchive({ last_cleaned_at: nowIso() });
    return res.json({ status: 'ok', message: `Đã dọn file phụ cho ${runId}.`, archive, run_id: runId, ...result });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/archive/log', (req, res) => {
  try {
    const runId = resolveArchiveRunId(String(req.query.runId || 'latest'));
    if (!runId) return res.json({ status: 'ok', lines: [], run_id: '' });
    const logPath = path.join(archiveRunsDir(), runId, 'action_log.txt');
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

router.get('/research/archive/case-trace', (req, res) => {
  try {
    const runId = resolveArchiveRunId(String(req.query.runId || 'latest'));
    if (!runId) return res.json({ status: 'ok', cases: [], run_id: '' });
    const runDir = path.join(archiveRunsDir(), runId);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit || CASE_TRACE_RECENT_LIMIT)));
    const cases = readResearchCaseTrace(runDir, limit);
    const redact = researchResponseShouldRedact(req);
    return res.json({ status: 'ok', run_id: runId, cases: redact ? redactCaseTracePayload(cases) : cases, limit, redacted: redact });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

// Chuẩn hóa có khóa riêng (không dùng khóa Thu thập): đang thu thập vẫn chuẩn hóa được và ngược lại.
// Mỗi lúc một lần chuẩn hóa; chạy ở tiến trình riêng nên máy chủ không bị treo.
router.post('/research/archive/normalize', async (_req, res) => {
  try {
    const busy = normalizeRunning('archive');
    if (busy) return res.status(409).json({ status: 'error', code: 'NORMALIZE_BUSY', message: `Đang chuẩn hóa kho (từ ${busy.since}). Chờ lần này xong rồi chạy lại nếu cần.` });
    const result = await runNormalizeJob({ kind: 'archive' });
    const archive = result.counts?.cached ? readArchive() : updateArchive({ last_normalized_at: nowIso() });
    return res.json({ status: 'ok', message: result.counts?.cached ? 'Dữ liệu đã chuẩn hóa sẵn, không cần chạy lại.' : `Đã chuẩn hóa kho dữ liệu gốc.${khoOverlayNote(result.counts)}`, archive, ...result });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute(router, 'post', '/research/archive/import-hchanh', 'Nạp dữ liệu hành chánh', (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const runId = resolveArchiveRunId(String(req.body?.runId || 'latest')) || safeRunId(req.body?.runId) || nowFileStamp();
    if (!runId) return res.status(400).json({ status: 'error', message: 'Kho dữ liệu gốc chưa có run để gộp dữ liệu hành chánh.' });
    const runDir = path.join(archiveRunsDir(), runId);
    ensureDir(runDir);
    const imported = flattenHchanhIntoResearchRun(ctx, runDir);
    const normalized = normalizeRunOutputs(runDir, { sourceRunId: runId });
    const archive = updateArchive({ last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso(), last_hchanh_import_at: nowIso() });
    return res.json({
      status: 'ok',
      message: `Đã gộp dữ liệu hành chánh vào kho nghiên cứu: nền=${imported.profile}, ra viện=${imported.discharge}, phẫu thuật=${imported.surgery}, y lệnh=${imported.order_history}.`,
      archive,
      run_id: runId,
      imported,
      normalized,
    });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute(router, 'post', '/research/archive/fetch-hchanh', 'Lấy dữ liệu hành chánh', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const archive = readArchive();
    const runId = resolveArchiveRunIdForAction(req.body?.runId || 'latest');
    if (!runId) return res.status(400).json({ status: 'error', message: 'Kho dữ liệu gốc chưa có run. Hãy chạy Bước 1 — Quét danh sách trước.' });
    const runDir = path.join(archiveRunsDir(), runId);
    const effectiveFromDate = String(req.body?.fromDate || archive.scan_from_date || '').trim();
    const effectiveToDate = String(req.body?.toDate || archive.scan_to_date || todayDateInput()).trim();
    const sourceInfo = readResearchHchanhSourceRows(runDir, archiveSourcePath(), {
      sourceRunId: runId,
      dateDefaults: { from_date: effectiveFromDate, to_date: effectiveToDate },
    });
    const { rows, file, base_file: baseFile, date_context: dateContext } = sourceInfo;
    if (!rows.length) return res.status(400).json({ status: 'error', message: `Không tìm thấy danh sách Mã BN để lấy hành chánh tự động trong run ${runId}. Hãy kiểm tra đã có du_lieu_ban_dau.csv/cohort.csv hoặc bấm Bước 1 trước.` });

    const files = hchanhDefaultFiles(req.body?.files);
    const limit = Number.isFinite(Number(req.body?.limit)) ? Math.max(0, Math.trunc(Number(req.body.limit))) : 0;
    updateArchive({ active_run_id: runId, active_mode: 'hchanh_auto' });

    await enqueueHeavy(ctx.sid, async () => {
      try {
        const fetched = await fetchHchanhForResearchRun(ctx, runDir, {
          sourceRows: rows,
          sourceRunId: runId,
          files,
          headless: researchHeadlessFromBody(req.body),
          force: req.body?.force === true,
          refreshProvisional: req.body?.refreshProvisional === true,
          fallbackDateFrom: dateContext?.from_date || effectiveFromDate || '',
          fallbackDateTo: dateContext?.to_date || effectiveToDate || todayDateInput(),
          limit,
          mode: 'hchanh_auto',
        });
        const normalized = normalizeRunOutputs(runDir, { sourceRunId: runId });
        const updated = updateArchive({
          last_run_id: runId,
          last_run_at: nowIso(),
          last_normalized_at: nowIso(),
          last_hchanh_auto_at: nowIso(),
          active_run_id: '',
          active_mode: '',
        });
        return res.json({
          status: 'ok',
          message: `Đã tự động lấy hành chánh từ EMR: xử lý=${fetched.processed}, bỏ qua=${fetched.skipped}, OK=${fetched.ok}, cần xem=${fetched.attention}, lỗi=${fetched.error}.`,
          archive: updated,
          run_id: runId,
          source_file: path.basename(file || ''),
          source_base_file: path.basename(baseFile || ''),
          source_date_from: dateContext?.from_date || '',
          source_date_to: dateContext?.to_date || '',
          fetched,
          normalized,
        });
      } catch (err) {
        updateArchive({ active_run_id: '', active_mode: '', stopped_at: nowIso() });
        throw err;
      }
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute(router, 'post', '/research/archive/fetch-order-history', 'Lấy lịch sử y lệnh', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const archive = readArchive();
    const runId = resolveArchiveRunIdForAction(req.body?.runId || 'latest');
    if (!runId) return res.status(400).json({ status: 'error', message: 'Kho dữ liệu gốc chưa có run. Hãy chạy Bước 1 — Quét danh sách trước.' });
    const runDir = path.join(archiveRunsDir(), runId);
    const effectiveFromDate = String(req.body?.fromDate || archive.scan_from_date || '').trim();
    const effectiveToDate = String(req.body?.toDate || archive.scan_to_date || todayDateInput()).trim();
    const sourceInfo = readResearchHchanhSourceRows(runDir, archiveSourcePath(), {
      sourceRunId: runId,
      dateDefaults: { from_date: effectiveFromDate, to_date: effectiveToDate },
    });
    const { rows, file, base_file: baseFile, date_context: dateContext } = sourceInfo;
    if (!rows.length) return res.status(400).json({ status: 'error', message: `Không tìm thấy danh sách Mã BN để lấy lịch sử y lệnh trong run ${runId}. Hãy kiểm tra đã có du_lieu_ban_dau.csv/cohort.csv hoặc bấm Bước 1 trước.` });

    const files = orderHistoryDefaultFiles(req.body?.files);
    const limit = Number.isFinite(Number(req.body?.limit)) ? Math.max(0, Math.trunc(Number(req.body.limit))) : 0;
    updateArchive({ active_run_id: runId, active_mode: 'order_history_auto' });

    await enqueueHeavy(ctx.sid, async () => {
      try {
        const fetched = await fetchHchanhForResearchRun(ctx, runDir, {
          sourceRows: rows,
          sourceRunId: runId,
          files,
          headless: researchHeadlessFromBody(req.body),
          force: req.body?.force === true,
          refreshProvisional: req.body?.refreshProvisional === true,
          fallbackDateFrom: dateContext?.from_date || effectiveFromDate || '',
          fallbackDateTo: dateContext?.to_date || effectiveToDate || todayDateInput(),
          limit,
          mode: 'order_history_auto',
        });
        const normalized = normalizeRunOutputs(runDir, { sourceRunId: runId });
        const updated = updateArchive({
          last_run_id: runId,
          last_run_at: nowIso(),
          last_normalized_at: nowIso(),
          last_order_history_auto_at: nowIso(),
          active_run_id: '',
          active_mode: '',
        });
        return res.json({
          status: 'ok',
          message: `Đã tự động lấy ${orderHistoryRunLabel(files)} từ EMR: xử lý=${fetched.processed}, bỏ qua=${fetched.skipped}, OK=${fetched.ok}, cần xem=${fetched.attention}, lỗi=${fetched.error}.`,
          archive: updated,
          run_id: runId,
          source_file: path.basename(file || ''),
          source_base_file: path.basename(baseFile || ''),
          source_date_from: dateContext?.from_date || '',
          source_date_to: dateContext?.to_date || '',
          fetched,
          normalized,
        });
      } catch (err) {
        updateArchive({ active_run_id: '', active_mode: '', stopped_at: nowIso() });
        throw err;
      }
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute(router, 'post', '/research/archive/patient-info', 'Lấy thông tin người bệnh', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const archive = readArchive();
    if (!fs.existsSync(SCRIPT_PATH)) return res.status(500).json({ status: 'error', message: 'Thiếu script lấy dữ liệu nghiên cứu.' });
    const effectiveFromDate = String(req.body?.fromDate || archive.scan_from_date || '').trim();
    const effectiveToDate = String(req.body?.toDate || archive.scan_to_date || todayDateInput()).trim();
    const runId = safeRunId(req.body?.runId || archive.latest_run?.id || chooseArchiveRunIdForResume({ fromDate: effectiveFromDate, toDate: effectiveToDate }) || nowFileStamp()) || nowFileStamp();
    const runDir = path.join(archiveRunsDir(), runId);
    const sourceInfo = readResearchHchanhSourceRows(runDir, archiveSourcePath(), {
      sourceRunId: runId,
      dateDefaults: { from_date: effectiveFromDate, to_date: effectiveToDate },
    });
    const inputPath = sourceInfo.file;
    if (!inputPath || !fs.existsSync(inputPath)) {
      return res.status(400).json({ status: 'error', message: 'Chưa có danh sách Mã BN. Hãy chạy Bước 1 — Quét danh sách trước.' });
    }
    const args = [
      '-u', SCRIPT_PATH,
      '--input', inputPath,
      '--project-id', ARCHIVE_ID,
      '--run-id', runId,
      '--out-root', RESEARCH_STORE_DIR,
      '--patient-info-only',
    ];
    if (effectiveFromDate) args.push('--from-date', effectiveFromDate);
    if (effectiveToDate) args.push('--to-date', effectiveToDate);
    if (researchHeadlessFromBody(req.body)) args.push('--headless');
    updateArchive({ active_run_id: runId, active_mode: 'patient_info' });

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
        const normalized = normalizeRunOutputs(path.join(archiveRunsDir(), runId), { sourceRunId: runId });
        const updated = updateArchive({ last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso(), stopped_at: nowIso(), active_run_id: '', active_mode: '' });
        return res.json({ status: 'ok', stopped: true, message: 'Đã dừng. Thông tin khác đã lấy vẫn được giữ; bấm lại để chạy tiếp.', archive: updated, run_id: runId, normalized });
      }
      if (result.code !== 0) return res.status(500).json({ status: 'error', message: fmtPyError('Python lỗi khi lấy thông tin khác từ D/s Bệnh nhân. Dữ liệu đã lưu nếu chạy được một phần.', result) });

      const normalized = normalizeRunOutputs(path.join(archiveRunsDir(), runId), { sourceRunId: runId });
      const updated = updateArchive({ last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso(), active_run_id: '', active_mode: '' });
      return res.json({ status: 'ok', message: 'Đã lấy thông tin khác: Điện thoại, Số CMND/CCCD, BHYT, địa chỉ từ D/s Bệnh nhân.', archive: updated, run_id: runId, normalized });
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute(router, 'post', '/research/archive/run', 'Lấy dữ liệu', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const archive = readArchive();
    if (!fs.existsSync(SCRIPT_PATH)) return res.status(500).json({ status: 'error', message: 'Thiếu script lấy dữ liệu nghiên cứu.' });

    const mode = String(req.body?.mode || '').toLowerCase();
    const deep = req.body?.deep === true || mode === 'deep';
    const fromDate = String(req.body?.fromDate || '2026-01-01').trim();
    const toDate = String(req.body?.toDate || todayDateInput()).trim();
    const runId = safeRunId(req.body?.runId || (deep
      ? (archive.latest_run?.id || chooseArchiveRunIdForResume({ fromDate, toDate }) || nowFileStamp())
      : (req.body?.resume === false ? nowFileStamp() : chooseArchiveRunIdForResume({ fromDate, toDate }))
    )) || nowFileStamp();
    const initialListPath = archiveTablePath('initial_list', runId);
    const inputPath = deep ? initialListPath : archiveSourcePath();
    if (deep && (!inputPath || !fs.existsSync(inputPath))) {
      return res.status(400).json({ status: 'error', message: 'Chưa có du_lieu_ban_dau.csv. Hãy chạy Bước 1 trước.' });
    }
    const args = [
      '-u', SCRIPT_PATH,
      '--input', inputPath,
      '--project-id', ARCHIVE_ID,
      '--run-id', runId,
      '--out-root', RESEARCH_STORE_DIR,
    ];
    if (!deep) args.push('--list-only');
    if (deep && initialListPath) args.push('--archive-initial-list', initialListPath);
    const rescanRecentDays = Number.isFinite(Number(req.body?.rescanRecentDays))
      ? Math.max(0, Math.min(30, Math.trunc(Number(req.body.rescanRecentDays))))
      : 7;
    if (fromDate) args.push('--from-date', fromDate);
    if (toDate) args.push('--to-date', toDate);
    if (!deep) args.push('--rescan-recent-days', String(rescanRecentDays));
    if (researchHeadlessFromBody(req.body)) args.push('--headless');
    updateArchive({ scan_from_date: fromDate, scan_to_date: toDate, active_run_id: runId, active_mode: deep ? 'deep' : 'initial' });

    await enqueueHeavy(ctx.sid, async () => {
      try {
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
      const normalizeCurrentArchiveRun = () => {
        const currentRunDir = path.join(archiveRunsDir(), runId);
        // Bước 1 vừa thay đổi du_lieu_ban_dau.csv: luôn dựng lại nguồn chuẩn trước
        // khi normalize để progress/các bước sau không tiếp tục dùng mẫu cũ.
        if (!deep) {
          ensureResearchSourceRows(currentRunDir, {
            sourceRunId: runId,
            dateDefaults: { from_date: fromDate, to_date: toDate },
            force: true,
          });
        }
        return normalizeRunOutputs(currentRunDir, { sourceRunId: runId });
      };
      if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: deep ? 'Timeout khi cập nhật dữ liệu gốc. Tiến độ đã lưu, bấm Bước 3 để chạy tiếp.' : 'Timeout khi quét danh sách ban đầu. Tiến độ đã lưu, bấm Bước 1 để chạy tiếp.' });
      if (isStoppedRunResult(result)) {
        const normalized = normalizeCurrentArchiveRun();
        const updated = updateArchive({ last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso(), stopped_at: nowIso() });
        return res.json({ status: 'ok', stopped: true, message: deep ? 'Đã dừng. Dữ liệu sâu đã commit vẫn được giữ; lần sau bấm Bước 3 để chạy tiếp.' : 'Đã dừng. Các trang đã quét xong đã lưu vào du_lieu_ban_dau.csv; lần sau bấm Bước 1 để quét lại và bỏ qua dòng đã có.', archive: updated, run_id: runId, normalized });
      }
      if (result.code !== 0) return res.status(500).json({ status: 'error', message: fmtPyError(deep ? 'Python lỗi khi cập nhật dữ liệu gốc. Tiến độ đã lưu nếu đã chạy được một phần.' : 'Python lỗi khi quét dữ liệu ban đầu. Tiến độ đã lưu nếu đã chạy được một phần.', result) });

      const normalized = normalizeCurrentArchiveRun();
      const updated = updateArchive({ last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso(), active_run_id: '', active_mode: '' });
        return res.json({ status: 'ok', message: deep ? 'Đã cập nhật dữ liệu gốc: lấy sâu từ du_lieu_ban_dau.csv, gộp/xóa các dòng đã nằm trong cùng đợt điều trị và chuẩn hóa.' : 'Đã quét dữ liệu ban đầu từ bảng Hoàn tất và chuẩn hóa dữ liệu gốc.', archive: updated, run_id: runId, normalized });
      } finally {
        updateArchive({ active_run_id: '', active_mode: '' });
      }
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

// ── Lấy lại chỗ thiếu ────────────────────────────────────────────────────────
// Đọc extract_status.csv, lọc BN còn thiếu loại dữ liệu nào, gọi đúng fetcher.
// scope = 'archive' | studyId
// missingTypes = ['xn_cdha', 'profile', 'discharge', 'surgery', 'order_history'] (mảng)
lockedResearchRoute(router, 'post', '/research/refetch-missing', 'Lấy lại chỗ thiếu', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const rawScope     = String(req.body?.scope || ARCHIVE_ID).trim();
    const isArc        = rawScope === ARCHIVE_ID || rawScope === '__archive__' || rawScope === 'archive';
    const scope        = isArc ? ARCHIVE_ID : rawScope;
    const missingTypes = Array.isArray(req.body?.missingTypes) ? req.body.missingTypes : [];
    const headless     = researchHeadlessFromBody(req.body);
    const force        = req.body?.force === true;

    if (!missingTypes.length) {
      return res.status(400).json({ status: 'error', message: 'Cần chỉ định missingTypes cần lấy lại.' });
    }

    // Xác định runDir
    let runDir, runId, sourceRowsForHchanh, fallbackFrom, fallbackTo;
    if (isArc) {
      const archive = readArchive();
      runId = resolveArchiveRunIdForAction('latest');
      if (!runId) return res.status(400).json({ status: 'error', message: 'Kho gốc chưa có run. Chạy Bước 1 trước.' });
      runDir = path.join(archiveRunsDir(), runId);
      fallbackFrom = String(req.body?.fromDate || archive.scan_from_date || '').trim();
      fallbackTo   = String(req.body?.toDate || archive.scan_to_date || todayDateInput()).trim();
      const srcInfo = readResearchHchanhSourceRows(runDir, archiveSourcePath(), {
        sourceRunId: runId,
        dateDefaults: { from_date: fallbackFrom, to_date: fallbackTo },
      });
      sourceRowsForHchanh = srcInfo.rows;
    } else {
      const study = readStudy(scope);
      if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
      runId = resolveRunId(study.id, 'latest');
      if (!runId) return res.status(400).json({ status: 'error', message: 'Nghiên cứu chưa có run.' });
      runDir = path.join(runsDir(study.id), runId);
      fallbackFrom = String(req.body?.fromDate || '').trim();
      fallbackTo   = String(req.body?.toDate || todayDateInput()).trim();
      const srcInfo = readResearchHchanhSourceRows(runDir, cohortPath(study.id), { sourceRunId: runId });
      sourceRowsForHchanh = srcInfo.rows;
    }

    // Đọc extract_status để lọc BN thiếu
    const statusTable = readCsvTable(path.join(runDir, 'extract_status.csv'), Number.MAX_SAFE_INTEGER);

    // Xác định BN cần lấy lại cho từng nhóm
    const needXnCdha = missingTypes.includes('xn_cdha');
    const hchanhFiles = missingTypes.filter(t => ['profile', 'discharge', 'surgery', 'order_history'].includes(t));

    // BN/lượt cần lấy lại XN/CĐHA: thiếu popup, XN hoặc CĐHA. Giữ cả Mã NC để tránh nhầm nhiều lần nhập viện.
    const missingXnCdhaRows = needXnCdha
      ? statusTable.rows.filter(r => isRowMissingXnCdha(r))
      : [];
    const missingXnCdha = [...new Set(missingXnCdhaRows.map(r => String(r.patient_code || r['Mã BN'] || '').trim()).filter(Boolean))];

    // BN cần lấy lại hành chánh: bất kỳ file nào trong hchanhFiles chưa done.
    // Khớp thêm Mã NC khi có để tránh đọc nhầm trạng thái của một đợt nhập
    // viện khác cùng mã BN (một mã BN có thể có nhiều dòng extract_status
    // ứng với nhiều lần nhập viện).
    const missingHchanhRows = hchanhFiles.length
      ? sourceRowsForHchanh.filter(row => {
          const code = patientCode(row);
          const rc = rowResearchCode(row);
          const st = rc
            ? statusTable.rows.find(r => r.patient_code === code && rowResearchCode(r) === rc)
            : statusTable.rows.find(r => r.patient_code === code);
          if (!st) return true; // chưa có trong extract_status → chưa lấy
          return hchanhFiles.some(f => {
            const col = `${f}_status`;
            return st[col] !== 'done';
          });
        })
      : [];

    const summary = {
      xn_cdha_patients: missingXnCdha.length,
      hchanh_patients: missingHchanhRows.length,
      hchanh_files: hchanhFiles,
    };

    if (!missingXnCdha.length && !missingHchanhRows.length) {
      return res.json({ status: 'ok', message: 'Không có dữ liệu còn thiếu cho các loại đã chọn.', summary });
    }

    // Người dùng đang chủ động chạy tiếp phần còn thiếu: bỏ cảnh báo fatal cũ.
    // Nếu lần chạy mới gặp fatal thật, worker sẽ ghi lại fatal_alert.json.
    try {
      const oldAlertPath = path.join(runDir, 'fatal_alert.json');
      if (fs.existsSync(oldAlertPath)) fs.unlinkSync(oldAlertPath);
    } catch (_) {}

    const task = beginResearchTask(runDir, {
      type: 'refetch_missing',
      label: 'Bổ sung dữ liệu còn thiếu',
      status: 'queued',
      scope,
      run_id: runId,
      missing_types: missingTypes,
      summary,
      message: `Đã nhận yêu cầu bổ sung: XN/CĐHA=${summary.xn_cdha_patients}, hành chánh=${summary.hchanh_patients}.`,
    });

    await enqueueHeavy(ctx.sid, async () => {
      updateResearchTask(runDir, task.id, {
        status: 'running',
        message: 'Đang chạy bổ sung dữ liệu còn thiếu.',
      });
      const results = {};
      try {

      const finishCancelled = () => {
        const normalized = normalizeRunOutputs(runDir, { sourceRunId: runId });
        if (isArc) {
          updateArchive({ last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso(), stopped_at: nowIso() });
        } else {
          updateStudy(scope, { last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso(), stopped_at: nowIso() });
        }
        const message = 'Đã dừng theo yêu cầu. Dữ liệu đã lấy xong vẫn được giữ; bấm Cập nhật để chạy tiếp phần còn thiếu.';
        finishResearchTask(runDir, task.id, 'cancelled', {
          message,
          summary,
          results,
        });
        appendResearchRunLog(runDir, `[REFETCH_MISSING] ${message}`);
        return res.json({
          status: 'ok',
          stopped: true,
          cancelled: true,
          message,
          summary,
          results,
          normalized,
        });
      };

      // Có thể người dùng bấm Dừng lúc job còn chờ heavy slot; không được bắt đầu worker đầu tiên.
      if (isCancelRequested(ctx.sid)) return finishCancelled();

      // Lấy lại hành chánh cho BN thiếu
      if (missingHchanhRows.length && hchanhFiles.length) {
        const fetched = await fetchHchanhForResearchRun(ctx, runDir, {
          sourceRows: missingHchanhRows,
          sourceRunId: runId,
          files: hchanhFiles,
          headless,
          force,
          fallbackDateFrom: fallbackFrom,
          fallbackDateTo: fallbackTo,
          mode: hchanhFiles.includes('order_history') && hchanhFiles.length === 1
            ? 'order_history_auto' : 'hchanh_auto',
        });
        results.hchanh = fetched;
        if (fetched.cancelled || isCancelRequested(ctx.sid)) return finishCancelled();
      }

      // XN/CĐHA — chạy lấy lại ngay trên subset BN/lượt còn thiếu, không chỉ đánh dấu chờ Bước 2.
      if (missingXnCdhaRows.length) {
        if (isCancelRequested(ctx.sid)) return finishCancelled();
        const reset = resetXnCdhaProgress(runDir, missingXnCdhaRows);
        const refetchRows = sourceRowsForXnCdhaRefetch(runDir, isArc ? archiveSourcePath() : cohortPath(scope), missingXnCdhaRows, runId, {
          from_date: fallbackFrom,
          to_date: fallbackTo,
        });
        if (!refetchRows.length) {
          results.xn_cdha = {
            patients: missingXnCdha.length,
            reset_in_progress: reset.resetCount,
            error: 'Không dựng được danh sách BN để lấy lại XN/CĐHA.',
          };
        } else {
          const inputDir = path.join(runDir, 'input');
          ensureDir(inputDir);
          const subsetPath = path.join(inputDir, `refetch_xn_cdha_${nowFileStamp()}.csv`);
          writeCsvUnion(subsetPath, refetchRows, [
            'Mã NC', 'Mã BN', 'Họ tên', 'T/G vào', 'TG vào', 'Ngày vào viện', 'Ngày ra viện',
            'fetch_from_date', 'fetch_to_date', 'source_scan_from_date', 'source_scan_to_date', 'source_file', 'source_run_id', 'Research key',
          ]);
          const args = [
            '-u', SCRIPT_PATH,
            '--input', subsetPath,
            '--project-id', scope,
            '--run-id', runId,
            '--out-root', RESEARCH_STORE_DIR,
          ];
          const initialListPath = isArc ? archiveTablePath('initial_list', runId) : '';
          if (isArc && initialListPath) args.push('--archive-initial-list', initialListPath);
          if (fallbackFrom) args.push('--from-date', fallbackFrom);
          if (fallbackTo) args.push('--to-date', fallbackTo);
          if (headless) args.push('--headless');
          appendResearchRunLog(runDir, `[REFETCH_XN_CDHA] Bắt đầu lấy lại ${refetchRows.length} dòng nguồn / ${missingXnCdha.length} BN còn thiếu`);
          let xnResult;
          try {
            xnResult = await runPython(args, {
              cwd: ROOT_DIR,
              onSpawn: killFn => registerCancel(ctx.sid, killFn),
              extraEnv: { RESEARCH_INPUT_NAME: path.basename(subsetPath), RESEARCH_REFETCH_MISSING: '1' },
            });
          } finally {
            unregisterCancel(ctx.sid);
          }
          if (isCancelRequested(ctx.sid)) {
            results.xn_cdha = {
              patients: missingXnCdha.length,
              input_rows: refetchRows.length,
              reset_in_progress: reset.resetCount,
              cancelled: true,
            };
            appendResearchRunLog(runDir, '[REFETCH_XN_CDHA] ĐÃ DỪNG theo yêu cầu; phần đã commit được giữ, phần còn lại sẽ lấy tiếp lần sau.');
            return finishCancelled();
          }
          if (xnResult.spawnError || xnResult.killedByTimeout || xnResult.code !== 0) {
            results.xn_cdha = {
              patients: missingXnCdha.length,
              input_rows: refetchRows.length,
              reset_in_progress: reset.resetCount,
              error: xnResult.spawnError || (xnResult.killedByTimeout ? 'timeout' : fmtPyError('Lấy lại XN/CĐHA lỗi', xnResult)),
            };
            appendResearchRunLog(runDir, `[REFETCH_XN_CDHA] LỖI: ${String(results.xn_cdha.error).split('\n')[0]}`);
          } else {
            results.xn_cdha = {
              patients: missingXnCdha.length,
              input_rows: refetchRows.length,
              reset_in_progress: reset.resetCount,
              message: `Đã chạy lấy lại XN/CĐHA cho ${refetchRows.length} dòng nguồn (${missingXnCdha.length} BN).`,
            };
            appendResearchRunLog(runDir, `[REFETCH_XN_CDHA] Xong: ${refetchRows.length} dòng nguồn / ${missingXnCdha.length} BN`);
          }
        }
      }

      const normalized = normalizeRunOutputs(runDir, { sourceRunId: runId });
      if (isArc) {
        updateArchive({ last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso() });
      } else {
        updateStudy(scope, { last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso() });
      }

      const message = [
        results.hchanh ? `Hành chánh: xử lý=${results.hchanh.processed}, OK=${results.hchanh.ok}, lỗi=${results.hchanh.error}` : '',
        results.xn_cdha ? (results.xn_cdha.error ? `XN/CĐHA lỗi: ${String(results.xn_cdha.error).split('\n')[0]}` : results.xn_cdha.message) : '',
      ].filter(Boolean).join(' | ');
      finishResearchTask(runDir, task.id, results.xn_cdha?.error ? 'error' : 'done', {
        message: message || 'Đã hoàn tất bổ sung dữ liệu còn thiếu.',
        summary,
        results,
      });

      return res.json({
        status: 'ok',
        message,
        summary,
        results,
        normalized,
      });
      } catch (taskErr) {
        finishResearchTask(runDir, task.id, 'error', {
          message: String(taskErr?.message || taskErr || 'Tác vụ bổ sung dữ liệu lỗi.'),
          summary,
          results,
        });
        throw taskErr;
      }
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

router.use(require('./research_collection'));

module.exports = router;
// Chỉ dùng cho kiểm thử (scripts/research_hchanh_same_stay_reuse_test.js, scripts/research_data_safety_test.js).
module.exports._fetchHchanhForResearchRun = fetchHchanhForResearchRun;
// Danh sách cột chuẩn hóa, dùng để đối chiếu từ điển dữ liệu (server/research/data_dictionary.js).
module.exports.NORMALIZED_COLUMNS = NORMALIZED_COLUMNS;
module.exports.ingestAllResearchResultsToPatientDb = ingestAllResearchResultsToPatientDb;
module.exports._test = { buildEncodedDataset, buildPatientHistory, sendCsvFile, RESEARCH_SCOPE_LOCKS, researchScopeKey, readCsvTable, buildResearchProgressSnapshot, safeRunId, overlayHchanhFromPatientDb, overlayResultsFromPatientDb, buildResultDayIndex, resultDayIndexHasRange, addRowsToResultDayIndex, ingestAllResearchResultsToPatientDb, researchHchanhMeta, normalizeInputSignature, identifiedAccessStatus, normalizeResearchSourceRows, ensureResearchSourceRows, combineEncounterSources, buildContextMap, contextForRow, encounterMatchStatus, encounterMatchMethod, summarizeVariableColumns, VARIABLE_CATALOG_MAX_ROWS, normalizeRunOutputs, buildCoverageSummary, listDatasetSnapshots, writeDatasetSnapshot, verifyDatasetSnapshot, verifyAllDatasetSnapshots, cleanupStaleDatasetStaging, finalizeAnalysisDataset, runCollectionOrchestration, readCollectionPartRows, recoverCollectionTransactions, recoverPythonPatientCommits, appendCollectionVersions, readCollectionVersionIds, syncCollectionLedger, studyReadinessForRun, hchanhFileStatusPatch, hchanhEntryFileStatus };
