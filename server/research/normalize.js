'use strict';

// Chuẩn hóa một run: từ file thô (danh sách, XN/CĐHA, hành chánh, y lệnh) ra các bảng chuẩn hóa, analysis_ready, QA, SQLite.
// Có cache theo chữ ký input; ghi normalize_state/normalize_history để phát hiện chuẩn hóa dở dang.

const path = require('path');
const fs = require('fs');
const { stableHash, buildContextMap, contextForRow, firstNonEmpty, buildEncounterId, isoDateTime, isoDate, parseAnyDate, rowEmrAdmissionId, rowEmrTreatmentId, rowNoitruId, encounterMatchStatus, eventTemporalFields, dateOffsetDays, daysBetween, normalizeSimple } = require('./encounter_context');
const { loadAnalysisConfig, ANALYSIS_PRESETS, _runInference, hoursBetween } = require('./analysis_presets');
const patientDb = require('../services/patient_db');
const variableSelection = require('./variable_selection');
const { ensureDir, writeJsonAtomic, readJsonSafe } = require('../utils/file');
const quality = require('./quality');
const { nowIso, archiveRunsDir, runsDir, studyDir, cohortPath } = require('./store_paths');
const { NORMALIZED_SCHEMA_VERSION, NORMALIZED_COLUMNS } = require('./normalized_schema');
const { ensureResearchSourceRows } = require('./research_source');
const { syncDatabaseForRun, publicDatabaseInfo, datasetDirFromRunDir } = require('./research_db');
const { databaseInfo } = require('./sqlite_store');
const { readCsvTable, patientCode, writeCsv, countCsvRows, getCell } = require('./table_io');
const { overlayHchanhFromPatientDb, KHO_OVERLAY_FILE, overlayResultsFromPatientDb } = require('./patient_db_overlay');
const { appendResearchRunLog } = require('./case_trace');
const { combineEncounterSources, mergeRowsPreferFilled, dedupeByHash, byEncounterCount } = require('./source_merge');
const { normalizeSex, extractBirthYear, normalizeLabName, resultOperator, parseNumeric, resultText, normalizeLabMeasurement, normalizeFlag, modalityFromService, bodyRegionFromService, normalizeDrugName, classifyDrugGroup, normalizeRoute } = require('./value_normalizers');
const { dedupeRowsByHash, dedupeSurgeryRows, snapshotFinalDatasetIfUnsaved } = require('./dataset_store');
const { firstSurgeryByEncounter, surgeryForMedicationContext } = require('./encounter_linkage');
const { evaluateCustomFields } = require('./analysis_config');
const { medicationRowsFromOrderRow, dedupeOrderFields, extractClinicalEvents } = require('./order_note_parser');
const { hchanhEntryFileStatus } = require('./progress_snapshot');
const { loadPatientLink, patientLinkPath, applyPatientKeys, savePatientLink } = require('./patient_link');
const { buildSelectedAnalysisForRun, sanitizeVariableSelection, activeVariableSelectionFromStudy, loadRunTablesForSelection } = require('./selection_runtime');
const { ROOT_DIR } = require('../constants');
const { resolveArchiveRunId, resolveRunId, readArchive, archiveTablePath, rowPassesDateFilter, updateStudy } = require('./run_registry');

function ageAtEncounter(birthDate, admissionDate) {
  const birth = parseAnyDate(birthDate);
  const admission = parseAnyDate(admissionDate);
  if (!birth || !admission || admission < birth) return '';
  let age = admission.getFullYear() - birth.getFullYear();
  const beforeBirthday = admission.getMonth() < birth.getMonth()
    || (admission.getMonth() === birth.getMonth() && admission.getDate() < birth.getDate());
  if (beforeBirthday) age -= 1;
  return age >= 0 && age <= 130 ? String(age) : '';
}

const NORMALIZE_INPUT_FILES = [
  'research_source.csv',
  'du_lieu_ban_dau.csv',
  'mau_nghien_cuu.csv',
  'du_lieu_goc.csv',
  'thong_tin_benh_nhan_bo_sung.csv',
  'hchanh_profile.csv',
  'hchanh_discharge.csv',
  'hchanh_surgery.csv',
  'hchanh_order_history.csv',
  'lich_su_xn.csv',
  'lich_su_cdha.csv',
  'progress.json',
  'hchanh_auto_progress.json',
  'order_history_auto_progress.json',
];

const NORMALIZE_OUTPUT_FILES = [
  'patients.csv',
  'encounters.csv',
  'diagnoses.csv',
  'lab_results.csv',
  'imaging_results.csv',
  'surgery_results.csv',
  'medication_orders.csv',
  'medication_day_summary.csv',
  'clinical_notes.csv',
  'clinical_events.csv',
  'patient_day.csv',
  'analysis_ready.csv',
  'extract_status.csv',
];

function normalizeInputSignature(runDir) {
  const dir = path.resolve(runDir);
  const files = [];
  for (const name of NORMALIZE_INPUT_FILES) {
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      files.push({ name, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
    } catch (_) {
      files.push({ name, missing: true });
    }
  }
  // analysis_config/variable_selection nằm trong study.json, không phải CSV input.
  // Đưa vào signature để bấm Chuẩn hóa sau khi đổi biến sẽ luôn sinh lại dataset.
  try {
    files.push({ name: 'analysis_config', hash: stableHash(loadAnalysisConfig(dir) || {}) });
  } catch (_) {
    files.push({ name: 'analysis_config', missing: true });
  }
  // Phần hành chánh lấy thêm từ Kho người bệnh: kho có bản quét mới thì phải chuẩn hoá lại.
  try {
    if (patientDb.available()) files.push({ name: 'kho_nguoi_benh', version: patientDb.dataVersion() });
  } catch (_) {}
  return stableHash(files);
}

function normalizedOutputsAvailable(runDir) {
  const dir = path.resolve(runDir);
  const config = loadAnalysisConfig(dir);
  const required = [...NORMALIZE_OUTPUT_FILES];
  if (variableSelection.hasActiveSelection(config?.variable_selection)) required.push('analysis_selected.csv');
  return required.every(name => {
    try { return fs.statSync(path.join(dir, name)).isFile(); }
    catch (_) { return false; }
  });
}

// Bọc bước chuẩn hóa bằng normalize_state.json: ghi "running" trước khi ghi bất kỳ
// bảng nào, "complete"/"failed" khi xong. Các bảng được ghi lần lượt (mỗi file ghi
// tạm rồi đổi tên), nên nếu tiến trình chết giữa chừng, thư mục có thể lẫn bảng mới
// và cũ: trạng thái "running" còn sót lại là dấu hiệu để chặn tạo dataset cuối và
// buộc lần Chuẩn hóa sau chạy lại đầy đủ thay vì dùng cache.
// Ghi bước đang chạy vào normalize_state.json (đang "running") để giao diện hiện tiến độ chuẩn hóa.
const NORMALIZE_STAGE_TOTAL = 8;
function markNormalizeStage(dir, index, label) {
  try {
    const statePath = path.join(dir, quality.NORMALIZE_STATE_FILE);
    const state = readJsonSafe(statePath, null);
    if (!state || state.status !== 'running') return;
    writeJsonAtomic(statePath, { ...state, stage: label, stage_index: index, stage_total: NORMALIZE_STAGE_TOTAL, stage_at: nowIso() });
  } catch (_) { /* tiến độ chỉ để hiển thị */ }
}

function normalizeRunOutputs(runDir, options = {}) {
  const dir = path.resolve(runDir);
  ensureDir(dir);
  const previousState = quality.readNormalizeState(dir);
  const startedAt = nowIso();
  const statePath = path.join(dir, quality.NORMALIZE_STATE_FILE);
  writeJsonAtomic(statePath, { status: 'running', started_at: startedAt, schema_version: NORMALIZED_SCHEMA_VERSION });
  try {
    const result = normalizeRunOutputsInner(dir, { ...options, previousState });
    writeJsonAtomic(statePath, {
      status: 'complete',
      started_at: startedAt,
      finished_at: nowIso(),
      schema_version: NORMALIZED_SCHEMA_VERSION,
      cached: Boolean(result.cached),
      qa_status: result.qa?.status || '',
      database_status: result.database_status || '',
    });
    return result;
  } catch (err) {
    writeJsonAtomic(statePath, {
      status: 'failed',
      started_at: startedAt,
      finished_at: nowIso(),
      schema_version: NORMALIZED_SCHEMA_VERSION,
      error: String(err?.message || err).slice(0, 300),
    });
    throw err;
  }
}

function normalizeRunOutputsInner(runDir, { sourceRunId = '', force = false, previousState = null } = {}) {
  const dir = path.resolve(runDir);
  ensureDir(dir);
  const runId = sourceRunId || path.basename(dir);
  const manifestPath = path.join(dir, 'manifest.json');
  const manifestBefore = readJsonSafe(manifestPath, {}) || {};
  // Đồng bộ nguồn chuẩn trước khi tính signature/cache. Nếu Bước 1 vừa cập nhật
  // du_lieu_ban_dau.csv thì research_source.csv cũ không được phép giữ nguyên.
  const sourceInfo = ensureResearchSourceRows(dir, { sourceRunId: runId });
  let inputSignature = normalizeInputSignature(dir);
  if (!force
    && Number(manifestBefore.normalized_schema_version || 0) === NORMALIZED_SCHEMA_VERSION
    && manifestBefore.normalized_input_signature === inputSignature
    && normalizedOutputsAvailable(dir)
    && manifestBefore.normalized_outputs
    && previousState?.status === 'complete') {
    let database = null;
    try {
      database = syncDatabaseForRun(dir, { runId, inputSignature, force: false });
    } catch (err) {
      console.warn('[RESEARCH][SQLITE] Không đồng bộ được SQLite cache:', err.message);
    }
    return {
      ...manifestBefore.normalized_outputs,
      cached: true,
      qa: quality.readQaReport(dir) ? { status: quality.readQaReport(dir).status } : null,
      database_status: manifestBefore.normalized_database_status || '',
      input_signature: inputSignature,
      database: database ? publicDatabaseInfo(database) : publicDatabaseInfo(databaseInfo(datasetDirFromRunDir(dir))),
    };
  }

  // Đọc analysis config từ study.json của nghiên cứu này
  const analysisConfig = loadAnalysisConfig(dir);
  const preset = ANALYSIS_PRESETS[analysisConfig.preset] || ANALYSIS_PRESETS.general;
  const customFields = Array.isArray(analysisConfig.custom_fields) ? analysisConfig.custom_fields : [];

  markNormalizeStage(dir, 1, 'Đọc dữ liệu thô và lấy bổ sung từ Kho người bệnh');
  const sourceTable = readCsvTable(path.join(dir, 'research_source.csv'), Number.MAX_SAFE_INTEGER);
  const patientTable = readCsvTable(path.join(dir, 'mau_nghien_cuu.csv'), Number.MAX_SAFE_INTEGER);
  const deepTable = readCsvTable(path.join(dir, 'du_lieu_goc.csv'), Number.MAX_SAFE_INTEGER);
  const initialTable = readCsvTable(path.join(dir, 'du_lieu_ban_dau.csv'), Number.MAX_SAFE_INTEGER);
  const extraTable = readCsvTable(path.join(dir, 'thong_tin_benh_nhan_bo_sung.csv'), Number.MAX_SAFE_INTEGER);
  const hchanhProfileTable = readCsvTable(path.join(dir, 'hchanh_profile.csv'), Number.MAX_SAFE_INTEGER);
  const hchanhDischargeTable = readCsvTable(path.join(dir, 'hchanh_discharge.csv'), Number.MAX_SAFE_INTEGER);
  const hchanhSurgeryTable = readCsvTable(path.join(dir, 'hchanh_surgery.csv'), Number.MAX_SAFE_INTEGER);
  const hchanhOrderTable = readCsvTable(path.join(dir, 'hchanh_order_history.csv'), Number.MAX_SAFE_INTEGER);

  // Đợt 5 kho người bệnh: bổ sung / thay dữ liệu hành chánh từ kho chung (không sửa CSV thô).
  let khoOverlay = null;
  try {
    const overlaid = overlayHchanhFromPatientDb(dir, sourceTable.rows.length ? sourceTable.rows : initialTable.rows, runId, {
      profile: hchanhProfileTable.rows || [], discharge: hchanhDischargeTable.rows || [],
      surgery: hchanhSurgeryTable.rows || [], order_history: hchanhOrderTable.rows || [],
    });
    hchanhProfileTable.rows = overlaid.tables.profile;
    hchanhDischargeTable.rows = overlaid.tables.discharge;
    hchanhSurgeryTable.rows = overlaid.tables.surgery;
    hchanhOrderTable.rows = overlaid.tables.order_history;
    khoOverlay = overlaid.report;
    writeJsonAtomic(path.join(dir, KHO_OVERLAY_FILE), khoOverlay);
    const filled = Object.values(khoOverlay.filled).reduce((a, b) => a + b, 0);
    const replaced = Object.values(khoOverlay.replaced_by_goc).reduce((a, b) => a + b, 0);
    if (filled || replaced) {
      appendResearchRunLog(dir, `[${new Date().toLocaleString('vi-VN')}] Chuẩn hoá: lấy từ kho người bệnh ${filled} phần còn thiếu, thay ${replaced} phần tạm thời bằng dữ liệu gốc; còn ${khoOverlay.provisional.length} phần là dữ liệu tạm thời.`);
    }
  } catch (err) {
    console.warn('[RESEARCH] Không đọc được Kho người bệnh khi chuẩn hoá:', err.message);
  }

  markNormalizeStage(dir, 2, 'Ghép lượt điều trị');
  const encounterSourceRows = combineEncounterSources({
    initialRows: sourceTable.rows.length ? sourceTable.rows : initialTable.rows,
    patientRows: patientTable.rows,
    deepRows: deepTable.rows,
    hchanhProfileRows: hchanhProfileTable.rows,
    hchanhDischargeRows: hchanhDischargeTable.rows,
    sourceRunId: runId,
  });
  const patientsRaw = encounterSourceRows.length ? encounterSourceRows : (patientTable.rows.length ? patientTable.rows : initialTable.rows);

  const ctxMap = buildContextMap(patientsRaw, runId);
  const demographicByPatient = new Map();
  const extraByEncounter = new Map();
  function mergeExtra(row, includePatientDemographics = false) {
    const code = patientCode(row);
    if (!code) return;
    if (includePatientDemographics) {
      demographicByPatient.set(code, mergeRowsPreferFilled(demographicByPatient.get(code) || {}, row));
    }
    const ctx = contextForRow(ctxMap, row, code);
    if (ctx.encounter_id) {
      extraByEncounter.set(ctx.encounter_id, mergeRowsPreferFilled(extraByEncounter.get(ctx.encounter_id) || {}, row));
    }
  }
  for (const row of extraTable.rows || []) mergeExtra(row, true);
  for (const row of hchanhProfileTable.rows || []) mergeExtra(row, true);
  for (const row of hchanhDischargeTable.rows || []) mergeExtra(row, false);
  function extraForContext(code, ctx) {
    return mergeRowsPreferFilled(demographicByPatient.get(code) || {}, extraByEncounter.get(ctx?.encounter_id) || {});
  }
  // Chỉ dữ liệu đúng đợt (encounter_id khớp) — không merge thêm bucket theo
  // mã BN, vì các trường dùng ở đây (chẩn đoán vào/ra viện, ngày vào/ra,
  // phòng/giường...) là dữ liệu riêng từng đợt điều trị. demographicByPatient
  // gộp thông tin từ MỌI đợt của cùng mã BN — dùng nó ở đây sẽ khiến chẩn
  // đoán/ngày tháng của một đợt cũ bị gán nhầm cho đợt đang build khi đợt này
  // thiếu dữ liệu riêng.
  function extraForEncounterOnly(ctx) {
    return extraByEncounter.get(ctx?.encounter_id) || {};
  }

  const encounterRows = patientsRaw.filter(row => patientCode(row));
  const encounterById = new Map();
  const encounters = [];
  for (const row of encounterRows) {
    const code = patientCode(row);
    const ctx = contextForRow(ctxMap, row, code);
    const extra = extraForEncounterOnly(ctx);
    const admissionDiagnosis = ctx.admission_diagnosis || firstNonEmpty(extra, ['Chẩn đoán vào viện', 'Chan doan vao vien']) || ctx.diagnosis_raw || firstNonEmpty(row, ['Chẩn đoán', 'Chan doan']);
    const dischargeDiagnosis = firstNonEmpty(row, ['Chẩn đoán ra viện', 'Chan doan ra vien']) || firstNonEmpty(extra, ['Chẩn đoán ra viện', 'Chan doan ra vien']) || '';
    const out = {
      encounter_id: ctx.encounter_id || buildEncounterId(row, runId),
      research_code: ctx.research_code || firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']) || '',
      patient_code: code,
      admission_date: ctx.admission_date || isoDateTime(firstNonEmpty(extra, ['Ngày vào viện', 'Ngay vao vien', 'ngay_vao_vien', 'ngay_vao'])) || '',
      discharge_date: ctx.discharge_date || isoDateTime(firstNonEmpty(extra, ['Ngày ra viện', 'Ngay ra vien', 'Ngày xuất viện', 'Ngay xuat vien', 'ngay_ra_vien', 'ngay_ra'])) || '',
      treatment_duration: ctx.treatment_duration || firstNonEmpty(extra, ['Thời gian điều trị', 'Thoi gian dieu tri', 'so_ngay_dieu_tri']) || '',
      department: ctx.department || '',
      room_bed: ctx.room_bed || firstNonEmpty(extra, ['Phòng/Giường', 'Phong/Giuong', 'Phòng', 'Phong']) || '',
      admission_diagnosis: admissionDiagnosis,
      discharge_diagnosis: dischargeDiagnosis,
      diagnosis_raw: dischargeDiagnosis || admissionDiagnosis || ctx.diagnosis_raw || '',
      comorbidity_text: firstNonEmpty(row, ['Bệnh kèm', 'Benh kem', 'Bệnh nền', 'Benh nen']) || firstNonEmpty(extra, ['Bệnh kèm', 'Benh kem', 'Bệnh nền', 'Benh nen']) || '',
      complication_text: firstNonEmpty(row, ['Biến chứng', 'Bien chung', 'Tai biến', 'Tai bien']) || firstNonEmpty(extra, ['Biến chứng', 'Bien chung', 'Tai biến', 'Tai bien']) || '',
      discharge_status: firstNonEmpty(row, ['Tình trạng ra', 'Tinh trang ra', 'Kết quả', 'Ket qua']) || firstNonEmpty(extra, ['Tình trạng ra', 'Tinh trang ra', 'Kết quả', 'Ket qua']) || '',
      surgery_date: ctx.surgery_date || isoDate(firstNonEmpty(row, ['Ngày mổ', 'Ngay mo', 'Ngày phẫu thuật', 'Ngay phau thuat'])) || '',
      emr_admission_id: ctx.emr_admission_id || rowEmrAdmissionId(row) || '',
      emr_treatment_id: ctx.emr_treatment_id || rowEmrTreatmentId(row) || '',
      emr_noitru_id: ctx.emr_noitru_id || rowNoitruId(row) || '',
      needs_manual_review: [ctx.needs_manual_review, firstNonEmpty(row, ['__needs_manual_review', 'needs_manual_review'])]
        .filter(Boolean).join('; '),
      source_run_id: runId,
      source_status: row.__source_status || '',
    };
    out.row_hash = stableHash(out);
    if (!encounterById.has(out.encounter_id)) {
      encounterById.set(out.encounter_id, out);
      encounters.push(out);
    } else {
      const merged = mergeRowsPreferFilled(encounterById.get(out.encounter_id), out);
      merged.row_hash = stableHash(merged);
      encounterById.set(out.encounter_id, merged);
    }
  }
  const finalEncounters = Array.from(encounterById.values());

  const patientByCode = new Map();
  for (const row of encounterRows) {
    const code = patientCode(row);
    if (!code) continue;
    const ctx = contextForRow(ctxMap, row, code);
    const extra = extraForContext(code, ctx);
    const base = patientByCode.get(code) || {
      patient_code: code,
      patient_name: '', sex: '', birth_date: '', age: '', birth_year: '',
      address: '', phone_number: '', citizen_id: '', insurance_subject: '', insurance_card: '', insurance_type: '',
      insurance_valid_from: '', insurance_valid_to: '', first_research_code: '', encounter_count: 0,
      source_input: '', source_run_id: runId,
    };
    const candidate = {
      patient_code: code,
      patient_name: ctx.patient_name || firstNonEmpty(extra, ['Họ tên', 'Ho ten']) || '',
      sex: normalizeSex(ctx.sex || firstNonEmpty(extra, ['Giới', 'Gioi', 'GT', 'sex'])),
      birth_date: ctx.birth_date || isoDate(firstNonEmpty(extra, ['Ngày sinh', 'Ngay sinh', 'birth_date'])) || '',
      age: ctx.age || firstNonEmpty(extra, ['Tuổi', 'Tuoi', 'age']) || '',
      birth_year: extractBirthYear(ctx.birth_date || ctx.age || firstNonEmpty(extra, ['Năm sinh', 'Nam sinh', 'Ngày sinh', 'Ngay sinh']) || ctx.patient_name || ''),
      address: ctx.address || firstNonEmpty(extra, ['Địa chỉ', 'Dia chi', 'address']) || '',
      phone_number: ctx.phone_number || firstNonEmpty(extra, ['Điện thoại', 'Dien thoai', 'SĐT', 'SDT', 'Số điện thoại', 'So dien thoai', 'phone', 'phone_number']) || '',
      citizen_id: ctx.citizen_id || firstNonEmpty(extra, ['Số CMND', 'So CMND', 'Số CMT', 'So CMT', 'CMND', 'CMT', 'CCCD', 'citizen_id']) || '',
      insurance_subject: ctx.insurance_subject || firstNonEmpty(extra, ['Đối tượng', 'Doi tuong']) || '',
      insurance_card: ctx.insurance_card || firstNonEmpty(extra, ['Số thẻ BHYT', 'So the BHYT', 'Số thẻ', 'So the', 'insurance_card']) || '',
      insurance_type: ctx.insurance_type || firstNonEmpty(extra, ['Loại', 'Loai', 'Loại BHYT', 'Loai BHYT']) || '',
      insurance_valid_from: ctx.insurance_valid_from || isoDate(firstNonEmpty(extra, ['Giá trị từ', 'Gia tri tu', 'Từ ngày', 'Tu ngay'])) || '',
      insurance_valid_to: ctx.insurance_valid_to || isoDate(firstNonEmpty(extra, ['Giá trị đến', 'Gia tri den', 'Đến ngày', 'Den ngay'])) || '',
      first_research_code: base.first_research_code || ctx.research_code || '',
      source_input: ctx.source_input || firstNonEmpty(extra, ['Nguồn input', 'Nguon input']) || '',
      source_run_id: runId,
    };
    const merged = mergeRowsPreferFilled(base, candidate);
    merged.encounter_count = (Number(base.encounter_count) || 0) + 1;
    patientByCode.set(code, merged);
  }
  const encounterCountByCode = new Map();
  for (const enc of finalEncounters) {
    encounterCountByCode.set(enc.patient_code, (encounterCountByCode.get(enc.patient_code) || 0) + 1);
  }
  for (const [code, row] of patientByCode.entries()) {
    row.encounter_count = encounterCountByCode.get(code) || 0;
    row.row_hash = stableHash(row);
    patientByCode.set(code, row);
  }
  const patients = Array.from(patientByCode.values()).sort((a, b) => String(a.patient_code).localeCompare(String(b.patient_code)));

  markNormalizeStage(dir, 3, 'Xét nghiệm và CĐHA');
  let labRaw = readCsvTable(path.join(dir, 'lich_su_xn.csv'), Number.MAX_SAFE_INTEGER).rows;
  let imagingRaw = readCsvTable(path.join(dir, 'lich_su_cdha.csv'), Number.MAX_SAFE_INTEGER).rows;
  try {
    const results = overlayResultsFromPatientDb(dir, sourceTable.rows.length ? sourceTable.rows : initialTable.rows, runId, labRaw, imagingRaw);
    labRaw = results.labRaw;
    imagingRaw = results.imagingRaw;
    if (khoOverlay) {
      khoOverlay.results = results.report;
      writeJsonAtomic(path.join(dir, KHO_OVERLAY_FILE), khoOverlay);
    }
    const r = results.report;
    if (r.filled_cases.xn || r.filled_cases.cdha) {
      appendResearchRunLog(dir, `[${new Date().toLocaleString('vi-VN')}] Chuẩn hoá: lấy từ kho người bệnh XN cho ${r.filled_cases.xn} ca (${r.filled_rows.xn} dòng), CĐHA cho ${r.filled_cases.cdha} ca (${r.filled_rows.cdha} dòng).`);
    }
  } catch (err) {
    console.warn('[RESEARCH] Không đồng bộ XN/CĐHA với Kho người bệnh:', err.message);
  }
  const labResultsAll = labRaw.map((row, idx) => {
    const code = patientCode(row);
    const ctx = contextForRow(ctxMap, row, code);
    const rawTime = firstNonEmpty(row, ['TG xét nghiệm', 'Thời gian xét nghiệm', 'TG chỉ định', 'Thời gian', 'Ngày xét nghiệm', 'Ngày chỉ định']);
    const name = firstNonEmpty(row, ['Chỉ số', 'Chi so', 'Tên xét nghiệm', 'Ten xet nghiem']);
    const result = firstNonEmpty(row, ['Kết quả', 'Ket qua', 'result']);
    const testNameNorm = normalizeLabName(name);
    const resultNum = parseNumeric(result);
    const unitRaw = firstNonEmpty(row, ['Đơn vị', 'Don vi', 'unit']);
    const normalizedMeasurement = normalizeLabMeasurement(testNameNorm, resultNum, unitRaw);
    const base = {
      research_code: firstNonEmpty(row, ['Mã NC', 'Ma NC']) || ctx.research_code || '',
      patient_code: code,
      encounter_id: ctx.encounter_id || '',
      encounter_match_status: encounterMatchStatus(ctx),
      lab_datetime: isoDateTime(rawTime),
      lab_date: isoDate(firstNonEmpty(row, ['Ngày xét nghiệm', 'Ngày chỉ định'])) || isoDate(rawTime),
      lab_group: firstNonEmpty(row, ['Loại XN', 'Loai XN', 'Nhóm XN']),
      lab_order_id: firstNonEmpty(row, ['Mã phiếu', 'Ma phieu', 'lab_order_id']),
      test_name_raw: name,
      test_name_norm: testNameNorm,
      result_raw: result,
      result_operator: resultOperator(result),
      result_num: resultNum,
      result_text: resultText(result),
      unit: unitRaw,
      result_num_norm: normalizedMeasurement.result_num_norm,
      unit_norm: normalizedMeasurement.unit_norm,
      unit_conversion_status: normalizedMeasurement.unit_conversion_status,
      ref_range_raw: firstNonEmpty(row, ['Khoảng tham chiếu', 'Khoang tham chieu', 'ref_range']),
      flag_raw: firstNonEmpty(row, ['Bất thường', 'Bat thuong', 'flag']),
      flag_norm: normalizeFlag(firstNonEmpty(row, ['Bất thường', 'Bat thuong', 'flag'])),
      ...eventTemporalFields(ctx, rawTime),
      source_run_id: runId,
    };
    base.row_hash = stableHash(base);
    base.lab_result_id = `lab_${base.row_hash || stableHash([idx, base.patient_code])}`;
    return base;
  });
  // XN phải lossless: một người bệnh có thể được làm cùng xét nghiệm nhiều lần trong
  // cùng đợt, thậm chí cùng thời điểm hiển thị và cùng kết quả. Không được tự xóa chỉ vì
  // nội dung chuẩn hóa giống nhau. Giữ row_hash để QA nhận diện nhóm nghi trùng, nhưng
  // cấp lab_result_id riêng theo lần xuất hiện để mọi dòng vẫn tồn tại trong lab_results.csv.
  const labOccurrence = new Map();
  const labResults = labResultsAll.map(row => {
    const hash = String(row.row_hash || stableHash(row));
    const occurrence = (labOccurrence.get(hash) || 0) + 1;
    labOccurrence.set(hash, occurrence);
    return { ...row, lab_result_id: `lab_${hash}_${occurrence}` };
  });

  const imagingResultsAll = imagingRaw.map((row, idx) => {
    const code = patientCode(row);
    const ctx = contextForRow(ctxMap, row, code);
    const rawTime = firstNonEmpty(row, ['TG chỉ định', 'TG chi dinh', 'Thời gian', 'Ngày chỉ định']);
    const service = firstNonEmpty(row, ['Tên dịch vụ', 'Ten dich vu', 'Dịch vụ', 'Dich vu']);
    const base = {
      research_code: firstNonEmpty(row, ['Mã NC', 'Ma NC']) || ctx.research_code || '',
      patient_code: code,
      encounter_id: ctx.encounter_id || '',
      encounter_match_status: encounterMatchStatus(ctx),
      ordered_at: isoDateTime(rawTime),
      order_date: isoDate(firstNonEmpty(row, ['Ngày chỉ định', 'Ngay chi dinh'])) || isoDate(rawTime),
      service_name_raw: service,
      modality: firstNonEmpty(row, ['Nhóm dịch vụ', 'Nhom dich vu']) || modalityFromService(service),
      body_region: bodyRegionFromService(service),
      result_text: firstNonEmpty(row, ['Mô tả/Kết quả', 'Mo ta/Ket qua', 'Kết quả', 'Ket qua']),
      conclusion_text: firstNonEmpty(row, ['Kết luận', 'Ket luan']),
      status: firstNonEmpty(row, ['Trạng thái', 'Trang thai']),
      ...eventTemporalFields(ctx, rawTime),
      source_run_id: runId,
    };
    base.row_hash = stableHash(base);
    base.imaging_id = `img_${base.row_hash || stableHash([idx, base.patient_code])}`;
    return base;
  });
  const imagingResults = dedupeRowsByHash(imagingResultsAll);

  const diagnosisRows = [];
  for (const enc of finalEncounters) {
    const items = [
      ['admission', enc.admission_diagnosis, ''],
      ['discharge', enc.discharge_diagnosis, ''],
      ['comorbidity', enc.comorbidity_text, ''],
      ['complication', enc.complication_text, ''],
    ];
    for (const [type, text, icd] of items) {
      if (!String(text || '').trim()) continue;
      const row = {
        research_code: enc.research_code,
        patient_code: enc.patient_code,
        encounter_id: enc.encounter_id,
        diagnosis_date: type === 'discharge' ? isoDate(enc.discharge_date) : isoDate(enc.admission_date),
        diagnosis_type: type,
        icd_code: icd || (String(text).match(/\b([A-Z]\d{2}(?:\.\d+)?)\b/)?.[1] || ''),
        diagnosis_text: text,
        source: 'encounter',
        source_run_id: runId,
      };
      row.row_hash = stableHash(row);
      row.diagnosis_id = `dx_${row.row_hash}`;
      diagnosisRows.push(row);
    }
  }
  const diagnoses = dedupeByHash(diagnosisRows);

  markNormalizeStage(dir, 4, 'Phẫu thuật, y lệnh, diễn biến');
  const surgeryRaw = [
    ...hchanhSurgeryTable.rows,
    ...readCsvTable(path.join(dir, 'lich_su_phau_thuat.csv'), Number.MAX_SAFE_INTEGER).rows,
    ...readCsvTable(path.join(dir, 'phau_thuat.csv'), Number.MAX_SAFE_INTEGER).rows,
  ];
  let surgeryResults = surgeryRaw.map((row, idx) => {
    const code = patientCode(row);
    const ctx = contextForRow(ctxMap, row, code);
    const dt = firstNonEmpty(row, ['Ngày phẫu thuật', 'Ngay phau thuat', 'Thời gian', 'Thoi gian', 'bat_dau', 'surgery_datetime', 'surgery_date']);
    const base = {
      research_code: firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']) || ctx.research_code || '',
      patient_code: code,
      encounter_id: ctx.encounter_id || '',
      encounter_match_status: encounterMatchStatus(ctx),
      surgery_datetime: isoDateTime(dt),
      surgery_date: isoDate(dt),
      surgery_name: firstNonEmpty(row, ['Tên phẫu thuật', 'Ten phau thuat', 'Dịch vụ phẫu thuật', 'Dich vu phau thuat', 'dich_vu_phau_thuat', 'noi_dung_phau_thuat']),
      surgery_method: firstNonEmpty(row, ['Phương pháp phẫu thuật', 'Phuong phap phau thuat', 'phuong_phap_pt', 'PPPT']),
      anesthesia_method: firstNonEmpty(row, ['PPVC', 'Phương pháp vô cảm', 'Phuong phap vo cam', 'pp_vo_cam']),
      surgery_class: firstNonEmpty(row, ['Phân loại PT', 'Phan loai PT', 'phan_loai_pt']),
      status: firstNonEmpty(row, ['Trạng thái', 'Trang thai', 'status']),
      preop_diagnosis: firstNonEmpty(row, ['Chẩn đoán trước mổ', 'Chan doan truoc mo', 'chan_doan_truoc_mo']),
      postop_diagnosis: firstNonEmpty(row, ['Chẩn đoán sau mổ', 'Chan doan sau mo', 'chan_doan_sau_mo']),
      operating_room: firstNonEmpty(row, ['Phòng mổ', 'Phong mo', 'phong_mo']),
      ...eventTemporalFields(ctx, dt),
      source: firstNonEmpty(row, ['Nguồn', 'source']) || 'surgery_raw',
      source_run_id: runId,
    };
    base.row_hash = stableHash(base);
    base.surgery_id = `surg_${base.row_hash || stableHash([idx, base.patient_code])}`;
    return base;
  }).filter(r => r.patient_code && (r.surgery_date || r.surgery_name || r.surgery_method));
  surgeryResults = dedupeSurgeryRows(surgeryResults);

  // Chỉ index theo encounter đã ghép chắc chắn. Không dùng patient_code làm fallback:
  // một bệnh nhân có thể có nhiều đợt điều trị/phẫu thuật khác nhau.
  const firstSurgeryForMedicationByEncounter = firstSurgeryByEncounter(surgeryResults);

  const existingMedRows = readCsvTable(path.join(dir, 'medication_orders.csv'), Number.MAX_SAFE_INTEGER).rows;
  const medicationRowsFromHistory = [];
  for (const row of hchanhOrderTable.rows || []) {
    for (const parsed of medicationRowsFromOrderRow(row)) {
      medicationRowsFromHistory.push({ ...parsed });
    }
  }
  const medSourceRows = [
    // medication_orders.csv là output chuẩn hóa; không feed lại chính nó để tránh nhân đôi mỗi lần normalize.
    // Chỉ giữ các dòng legacy/raw nếu file cũ chưa có med_order_id và source_run_id.
    ...existingMedRows.filter(r => !r.med_order_id && !r.source_run_id && firstNonEmpty(r, ['drug_name_raw', 'raw_line', 'Tên thuốc', 'Ten thuoc'])),
    ...medicationRowsFromHistory,
  ];
  let medicationOrders = medSourceRows.map((row, idx) => {
    const code = patientCode(row);
    const ctx = contextForRow(ctxMap, row, code);
    const rawLine = firstNonEmpty(row, ['raw_line', 'Raw line', 'Tên y lệnh', 'Ten y lenh', 'Y lệnh khác', 'Y lenh khac']);
    const rawTime = firstNonEmpty(row, ['order_datetime', 'TG y lệnh', 'TG y lenh', 'Thời gian', 'Ngày', 'order_date']);
    const drug = firstNonEmpty(row, ['drug_name_raw', 'Tên thuốc', 'Ten thuoc']) || rawLine.replace(/^\(TT\)\s*/i, '').slice(0, 180);
    const orderDate = isoDate(rawTime);
    const surgeryRef = surgeryForMedicationContext(firstSurgeryForMedicationByEncounter, ctx);
    const surgeryDate = surgeryRef ? (surgeryRef.surgery_date || isoDate(surgeryRef.surgery_datetime)) : '';
    const postopOffset = surgeryDate && orderDate ? dateOffsetDays(surgeryDate, orderDate) : '';
    const postopNumber = postopOffset === '' ? NaN : Number(postopOffset);
    const base = {
      research_code: firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']) || ctx.research_code || '',
      patient_code: code,
      encounter_id: ctx.encounter_id || '',
      encounter_match_status: encounterMatchStatus(ctx),
      order_datetime: isoDateTime(rawTime),
      order_date: orderDate,
      drug_name_raw: drug,
      drug_name_norm: normalizeDrugName(drug),
      drug_group_guess: classifyDrugGroup(drug || rawLine),
      active_ingredient: firstNonEmpty(row, ['active_ingredient', 'Hoạt chất', 'Hoat chat']),
      route_raw: firstNonEmpty(row, ['route_raw', 'Đường dùng', 'Duong dung']) || '',
      route_norm: firstNonEmpty(row, ['route_norm']) || normalizeRoute(firstNonEmpty(row, ['route_raw', 'Đường dùng', 'Duong dung']) || rawLine),
      dose_raw: firstNonEmpty(row, ['dose_raw', 'strength_raw', 'Liều', 'Lieu']) || '',
      times_per_day: firstNonEmpty(row, ['times_per_day', 'Số lần', 'So lan']),
      schedule: firstNonEmpty(row, ['schedule']),
      order_action: firstNonEmpty(row, ['order_action']),
      parser_confidence: firstNonEmpty(row, ['parser_confidence']),
      source_field: firstNonEmpty(row, ['source_field']),
      raw_line: rawLine,
      surgery_datetime_ref: surgeryRef ? (surgeryRef.surgery_datetime || '') : '',
      surgery_date_ref: surgeryDate,
      postop_day_index: Number.isFinite(postopNumber) ? String(postopNumber) : '',
      postop_day_label: Number.isFinite(postopNumber) ? `N${postopNumber}` : '',
      // Không có surgery reference thì để missing, không biến unknown thành 0.
      is_postop_day_1_3: Number.isFinite(postopNumber) ? (postopNumber >= 1 && postopNumber <= 3 ? '1' : '0') : '',
      ...eventTemporalFields(ctx, rawTime),
      source: firstNonEmpty(row, ['source', 'Nguồn']) || 'hchanh_order_history',
      source_run_id: runId,
    };
    base.row_hash = stableHash(base);
    base.med_order_id = `med_${base.row_hash || stableHash([idx, base.patient_code])}`;
    return base;
  }).filter(r => r.patient_code && r.drug_name_raw);
  medicationOrders = dedupeRowsByHash(medicationOrders);

  const medicationDayMap = new Map();
  for (const med of medicationOrders) {
    if (!med.patient_code || !med.encounter_id || !med.order_date) continue;
    if (med.encounter_match_status !== 'matched' || med.is_within_encounter === '0') continue;
    const key = [med.patient_code, med.encounter_id || '', med.order_date].join('|');
    const bucket = medicationDayMap.get(key) || {
      research_code: med.research_code,
      patient_code: med.patient_code,
      encounter_id: med.encounter_id,
      order_date: med.order_date,
      drug_count: 0,
      routeSet: new Set(),
      drugs: [],
      source_run_id: runId,
    };
    bucket.drug_count += 1;
    if (med.route_norm) bucket.routeSet.add(med.route_norm);
    if (med.drug_name_raw) bucket.drugs.push(med.drug_name_raw);
    medicationDayMap.set(key, bucket);
  }
  const medicationDaySummary = Array.from(medicationDayMap.values()).map(b => {
    const row = {
      research_code: b.research_code,
      patient_code: b.patient_code,
      encounter_id: b.encounter_id,
      order_date: b.order_date,
      drug_count: b.drug_count,
      route_set: Array.from(b.routeSet).join('; '),
      drugs_display: b.drugs.slice(0, 20).join('; '),
      drugs_json: JSON.stringify(b.drugs),
      source_run_id: runId,
    };
    row.row_hash = stableHash(row);
    return row;
  });

  let clinicalNotes = (hchanhOrderTable.rows || []).map((row, idx) => {
    const code = patientCode(row);
    const ctx = contextForRow(ctxMap, row, code);
    const rawTime = firstNonEmpty(row, ['TG y lệnh', 'TG y lenh', 'Thời gian', 'Ngày']);
    const base = {
      research_code: firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']) || ctx.research_code || '',
      patient_code: code,
      encounter_id: ctx.encounter_id || '',
      encounter_match_status: encounterMatchStatus(ctx),
      note_datetime: isoDateTime(rawTime),
      note_date: isoDate(rawTime),
      doctor_name: firstNonEmpty(row, ['Bác sĩ', 'Bac si', 'doctor_name']),
      note_type: 'order_history',
      clinical_text: firstNonEmpty(row, ['Diễn biến', 'Dien bien']),
      order_text: [firstNonEmpty(row, ['Tên y lệnh', 'Ten y lenh']), firstNonEmpty(row, ['Y lệnh khác', 'Y lenh khac'])].filter(Boolean).join('\n'),
      status: firstNonEmpty(row, ['Trạng thái', 'Trang thai', 'status']),
      ...eventTemporalFields(ctx, rawTime),
      source: firstNonEmpty(row, ['Nguồn', 'source']) || 'hchanh_order_history',
      source_run_id: runId,
    };
    base.row_hash = stableHash(base);
    base.note_id = `note_${base.row_hash || stableHash([idx, base.patient_code])}`;
    return base;
  }).filter(r => r.patient_code && (r.clinical_text || r.order_text));
  clinicalNotes = dedupeRowsByHash(clinicalNotes);

  let clinicalEvents = [];
  for (const row of hchanhOrderTable.rows || []) {
    const code = patientCode(row);
    if (!code) continue;
    const ctx = contextForRow(ctxMap, row, code);
    const rawTime = firstNonEmpty(row, ['TG y lệnh', 'TG y lenh', 'Thời gian', 'Ngày']);
    const { clinical_text: clinicalText } = dedupeOrderFields(row);
    for (const parsed of extractClinicalEvents(clinicalText)) {
      const base = {
        research_code: firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']) || ctx.research_code || '',
        patient_code: code,
        encounter_id: ctx.encounter_id || '',
        encounter_match_status: encounterMatchStatus(ctx),
        event_datetime: isoDateTime(rawTime),
        event_date: isoDate(rawTime),
        doctor_name: firstNonEmpty(row, ['Bác sĩ', 'Bac si', 'doctor_name']),
        event_type: parsed.event_type || '',
        event_subtype: parsed.event_subtype || '',
        value_raw: parsed.value_raw || '',
        value_norm: parsed.value_norm || '',
        negated: parsed.negated || '0',
        certainty: parsed.certainty || 'observed',
        source_text: parsed.source_text || '',
        parser_rule: parsed.parser_rule || '',
        confidence: parsed.confidence || '',
        ...eventTemporalFields(ctx, rawTime),
        source: firstNonEmpty(row, ['Nguồn', 'source']) || 'hchanh_order_history',
        source_run_id: runId,
      };
      base.row_hash = stableHash(base);
      base.clinical_event_id = `ce_${base.row_hash}`;
      clinicalEvents.push(base);
    }
  }
  clinicalEvents = dedupeRowsByHash(clinicalEvents);

  const labByEncounter = byEncounterCount(labResults, 'lab_date');
  const imagingByEncounter = byEncounterCount(imagingResults, 'order_date');
  const surgeryByEncounter = byEncounterCount(surgeryResults, 'surgery_date');
  const medicationByEncounter = byEncounterCount(medicationOrders, 'order_date');
  const patientDayMap = new Map();
  function ensurePatientDay(row, date) {
    if (!row.patient_code || !row.encounter_id || !date) return null;
    if (row.encounter_match_status && row.encounter_match_status !== 'matched') return null;
    if (row.is_within_encounter === '0') return null;
    const key = [row.patient_code, row.encounter_id || '', date].join('|');
    if (!patientDayMap.has(key)) {
      const ctx = contextForRow(ctxMap, row, row.patient_code);
      patientDayMap.set(key, {
        research_code: row.research_code || ctx.research_code || '',
        patient_code: row.patient_code,
        encounter_id: row.encounter_id || ctx.encounter_id || '',
        date,
        hospital_day: daysBetween(ctx.admission_date, date),
        has_lab: '0', lab_count: 0,
        has_imaging: '0', imaging_count: 0,
        has_surgery: '0', surgery_count: 0,
        has_medication: '0', medication_count: 0,
        hb: '', hct: '', neutrophil: '', lymphocyte: '', monocyte: '', rdw: '', plt: '',
        creatinine: '', egfr: '', wbc: '', crp: '',
        source_run_id: runId,
      });
    }
    return patientDayMap.get(key);
  }
  const pdLabMap = {
    hemoglobin: 'hb', hct: 'hct', neutrophil: 'neutrophil', lymphocyte: 'lymphocyte', monocyte: 'monocyte', rdw: 'rdw', platelet: 'plt',
    creatinine: 'creatinine', egfr: 'egfr', wbc: 'wbc', crp: 'crp',
  };
  for (const lab of labResults) {
    const pd = ensurePatientDay(lab, lab.lab_date);
    if (!pd) continue;
    pd.has_lab = '1';
    pd.lab_count += 1;
    const col = pdLabMap[lab.test_name_norm];
    if (col) {
      const timeKey = `_${col}_time`;
      const oldTime = pd[timeKey] || '';
      const newTime = String(lab.lab_datetime || '');
      const shouldReplace = !pd[col]
        || (!oldTime && Boolean(newTime))
        || (Boolean(oldTime) && Boolean(newTime) && newTime.localeCompare(oldTime) < 0);
      if (shouldReplace) {
        pd[col] = lab.result_raw;
        pd[timeKey] = newTime;
      }
    }
  }
  for (const img of imagingResults) {
    const pd = ensurePatientDay(img, img.order_date);
    if (!pd) continue;
    pd.has_imaging = '1';
    pd.imaging_count += 1;
  }
  for (const surg of surgeryResults) {
    const pd = ensurePatientDay(surg, surg.surgery_date);
    if (!pd) continue;
    pd.has_surgery = '1';
    pd.surgery_count += 1;
  }
  for (const med of medicationOrders) {
    const pd = ensurePatientDay(med, med.order_date);
    if (!pd) continue;
    pd.has_medication = '1';
    pd.medication_count += 1;
  }
  const patientDay = Array.from(patientDayMap.values()).map(pd => {
    for (const key of Object.keys(pd)) if (/^_.*_time$/.test(key)) delete pd[key];
    pd.row_hash = stableHash(pd);
    return pd;
  }).sort((a, b) => `${a.patient_code}|${a.encounter_id}|${a.date}`.localeCompare(`${b.patient_code}|${b.encounter_id}|${b.date}`));

  const firstLabByEncounter = new Map();
  for (const lab of labResults) {
    const col = pdLabMap[lab.test_name_norm];
    if (!col) continue;
    const key = lab.encounter_id;
    if (!key || lab.encounter_match_status !== 'matched' || lab.is_within_encounter === '0') continue;
    const bucket = firstLabByEncounter.get(key) || {};
    const oldTime = bucket[`_${col}_time`] || '';
    const newTime = String(lab.lab_datetime || '');
    // Không để dòng thiếu thời gian thắng dòng có thời gian chỉ vì chuỗi rỗng sort trước.
    const shouldReplace = !bucket[col]
      || (!oldTime && Boolean(newTime))
      || (Boolean(oldTime) && Boolean(newTime) && newTime.localeCompare(oldTime) < 0);
    if (shouldReplace) {
      bucket[col] = lab.result_raw;
      bucket[`_${col}_time`] = newTime;
    }
    firstLabByEncounter.set(key, bucket);
  }
  // Đặt tên khác với hàm firstSurgeryByEncounter import ở đầu file (dùng cho
  // medication linkage, dòng ~4861 trong cùng hàm này) — trùng tên biến const
  // sẽ khiến JS coi cả hàm này nằm trong "vùng chết tạm thời" (TDZ) của tên đó
  // ngay từ đầu, làm lệnh gọi hàm import ở trên ném lỗi "Cannot access before
  // initialization" mỗi khi chạy nhánh không lấy từ cache.
  // Chỉ ghép theo đúng lượt điều trị (dòng thiếu encounter_id không phát tán sang mọi
  // lượt của cùng người bệnh). Dùng chung quy tắc chọn ca mổ đầu tiên với y lệnh.
  const firstSurgeryByEncounterMap = firstSurgeryByEncounter(surgeryResults);
  const imagingTextByEncounter = new Map();
  for (const img of imagingResults) {
    const key = img.encounter_id;
    if (!key || img.encounter_match_status !== 'matched' || img.is_within_encounter === '0') continue;
    const old = imagingTextByEncounter.get(key) || '';
    imagingTextByEncounter.set(key, `${old}\n${img.service_name_raw || ''}\n${img.result_text || ''}\n${img.conclusion_text || ''}`.trim());
  }
  markNormalizeStage(dir, 5, 'Bảng phân tích');
  const analysisReady = finalEncounters.map(enc => {
    const p = patientByCode.get(enc.patient_code) || {};
    const labs = firstLabByEncounter.get(enc.encounter_id) || {};
    const surg = firstSurgeryByEncounterMap.get(enc.encounter_id) || {};
    const diagnosisText = [enc.diagnosis_raw, enc.admission_diagnosis, enc.discharge_diagnosis, imagingTextByEncounter.get(enc.encounter_id) || ''].join('\n');
    const sDate = surg.surgery_datetime || surg.surgery_date || enc.surgery_date || '';

    // Sinh các inference fields theo preset của nghiên cứu
    const inferredFields = {};
    for (const inf of preset.inference_fields) {
      inferredFields[inf.key] = _runInference(inf.fn, diagnosisText);
    }

    // Custom fields: pattern matching trên diagnosisText
    // diagnosisText được chuẩn hóa bỏ dấu; pattern cũng phải được chuẩn hóa tương ứng.
    // Field boolean luôn trả 1/0, không dùng chuỗi rỗng để tránh nhầm "0" với missing.
    const customFieldValues = evaluateCustomFields(customFields, normalizeSimple(diagnosisText));

    // needs_manual_review: chạy checks của preset + cờ ghép encounter không chắc chắn.
    const reviewItems = String(enc.needs_manual_review || '').split(';').map(x => x.trim()).filter(Boolean);
    for (const chk of preset.needs_review_checks) {
      const val = chk.field === 'surgery_date' ? sDate : (inferredFields[chk.field] || '');
      if (!val) reviewItems.push(chk.empty_label);
    }

    const row = {
      research_code: enc.research_code,
      encounter_id: enc.encounter_id,
      patient_code: enc.patient_code,
      patient_name: p.patient_name || '',
      sex: p.sex || '',
      birth_year: p.birth_year || '',
      age: ageAtEncounter(p.birth_date, enc.admission_date) || p.age || '',
      admission_date: enc.admission_date,
      surgery_date: sDate,
      discharge_date: enc.discharge_date,
      hospital_stay_days: enc.treatment_duration || daysBetween(enc.admission_date, enc.discharge_date),
      time_to_surgery_hours: hoursBetween(enc.admission_date, sDate),
      diagnosis_raw: enc.diagnosis_raw,
      ...inferredFields,
      ...customFieldValues,
      surgery_name: surg.surgery_name || '',
      surgery_method: surg.surgery_method || '',
      anesthesia_method: surg.anesthesia_method || '',
      comorbidity_text: enc.comorbidity_text || '',
      complication_text: enc.complication_text || '',
      hb: labs.hb || '', hct: labs.hct || '', neutrophil: labs.neutrophil || '', lymphocyte: labs.lymphocyte || '', monocyte: labs.monocyte || '', rdw: labs.rdw || '', plt: labs.plt || '',
      imaging_summary: (imagingTextByEncounter.get(enc.encounter_id) || '').slice(0, 1200),
      needs_manual_review: reviewItems.join('; '),
      source_run_id: runId,
    };
    row.row_hash = stableHash(row);
    return row;
  });

  const progress = readJsonSafe(path.join(dir, 'progress.json'), {});
  const hchanhProgress = readJsonSafe(path.join(dir, 'hchanh_auto_progress.json'), {});
  const orderProgress  = readJsonSafe(path.join(dir, 'order_history_auto_progress.json'), {});

  const encounterCountByPatient = new Map();
  for (const enc of finalEncounters) {
    encounterCountByPatient.set(enc.patient_code, (encounterCountByPatient.get(enc.patient_code) || 0) + 1);
  }

  function progressMatchScore(key, entry, enc) {
    if (!entry || typeof entry !== 'object') return -1;
    const entryEncounter = String(entry.encounter_id || '').trim();
    if (key === enc.encounter_id || entryEncounter === enc.encounter_id) return 100;

    const entryResearch = String(entry.research_code || entry['Mã NC'] || '').trim();
    if (entryResearch && enc.research_code && entryResearch === enc.research_code) return 90;

    const entryCode = String(entry.ma_bn || entry['Mã BN'] || key.split('|')[0] || '').trim();
    if (!entryCode || entryCode !== enc.patient_code) return -1;

    const entryAdmission = isoDateTime(entry.admission_date || entry['Ngày vào viện'] || '')
      || isoDate(entry.admission_date || entry['Ngày vào viện'] || '');
    const entryDischarge = isoDateTime(entry.discharge_date || entry['Ngày ra viện'] || '')
      || isoDate(entry.discharge_date || entry['Ngày ra viện'] || '');
    const encAdmission = isoDateTime(enc.admission_date) || isoDate(enc.admission_date);
    const encDischarge = isoDateTime(enc.discharge_date) || isoDate(enc.discharge_date);
    if (entryAdmission && encAdmission && entryAdmission === encAdmission) {
      if (!entryDischarge || !encDischarge || entryDischarge === encDischarge) return 70;
    }

    // Chỉ fallback theo Mã BN khi chắc chắn người bệnh chỉ có đúng một lượt trong cohort.
    return encounterCountByPatient.get(enc.patient_code) === 1 ? 10 : -1;
  }

  function bestProgressEntry(progressMap, enc, fileKey = '') {
    let best = null;
    let bestScore = -1;
    let bestTime = '';
    for (const [key, entry] of Object.entries(progressMap || {})) {
      if (key.startsWith('__') || !entry || typeof entry !== 'object') continue;
      if (fileKey && !(Array.isArray(entry.files) && entry.files.includes(fileKey))) continue;
      const score = progressMatchScore(key, entry, enc);
      if (score < 0) continue;
      const time = String(entry.updated_at || entry.finished_at || entry.started_at || '');
      const completedBonus = (entry.committed === true || entry.status === 'done') ? 5 : 0;
      const totalScore = score + completedBonus;
      if (!best || totalScore > bestScore || (totalScore === bestScore && time > bestTime)) {
        best = entry;
        bestScore = totalScore;
        bestTime = time;
      }
    }
    return best || {};
  }

  function statusFromProgressEntry(entry, fileKey = '') {
    if (!entry || typeof entry !== 'object') return '';
    // Có trạng thái riêng từng file (bản mới) thì dùng, không dùng trạng thái chung của cả ca.
    if (fileKey && entry.file_status?.[fileKey]) return hchanhEntryFileStatus(entry, fileKey);
    if (entry.status === 'done') return 'done';
    if (entry.status === 'error') return 'error';
    if (entry.status === 'partial') return 'partial';
    return entry.status || '';
  }

  const extractStatus = finalEncounters.map(enc => {
    const code = enc.patient_code;
    const item = bestProgressEntry(progress, enc);
    const popup = item.popup || item.status || '';
    const xn = item.xn || '';
    const cdha = item.cdha || '';

    // Trạng thái hành chánh theo từng file
    const profileStatus      = statusFromProgressEntry(bestProgressEntry(hchanhProgress, enc, 'profile'), 'profile');
    const dischargeStatus    = statusFromProgressEntry(bestProgressEntry(hchanhProgress, enc, 'discharge'), 'discharge');
    const surgeryStatus      = statusFromProgressEntry(bestProgressEntry(hchanhProgress, enc, 'surgery'), 'surgery');
    const orderHistoryStatus = statusFromProgressEntry(bestProgressEntry(orderProgress, enc, 'order_history'), 'order_history')
      || statusFromProgressEntry(bestProgressEntry(hchanhProgress, enc, 'order_history'), 'order_history');

    const isErr = v => v === 'error' || v === 'blocked';
    const hasError = item.error || isErr(popup) || isErr(xn) || isErr(cdha)
      || isErr(profileStatus) || isErr(dischargeStatus)
      || isErr(surgeryStatus) || isErr(orderHistoryStatus);
    // "empty" = EMR xác nhận không có → đã lấy xong phần đó.
    const got = v => v === 'done' || v === 'empty';
    const xnCdhaDone = popup === 'done' && got(xn) && got(cdha);
    const hchanhDone = got(profileStatus) && got(dischargeStatus);
    const surgeryRequired = surgeryByEncounter.get(enc.encounter_id)?.total > 0 || enc.surgery_date;
    const orderRequired = surgeryRequired || medicationByEncounter.get(enc.encounter_id)?.total > 0;
    const surgeryDone = !surgeryRequired || got(surgeryStatus);
    const orderDone = !orderRequired || got(orderHistoryStatus);
    const missingRequired = [];
    if (!xnCdhaDone) missingRequired.push('xn_cdha');
    if (!got(profileStatus)) missingRequired.push('profile');
    if (!got(dischargeStatus)) missingRequired.push('discharge');
    if (!surgeryDone) missingRequired.push('surgery');
    if (!orderDone) missingRequired.push('order_history');
    const encounterUnsafe = /encounter_match_(?:ambiguous|missing)/.test(String(enc.needs_manual_review || ''));
    if (encounterUnsafe) missingRequired.push('encounter_match');
    const readyForAnalysis = !hasError && missingRequired.length === 0;
    const completionLevel = readyForAnalysis
      ? 'full_required'
      : (xnCdhaDone && hchanhDone ? 'clinical_admin' : xnCdhaDone ? 'xn_cdha' : 'partial');
    const overall = readyForAnalysis
      ? 'done'
      : hasError ? 'error' : 'pending';

    return {
      research_code: enc.research_code || '',
      encounter_id: enc.encounter_id || '',
      patient_code: code,
      patient_name: patientByCode.get(code)?.patient_name || '',
      popup_status: popup,
      xn_status: xn,
      cdha_status: cdha,
      profile_status: profileStatus,
      discharge_status: dischargeStatus,
      surgery_status: surgeryStatus,
      order_history_status: orderHistoryStatus,
      overall_status: overall,
      completion_level: completionLevel,
      ready_for_analysis: readyForAnalysis ? '1' : '0',
      missing_required: missingRequired.join('; '),
      lab_count: labByEncounter.get(enc.encounter_id)?.total || 0,
      imaging_count: imagingByEncounter.get(enc.encounter_id)?.total || 0,
      surgery_count: surgeryByEncounter.get(enc.encounter_id)?.total || 0,
      medication_count: medicationByEncounter.get(enc.encounter_id)?.total || 0,
      last_error: item.error || '',
      source_run_id: runId,
    };
  });

  // Mã người bệnh giả danh: mọi bảng có patient_code có thêm patient_key, lấy từ bảng liên
  // kết riêng của kho (patient_link.csv). Dataset/phân tích chỉ mang patient_key.
  const patientLink = loadPatientLink(patientLinkPath(dir));
  const keyStamp = nowIso();
  for (const rows of [patients, finalEncounters, diagnoses, labResults, imagingResults, surgeryResults,
    medicationOrders, medicationDaySummary, clinicalNotes, clinicalEvents, patientDay, analysisReady, extractStatus]) {
    applyPatientKeys(patientLink, rows, keyStamp);
  }
  savePatientLink(patientLink);

  writeCsv(path.join(dir, 'patients.csv'), NORMALIZED_COLUMNS.patients, patients);
  markNormalizeStage(dir, 6, 'Ghi bảng chuẩn');
  writeCsv(path.join(dir, 'encounters.csv'), NORMALIZED_COLUMNS.encounters, finalEncounters);
  writeCsv(path.join(dir, 'diagnoses.csv'), NORMALIZED_COLUMNS.diagnoses, diagnoses);
  writeCsv(path.join(dir, 'lab_results.csv'), NORMALIZED_COLUMNS.lab_results, labResults);
  writeCsv(path.join(dir, 'imaging_results.csv'), NORMALIZED_COLUMNS.imaging_results, imagingResults);
  writeCsv(path.join(dir, 'surgery_results.csv'), NORMALIZED_COLUMNS.surgery_results, surgeryResults);
  writeCsv(path.join(dir, 'medication_orders.csv'), NORMALIZED_COLUMNS.medication_orders, medicationOrders);
  writeCsv(path.join(dir, 'medication_day_summary.csv'), NORMALIZED_COLUMNS.medication_day_summary, medicationDaySummary);
  writeCsv(path.join(dir, 'clinical_notes.csv'), NORMALIZED_COLUMNS.clinical_notes, clinicalNotes);
  writeCsv(path.join(dir, 'clinical_events.csv'), NORMALIZED_COLUMNS.clinical_events, clinicalEvents);
  writeCsv(path.join(dir, 'patient_day.csv'), NORMALIZED_COLUMNS.patient_day, patientDay);
  // Cột analysis_ready = cột cố định + inference fields của preset + custom fields
  const analysisReadyBaseCols = [
    'research_code', 'encounter_id', 'patient_code', 'patient_key', 'patient_name', 'sex', 'birth_year', 'age',
    'admission_date', 'surgery_date', 'discharge_date', 'hospital_stay_days', 'time_to_surgery_hours',
    'diagnosis_raw',
  ];
  const inferenceColKeys = preset.inference_fields.map(f => f.key);
  const customColKeys    = customFields.filter(cf => cf.name).map(cf => cf.name);
  const analysisReadyTrailCols = [
    'surgery_name', 'surgery_method', 'anesthesia_method', 'comorbidity_text', 'complication_text',
    'hb', 'hct', 'neutrophil', 'lymphocyte', 'monocyte', 'rdw', 'plt',
    'imaging_summary', 'needs_manual_review', 'source_run_id', 'row_hash',
  ];
  const analysisReadyCols = [...analysisReadyBaseCols, ...inferenceColKeys, ...customColKeys, ...analysisReadyTrailCols];
  writeCsv(path.join(dir, 'analysis_ready.csv'), analysisReadyCols, analysisReady);

  const variableSelectionSpec = analysisConfig.variable_selection || null;
  const selectedAnalysis = buildSelectedAnalysisForRun(dir, analysisReady, {
    analysis_ready: analysisReady,
    patients,
    patient_master: patients,
    encounters: finalEncounters,
    diagnoses,
    lab_results: labResults,
    imaging_results: imagingResults,
    surgery_results: surgeryResults,
    medication_orders: medicationOrders,
    medication_day_summary: medicationDaySummary,
    clinical_notes: clinicalNotes,
    clinical_events: clinicalEvents,
    patient_day: patientDay,
  }, variableSelectionSpec);
  if (!selectedAnalysis) {
    try { fs.unlinkSync(path.join(dir, 'analysis_selected.csv')); } catch (_) {}
    try { fs.unlinkSync(path.join(dir, 'analysis_selection_manifest.json')); } catch (_) {}
  }

  // analysis_final.csv của lần trước không còn khớp dữ liệu mới nên bị gỡ, nhưng luôn
  // được lưu bản sao (nếu chưa có) trong datasets/ để không mất dataset đã chốt.
  snapshotFinalDatasetIfUnsaved(dir, 'superseded_by_normalize');
  try { fs.unlinkSync(path.join(dir, 'analysis_final.csv')); } catch (_) {}
  writeCsv(path.join(dir, 'extract_status.csv'), NORMALIZED_COLUMNS.extract_status, extractStatus);

  // research_source.csv có thể vừa được tạo ở đầu normalize, nên tính lại signature
  // trước khi ghi manifest để lần bấm Chuẩn hóa sau có thể trả kết quả ngay.
  inputSignature = normalizeInputSignature(dir);
  const manifest = readJsonSafe(manifestPath, {});
  const outputs = {
    initial_list: initialTable.rows.length,
    research_source: sourceTable.rows.length || sourceInfo.rows?.length || 0,
    deep_source: deepTable.rows.length,
    raw_patients: patientTable.rows.length,
    patient_extra: extraTable.rows.length,
    hchanh_profile: hchanhProfileTable.rows.length,
    hchanh_discharge: hchanhDischargeTable.rows.length,
    hchanh_surgery: hchanhSurgeryTable.rows.length,
    hchanh_order_history: hchanhOrderTable.rows.length,
    patients: patients.length,
    encounters: finalEncounters.length,
    diagnoses: diagnoses.length,
    lab_results: labResults.length,
    unmatched_lab_results: labResults.filter(row => row.encounter_match_status !== 'matched').length,
    imaging_results: imagingResults.length,
    unmatched_imaging_results: imagingResults.filter(row => row.encounter_match_status !== 'matched').length,
    surgery_results: surgeryResults.length,
    unmatched_surgery_results: surgeryResults.filter(row => row.encounter_match_status !== 'matched').length,
    medication_orders: medicationOrders.length,
    unmatched_medication_orders: medicationOrders.filter(row => row.encounter_match_status !== 'matched').length,
    medication_day_summary: medicationDaySummary.length,
    clinical_notes: clinicalNotes.length,
    clinical_events: clinicalEvents.length,
    patient_day: patientDay.length,
    analysis_ready: analysisReady.length,
    analysis_selected: selectedAnalysis ? selectedAnalysis.rows : 0,
    extract_status: extractStatus.length,
    kho_nguoi_benh: khoOverlay ? {
      cases: khoOverlay.cases_in_kho,
      filled: Object.values(khoOverlay.filled).reduce((a, b) => a + b, 0),
      replaced_by_goc: Object.values(khoOverlay.replaced_by_goc).reduce((a, b) => a + b, 0),
      provisional: khoOverlay.provisional.length,
      xn_cases: khoOverlay.results?.filled_cases?.xn || 0,
      cdha_cases: khoOverlay.results?.filled_cases?.cdha || 0,
    } : null,
  };
  let database = null;
  let databaseError = '';
  try {
    markNormalizeStage(dir, 7, 'Nạp cơ sở dữ liệu SQLite');
    database = syncDatabaseForRun(dir, { runId, inputSignature, force: true });
  } catch (err) {
    databaseError = String(err?.message || err);
    console.warn('[RESEARCH][SQLITE] Không tạo/cập nhật được SQLite:', databaseError);
  }
  const databasePublic = database
    ? publicDatabaseInfo(database)
    : publicDatabaseInfo(databaseInfo(datasetDirFromRunDir(dir)));
  const databaseStatus = databaseError ? 'failed' : 'ok';

  markNormalizeStage(dir, 8, 'Kiểm tra chất lượng');
  const qaReport = quality.buildQualityReport({
    runId,
    runDir: dir,
    duplicatesRemoved: {
      lab_results: 0,
      imaging_results: imagingResultsAll.length - imagingResults.length,
    },
    tables: {
      patients, encounters: finalEncounters, diagnoses,
      lab_results: labResults, imaging_results: imagingResults, surgery_results: surgeryResults,
      medication_orders: medicationOrders, clinical_notes: clinicalNotes, clinical_events: clinicalEvents, analysis_ready: analysisReady,
    },
    inputCounts: {
      initial_list: outputs.initial_list, research_source: outputs.research_source,
      hchanh_profile: outputs.hchanh_profile, hchanh_discharge: outputs.hchanh_discharge,
      hchanh_surgery: outputs.hchanh_surgery, hchanh_order_history: outputs.hchanh_order_history,
      lich_su_xn: countCsvRows(path.join(dir, 'lich_su_xn.csv')), lich_su_cdha: countCsvRows(path.join(dir, 'lich_su_cdha.csv')),
    },
    databaseManifest: databaseError ? null : databaseInfo(datasetDirFromRunDir(dir)),
    databaseError,
    csvFilesInDatabase: ['patients.csv', 'encounters.csv', 'lab_results.csv', 'imaging_results.csv', 'surgery_results.csv', 'medication_orders.csv', 'clinical_notes.csv', 'clinical_events.csv', 'analysis_ready.csv'],
    inferenceFields: preset.inference_fields || [],
  });
  writeJsonAtomic(path.join(dir, quality.QA_REPORT_FILE), { ...qaReport, review: undefined });
  writeCsv(path.join(dir, quality.ENCOUNTER_REVIEW_FILE),
    ['encounter_id', 'research_code', 'patient_code', 'issue', 'detail', 'related_encounter_id', 'source_status'],
    qaReport.review);
  const qaSummary = { status: qaReport.status, blocking_count: qaReport.blocking_count, warning_count: qaReport.warning_count, review_count: qaReport.review_count };
  const version = quality.codeVersion(ROOT_DIR);
  try {
    // Nhật ký chỉ ghi nối tiếp: mỗi lần chuẩn hóa một dòng, không ghi đè lần trước.
    fs.appendFileSync(path.join(dir, quality.NORMALIZE_HISTORY_FILE), `${JSON.stringify({
      at: nowIso(),
      run_id: runId,
      normalized_schema_version: NORMALIZED_SCHEMA_VERSION,
      input_signature: inputSignature,
      ...version,
      analysis_preset: analysisConfig.preset || 'general',
      variable_selection_hash: stableHash(analysisConfig.variable_selection || null),
      counts: outputs,
      database_status: databaseStatus,
      qa: qaSummary,
    })}\n`, 'utf-8');
  } catch (err) {
    console.warn('[RESEARCH][HISTORY] Không ghi được normalize_history.jsonl:', err.message);
  }

  // Đọc lại manifest ngay trước khi ghi: Thu thập có thể chạy song song và vừa ghi thêm thông tin.
  writeJsonAtomic(manifestPath, {
    ...(readJsonSafe(manifestPath, null) || manifest),
    normalized_at: nowIso(),
    normalized_schema_version: NORMALIZED_SCHEMA_VERSION,
    normalized_input_signature: inputSignature,
    normalized_outputs: outputs,
    normalized_database: databasePublic,
    normalized_database_status: databaseStatus,
    normalized_qa: qaSummary,
    normalized_code_version: version,
    variable_selection_applied: Boolean(selectedAnalysis),
    variable_selection_output: selectedAnalysis ? { rows: selectedAnalysis.rows, columns: selectedAnalysis.columns } : null,
  });
  return { ...outputs, cached: false, input_signature: inputSignature, database: databasePublic, database_status: databaseStatus, qa: qaSummary };
}

function normalizeArchiveLatest() {
  const runId = resolveArchiveRunId('latest');
  if (!runId) throw new Error('Kho dữ liệu gốc chưa có run để chuẩn hóa.');
  const runDir = path.join(archiveRunsDir(), runId);
  const counts = normalizeRunOutputs(runDir, { sourceRunId: runId });
  return { run_id: runId, counts };
}

function normalizeStudyLatest(studyId) {
  const runId = resolveRunId(studyId, 'latest');
  if (!runId) throw new Error('Nghiên cứu chưa có run để chuẩn hóa.');
  const runDir = path.join(runsDir(studyId), runId);
  const counts = normalizeRunOutputs(runDir, { sourceRunId: runId });
  return { run_id: runId, counts };
}

// Ghép một dòng danh sách ban đầu với lượt điều trị đã chuẩn hóa của kho: theo mã lượt (cùng cách
// tạo khi chuẩn hóa), rồi Mã BN + ngày vào viện, rồi Mã BN nếu người bệnh chỉ có một lượt.
// Trả các trường định danh lượt để lọc, hoặc {} nếu không ghép chắc được.
function archiveEncounterLinker(runDir) {
  const file = ['analysis_ready.csv', 'encounters.csv'].map(f => path.join(runDir, f)).find(f => fs.existsSync(f));
  const rows = file ? (readCsvTable(file, Number.MAX_SAFE_INTEGER).rows || []) : [];
  const byEid = new Map();
  const byVisit = new Map();
  const byPatient = new Map();
  const push = (map, key, row) => { if (!key) return; if (!map.has(key)) map.set(key, []); map.get(key).push(row); };
  for (const row of rows) {
    const pc = patientCode(row);
    push(byEid, getCell(row, ['encounter_id']), row);
    if (pc) {
      push(byVisit, `${pc}|${isoDate(getCell(row, ['admission_date']))}`, row);
      push(byPatient, pc, row);
    }
  }
  const only = list => (list && list.length === 1 ? list[0] : null);
  const ADMISSION = ['Ngày vào viện', 'Ngay vao vien', 'Ngày nhập viện', 'Ngay nhap vien', 'T/G vào', 'TG vao', 'admission_date'];
  return (row) => {
    const pc = patientCode(row);
    const admission = isoDate(firstNonEmpty(row, ADMISSION));
    const hit = only(byEid.get(buildEncounterId(row)))
      || (pc && admission ? only(byVisit.get(`${pc}|${admission}`)) : null)
      || (pc && !admission ? only(byPatient.get(pc)) : null);
    if (!hit) return {};
    const out = {};
    for (const key of ['encounter_id', 'research_code', 'patient_key', 'admission_date', 'discharge_date', 'surgery_date']) {
      const value = getCell(hit, [key]);
      if (value && !getCell(row, [key])) out[key] = value;
    }
    return out;
  };
}

function importArchiveToStudy(study, filters) {
  const archive = readArchive();
  if (!archive.latest_run?.id) throw new Error('Kho dữ liệu gốc chưa có lần quét dữ liệu.');
  const archiveRunId = archive.latest_run.id;
  let patientFile = archiveTablePath('initial_list', archiveRunId);
  let patientData = readCsvTable(patientFile, Number.MAX_SAFE_INTEGER);
  if (!patientData.rows.length) {
    patientFile = archiveTablePath('patients', archiveRunId);
    patientData = readCsvTable(patientFile, Number.MAX_SAFE_INTEGER);
  }
  if (!patientData.rows.length) throw new Error('Kho dữ liệu gốc chưa có bảng dữ liệu ban đầu để lọc người bệnh.');

  const dateFilteredPatients = patientData.rows.filter(row => rowPassesDateFilter(row, filters));
  const selection = sanitizeVariableSelection(filters?.variable_selection || activeVariableSelectionFromStudy(study));
  const archiveRunDir = path.join(archiveRunsDir(), archiveRunId);
  const tableRowsByKey = loadRunTablesForSelection(archiveRunDir, selection, dateFilteredPatients);
  // Danh sách ban đầu chỉ có Mã BN + giờ vào viện, không có mã lượt/Mã NC: điều kiện trên y lệnh thuốc,
  // XN... (ghép theo mã lượt) sẽ không khớp lượt nào. Gắn mã lượt từ bảng lượt điều trị của kho (bản sao
  // chỉ dùng để lọc) để kết quả giống hệt bước "Kiểm tra & xuất dữ liệu"; file danh sách mẫu giữ dòng gốc.
  const linkEncounter = archiveEncounterLinker(archiveRunDir);
  const probes = dateFilteredPatients.map(row => ({ row, probe: { ...row, ...linkEncounter(row) } }));
  const selectionResult = variableSelection.filterCohortRowsByVariableSelection(probes.map(p => p.probe), selection, tableRowsByKey);
  const keptProbes = new Set(selectionResult.rows);
  // Danh sách ban đầu có thể có nhiều dòng cho cùng một lượt (vd. chuyển khoa, dòng lặp): giữ một dòng
  // mỗi lượt để số mẫu khớp số lượt ở bước xem trước và không thu thập trùng.
  const seenEncounters = new Set();
  const selectedPatients = variableSelection.hasActiveSelection(selection)
    ? probes.filter(p => {
      if (!keptProbes.has(p.probe)) return false;
      const eid = p.probe.encounter_id;
      if (!eid) return true;
      if (seenEncounters.has(eid)) return false;
      seenEncounters.add(eid);
      return true;
    }).map(p => p.row)
    : dateFilteredPatients;
  const selectedVisits = selectedPatients.filter(row => patientCode(row));
  if (!selectedVisits.length) throw new Error(variableSelection.hasActiveSelection(selection)
    ? 'Không có bệnh nhân phù hợp điều kiện lọc và variable selection.'
    : 'Không có bệnh nhân phù hợp điều kiện lọc.');

  ensureDir(studyDir(study.id));
  const usedCodes = new Set();
  const cohortRows = selectedVisits.map((row, index) => {
    const next = { ...row };
    let code = getCell(next, ['Mã NC', 'Ma NC', 'research_code']);
    if (!code || usedCodes.has(code)) code = `NC${String(index + 1).padStart(4, '0')}`;
    usedCodes.add(code);
    next['Mã NC'] = code;
    return next;
  });
  const cohortColumns = [...patientData.columns];
  if (!cohortColumns.includes('Mã NC')) cohortColumns.unshift('Mã NC');
  writeCsv(cohortPath(study.id), cohortColumns, cohortRows);

  // Không copy dữ liệu XN/CĐHA/Thuốc từ kho gốc sang nghiên cứu.
  // Nghiên cứu chỉ nhận danh sách Mã BN đã lọc; bước "Lấy thêm dữ liệu EMR"
  // sẽ dùng chính các Mã BN này để mở EMR và ghi run riêng cho nghiên cứu.
  const updated = updateStudy(study.id, {
    cohort_source: 'archive',
    cohort_source_run_id: archiveRunId,
    cohort_filter: filters || {},
    variable_selection: variableSelection.hasActiveSelection(selection) ? selection : study.variable_selection,
    analysis_config: variableSelection.hasActiveSelection(selection)
      ? { ...(study.analysis_config || {}), variable_selection: selection }
      : study.analysis_config,
    variable_selection_import: variableSelection.hasActiveSelection(selection) ? {
      applied: true,
      input_count: patientData.rows.length,
      date_filtered_count: dateFilteredPatients.length,
      matched_count: cohortRows.length,
      condition_count: selection.conditions.length,
      applied_at: nowIso(),
    } : { applied: false, input_count: patientData.rows.length, date_filtered_count: dateFilteredPatients.length, matched_count: cohortRows.length, applied_at: nowIso() },
    last_import_at: nowIso(),
  });
  return {
    study: updated,
    source_run_id: archiveRunId,
    count: cohortRows.length,
    variable_selection: variableSelection.hasActiveSelection(selection) ? {
      applied: true,
      condition_count: selection.conditions.length,
      selected_variable_count: selection.selected_variables.length,
      date_filtered_count: dateFilteredPatients.length,
    } : { applied: false },
  };
}

module.exports = {
  archiveEncounterLinker,
  NORMALIZE_INPUT_FILES,
  NORMALIZE_OUTPUT_FILES,
  normalizeInputSignature,
  normalizedOutputsAvailable,
  normalizeRunOutputs,
  normalizeRunOutputsInner,
  normalizeArchiveLatest,
  normalizeStudyLatest,
  importArchiveToStudy,
};
