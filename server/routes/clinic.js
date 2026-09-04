// server/routes/clinic.js — API cho tab Phòng khám

'use strict';

const router = require('express').Router();
const fs = require('fs');
const path = require('path');

const { getRuntimePaths } = require('../services/session');
const { enqueueHeavy, registerCancel, unregisterCancel } = require('../services/task_queue');
const { runScript, fmtPyError } = require('../services/python_runner');
const { appendActivity } = require('../services/activity_logger');
const { writeJsonAtomic, readJsonSafe, safeUnlink } = require('../utils/file');
const { safeFilePart } = require('../utils/file');
const { issueInputPrecheckToken, validateAndConsumeInputPrecheckToken } = require('../services/input_precheck_tokens');


function sanitizeClinicSchedule(raw = {}) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const role = String(obj.defaultRole || 'nurse').trim().toLowerCase();
  const legacyDoctor = String(obj.doctorName || '').trim();
  const afternoonStartHour = String(obj.afternoonStartHour || '12').replace(/\D+/g, '').slice(0, 2) || '12';
  return {
    doctorName: legacyDoctor.slice(0, 120),
    doctorMorningName: String(obj.doctorMorningName || legacyDoctor || '').trim().slice(0, 120),
    doctorAfternoonName: String(obj.doctorAfternoonName || legacyDoctor || '').trim().slice(0, 120),
    nurseName: String(obj.nurseName || '').trim().slice(0, 120),
    defaultRole: role === 'doctor' ? 'doctor' : 'nurse',
    afternoonStartHour,
    doctorKeywords: String(obj.doctorKeywords || '').trim().slice(0, 600),
    nurseKeywords: String(obj.nurseKeywords || '').trim().slice(0, 600),
    procedureTemplateName: String(obj.procedureTemplateName || '').trim().slice(0, 160),
    procedureDurationMinutes: String(obj.procedureDurationMinutes || '').trim().slice(0, 8),
  };
}

function hourFromClinicText(value = '') {
  const m = String(value || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const hour = Number.parseInt(m[1], 10);
  return Number.isFinite(hour) && hour >= 0 && hour <= 23 ? hour : null;
}

function staffNameForClinicRole(schedule = {}, role = 'nurse', timeText = '') {
  const cleanRole = role === 'doctor' ? 'doctor' : 'nurse';
  if (cleanRole !== 'doctor') return String(schedule.nurseName || '').trim();
  const start = Number.parseInt(schedule.afternoonStartHour || '12', 10);
  const hour = hourFromClinicText(timeText);
  const isAfternoon = hour != null && hour >= (Number.isFinite(start) ? start : 12);
  const morning = String(schedule.doctorMorningName || schedule.doctorName || '').trim();
  const afternoon = String(schedule.doctorAfternoonName || schedule.doctorName || '').trim();
  return (isAfternoon ? (afternoon || morning) : (morning || afternoon));
}

function sanitizeClinicRequest(body = {}) {
  const mode = String(body.mode || 'missed').trim() === 'today' ? 'today' : 'missed';
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const loginUrl = String(body.loginUrl || '').trim();
  const listUrl = String(body.listUrl || '').trim();
  const manualCodes = String(body.manualCodes || '').trim();
  const headless = body.headless !== false;
  const clinicSchedule = sanitizeClinicSchedule(body.clinicSchedule || body.clinic_schedule || {});
  const excel = body.excel && typeof body.excel === 'object' ? {
    filename: String(body.excel.filename || 'clinic_targets.xlsx').replace(/[\\/]/g, '_').slice(0, 120),
    base64: String(body.excel.base64 || ''),
  } : null;

  if (!username) throw new Error('Thiếu tài khoản phòng khám.');
  if (!password) throw new Error('Thiếu mật khẩu phòng khám.');
  if (!loginUrl) throw new Error('Thiếu URL đăng nhập phòng khám.');
  if (!listUrl) throw new Error('Thiếu URL Danh sách Khám bệnh.');
  if (excel?.base64 && excel.base64.length > 8 * 1024 * 1024) throw new Error('File Excel quá lớn.');

  return { mode, username, password, loginUrl, listUrl, manualCodes, headless, excel, clinicSchedule };
}

function redactForAudit(payload = {}) {
  return {
    mode: payload.mode,
    username: payload.username ? '[set]' : '',
    password: payload.password ? '[set]' : '',
    loginUrl: payload.loginUrl ? '[set]' : '',
    listUrl: payload.listUrl ? '[set]' : '',
    manualCodeCount: String(payload.manualCodes || '').split(/[\s,;]+/).filter(Boolean).length,
    excel: payload.excel?.filename || '',
    hasExcel: Boolean(payload.excel?.base64),
    headless: payload.headless,
    clinicSchedule: {
      doctorMorningName: payload.clinicSchedule?.doctorMorningName ? '[set]' : '',
      doctorAfternoonName: payload.clinicSchedule?.doctorAfternoonName ? '[set]' : '',
      nurseName: payload.clinicSchedule?.nurseName ? '[set]' : '',
      defaultRole: payload.clinicSchedule?.defaultRole || '',
    },
  };
}


function sanitizeClinicProcedureInput(body = {}) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const loginUrl = String(body.loginUrl || '').trim();
  const listUrl = String(body.listUrl || '').trim();
  const headless = body.headless !== false;
  const clinicSchedule = sanitizeClinicSchedule(body.clinicSchedule || body.clinic_schedule || {});
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const procedureRows = rows
    .filter(r => r && typeof r === 'object' && r.needs_procedure)
    .slice(0, 80)
    .map(r => ({
      ma_bn: String(r.ma_bn || '').replace(/\D+/g, '').trim(),
      ho_ten: String(r.ho_ten || r.excel_ho_ten || '').trim().slice(0, 160),
      ngay_lam: String(r.ngay_lam || r.thoi_gian || '').trim().slice(0, 40),
      thoi_gian: String(r.thoi_gian || '').trim().slice(0, 40),
      service_name: String(r.procedure_service_name || 'Thủ thuật phòng khám').trim().slice(0, 160),
      service_time: String(r.procedure_order_time || r.thoi_gian || '').trim().slice(0, 40),
      procedure_order_time: String(r.procedure_order_time || '').trim().slice(0, 40),
      procedure_order_status: String(r.procedure_order_status || '').trim().slice(0, 80),
      procedure_order_parent_name: String(r.procedure_order_parent_name || '').trim().slice(0, 160),
      tt_text: String(r.tt_text || '').trim().slice(0, 40),
      tt_done: Number(r.tt_done || 0),
      tt_total: Number(r.tt_total || 0),
      procedure_performer_role: String(r.procedure_performer_role || '').trim().slice(0, 20),
      procedure_performer_name: String(r.procedure_performer_name || '').trim().slice(0, 120),
      noi_thuc_hien: String(r.noi_thuc_hien || r.excel_phong_kham || '').trim().slice(0, 220),
      source: 'clinic_outpatient',
    }))
    .filter(r => r.ma_bn);

  if (!username) throw new Error('Thiếu tài khoản phòng khám.');
  if (!password) throw new Error('Thiếu mật khẩu phòng khám.');
  if (!loginUrl) throw new Error('Thiếu URL đăng nhập phòng khám.');
  if (!listUrl) throw new Error('Thiếu URL Danh sách Khám bệnh.');
  if (!procedureRows.length) throw new Error('Không có dòng TT chưa hoàn tất để nhập thủ thuật.');

  return { username, password, loginUrl, listUrl, headless, clinicSchedule, rows: procedureRows };
}

function dmyFromClinicTime(value = '') {
  const text = String(value || '').trim();
  const m = text.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (!m) return '';
  const dd = m[1].padStart(2, '0');
  const mm = m[2].padStart(2, '0');
  const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${dd}/${mm}/${yyyy}`;
}

function buildClinicProcedureTargets(payload) {
  const schedule = payload.clinicSchedule || {};
  const taskList = payload.rows.map(r => {
    const role = r.procedure_performer_role === 'doctor' ? 'doctor' : r.procedure_performer_role === 'nurse' ? 'nurse' : schedule.defaultRole;
    const timeText = r.procedure_order_time || r.service_time || r.thoi_gian || '';
    const fallbackName = staffNameForClinicRole(schedule, role, timeText);
    return {
      ma_bn: r.ma_bn,
      ho_ten: r.ho_ten,
      ngay_lam: dmyFromClinicTime(r.ngay_lam || r.thoi_gian) || dmyFromClinicTime(r.service_time) || '',
      service_name: r.service_name || 'Thủ thuật phòng khám',
      service_time: timeText,
      procedure_order_status: r.procedure_order_status || '',
      procedure_order_parent_name: r.procedure_order_parent_name || '',
      procedure_staff_name: r.procedure_performer_name || fallbackName || '',
      procedure_staff_role: role,
      source: r.source,
      tt_text: r.tt_text,
    };
  });
  return {
    taskType: 'procedure',
    skipPrecheck: true,
    clinicMode: true,
    patientIds: [...new Set(taskList.map(t => t.ma_bn).filter(Boolean))],
    selectedDates: [...new Set(taskList.map(t => t.ngay_lam).filter(Boolean))],
    procedureTasks: taskList,
    clinicProcedureConfig: {
      url_login: payload.loginUrl,
      username: payload.username,
      password: payload.password,
      headless: payload.headless,
      clinic_list_url: payload.listUrl,
      procedure_template_name: schedule.procedureTemplateName || '',
      procedure_duration_minutes: schedule.procedureDurationMinutes || '',
    },
  };
}

router.post('/clinic/preview', async (req, res) => {
  const ctx = getRuntimePaths(req);
  let reqPath = '';
  let outPath = '';
  try {
    const payload = sanitizeClinicRequest(req.body || {});
    const stamp = `${Date.now()}_${safeFilePart(payload.mode)}`;
    reqPath = path.join(ctx.dir, `clinic_request_${stamp}.json`);
    outPath = path.join(ctx.dir, `clinic_preview_${stamp}.json`);
    writeJsonAtomic(reqPath, payload);

    appendActivity(ctx, { kind: 'workflow.clinic.preview.start', request: redactForAudit(payload) });

    const result = await enqueueHeavy(ctx.sid, async () => {
      try {
        return await runScript('clinic_outpatient.py', ['preview', reqPath, outPath], {
          runtimeDir: ctx.dir,
          onSpawn: (killFn) => registerCancel(ctx.sid, killFn),
        });
      } finally {
        unregisterCancel(ctx.sid);
      }
    });

    safeUnlink(reqPath);

    const fail = (statusCode, message) => {
      safeUnlink(outPath);
      return res.status(statusCode).json({ status: 'error', message });
    };
    if (result.spawnError) return fail(500, `Không khởi động được Python: ${result.spawnError}`);
    if (result.killedByTimeout) return fail(504, 'Timeout khi đọc Phòng khám');
    if (result.code !== 0) return fail(500, fmtPyError('Python lỗi khi đọc Phòng khám.', result));

    const data = readJsonSafe(outPath, null);
    safeUnlink(outPath);
    if (!data) return res.status(500).json({ status: 'error', message: 'Không đọc được kết quả Phòng khám.' });

    appendActivity(ctx, {
      kind: 'workflow.clinic.preview.success',
      mode: data.mode,
      rows: Array.isArray(data.rows) ? data.rows.length : 0,
      target_count: data.target_count || 0,
      summary: data.summary || {},
    });
    return res.json(data);
  } catch (err) {
    safeUnlink(reqPath);
    safeUnlink(outPath);
    try { appendActivity(ctx, { kind: 'workflow.clinic.preview.error', message: String(err.message || err) }); } catch (_) {}
    return res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});


router.post('/clinic/input-procedures', async (req, res) => {
  const ctx = getRuntimePaths(req);
  let processedPath = '';
  let targetsPath = '';
  const resultFileName = 'input_procedures_result.json';
  const resultPath = path.join(ctx.dir, resultFileName);
  try {
    const payload = sanitizeClinicProcedureInput(req.body || {});
    const stamp = `${Date.now()}_clinic_procedures`;
    processedPath = path.join(ctx.dir, `clinic_procedures_processed_${stamp}.json`);
    targetsPath = path.join(ctx.dir, `clinic_procedures_targets_${stamp}.json`);
    const targets = buildClinicProcedureTargets(payload);
    writeJsonAtomic(processedPath, []);
    writeJsonAtomic(targetsPath, targets);
    safeUnlink(resultPath);

    appendActivity(ctx, {
      kind: 'workflow.clinic.input_procedures.start',
      rows: payload.rows.length,
      username: payload.username ? '[set]' : '',
      clinicSchedule: {
        doctorMorningName: payload.clinicSchedule?.doctorMorningName ? '[set]' : '',
        doctorAfternoonName: payload.clinicSchedule?.doctorAfternoonName ? '[set]' : '',
        nurseName: payload.clinicSchedule?.nurseName ? '[set]' : '',
        defaultRole: payload.clinicSchedule?.defaultRole || '',
      },
    });

    const result = await enqueueHeavy(ctx.sid, async () => {
      try {
        return await runScript('input_procedures.py', [processedPath, targetsPath], {
          runtimeDir: ctx.dir,
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
        });
      } finally {
        unregisterCancel(ctx.sid);
      }
    });

    safeUnlink(processedPath);
    safeUnlink(targetsPath);

    const pyResult = readJsonSafe(resultPath, null);
    safeUnlink(resultPath);

    if (result.spawnError) return res.status(500).json({ status: 'error', message: `Không khởi động được Python: ${result.spawnError}` });
    if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: 'Timeout khi nhập thủ thuật phòng khám.' });
    const failed = pyResult?.failed && typeof pyResult.failed === 'object' ? Object.keys(pyResult.failed).length : 0;
    const succeeded = Array.isArray(pyResult?.succeeded) ? pyResult.succeeded.length : 0;
    if (result.code !== 0 && !pyResult) return res.status(500).json({ status: 'error', message: fmtPyError('Python lỗi khi nhập thủ thuật phòng khám.', result) });

    const status = failed ? (succeeded ? 'partial' : 'error') : 'ok';
    const message = status === 'ok'
      ? `Đã nhập thủ thuật phòng khám: ${succeeded} dòng.`
      : `Nhập thủ thuật phòng khám xong một phần: ${succeeded} OK, ${failed} lỗi.`;
    appendActivity(ctx, { kind: 'workflow.clinic.input_procedures.finish', status, succeeded, failed });
    return res.status(status === 'error' ? 500 : 200).json({ status, message, result: pyResult || {}, succeeded, failed });
  } catch (err) {
    safeUnlink(processedPath);
    safeUnlink(targetsPath);
    try { appendActivity(ctx, { kind: 'workflow.clinic.input_procedures.error', message: String(err.message || err) }); } catch (_) {}
    return res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});


// ── Chăm sóc phòng khám từ danh sách điều trị nội trú ───────────────────────

// Bản nháp được lưu theo session tại .runtime/sessions/<session-id>/clinic_care_draft.json.
const CLINIC_CARE_DRAFT_FILE = 'clinic_care_draft.json';

function clinicCareDraftPath(ctx) {
  return path.join(ctx.dir, CLINIC_CARE_DRAFT_FILE);
}

function draftText(value, max = 2000) {
  return String(value || '').trim().slice(0, max);
}

function clinicCareDraftIsoDate(value = '') {
  const text = String(value || '').trim();
  let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (!m) return '';
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function sanitizeClinicCareDraftRow(row = {}) {
  const obj = row && typeof row === 'object' ? row : {};
  return {
    ma_bn: String(obj.ma_bn || '').replace(/\D+/g, '').trim().slice(0, 12),
    ho_ten: draftText(obj.ho_ten, 160),
    tg_vao: draftText(obj.tg_vao || obj.thoi_gian_vao_khoa, 60),
    thoi_gian_vao_khoa: draftText(obj.thoi_gian_vao_khoa || obj.tg_vao, 60),
    care_time_str: draftText(obj.care_time_str, 40),
    care_hour: Number.isFinite(Number(obj.care_hour)) ? Number(obj.care_hour) : null,
    ngay_lam: draftText(obj.ngay_lam, 20),
    khoa_chuyen_den: draftText(obj.khoa_chuyen_den, 200),
    trang_thai: draftText(obj.trang_thai, 80),
    has_nursing_link: Boolean(obj.has_nursing_link || obj.nursing_url || obj.noitruid),
    noitruid: draftText(obj.noitruid, 120),
    dieu_duong: draftText(obj.dieu_duong, 120),
    can_input: Boolean(obj.can_input),
    source: 'inpatient_list_clinic_care',
  };
}

function sanitizeClinicCareDraftEdit(value = {}) {
  const obj = value && typeof value === 'object' ? value : {};
  const order = obj.orderInfo && typeof obj.orderInfo === 'object' ? obj.orderInfo : null;
  return {
    draft: draftText(obj.draft, 2000),
    savedValue: draftText(obj.savedValue, 2000),
    saved: obj.saved === true,
    useSuggestion: obj.useSuggestion === true,
    orderError: draftText(obj.orderError, 600),
    orderInfo: order ? {
      tg_ylenh: draftText(order.tg_ylenh, 60),
      bac_si: draftText(order.bac_si, 160),
      ten_y_lenh: draftText(order.ten_y_lenh, 500),
      pain_location: draftText(order.pain_location, 240),
      suggested_dien_bien: draftText(order.suggested_dien_bien || order.seed_dien_bien, 2000),
      seed_dien_bien: draftText(order.suggested_dien_bien || order.seed_dien_bien, 2000),
      total_orders: Number.isFinite(Number(order.total_orders)) ? Number(order.total_orders) : 0,
    } : null,
  };
}

function sanitizeClinicCareDraft(body = {}) {
  const obj = body && typeof body === 'object' ? body : {};
  const rawPreview = obj.carePreview && typeof obj.carePreview === 'object' ? obj.carePreview : null;
  const previewRows = (Array.isArray(rawPreview?.rows) ? rawPreview.rows : [])
    .slice(0, 120)
    .map(sanitizeClinicCareDraftRow)
    .filter(row => row.ma_bn);
  const rawEdits = obj.careEdits && typeof obj.careEdits === 'object' && !Array.isArray(obj.careEdits)
    ? obj.careEdits
    : {};
  const careEdits = {};
  for (const [key, value] of Object.entries(rawEdits).slice(0, 120)) {
    const safeKey = draftText(key, 240);
    if (safeKey) careEdits[safeKey] = sanitizeClinicCareDraftEdit(value);
  }
  const clientUpdatedAt = Number(obj.client_updated_at || obj.clientUpdatedAt || Date.now());
  return {
    version: 1,
    client_updated_at: Number.isFinite(clientUpdatedAt) ? clientUpdatedAt : Date.now(),
    saved_at: new Date().toISOString(),
    careDate: clinicCareDraftIsoDate(obj.careDate || obj.care_date || '') || '',
    targetDepartment: 'Khoa Khám Bệnh',
    careContent: draftText(obj.careContent, 1000),
    dienBien: draftText(obj.dienBien, 2000),
    needsVitals: Boolean(obj.needsVitals),
    carePreview: rawPreview ? {
      status: draftText(rawPreview.status || 'ok', 30),
      message: draftText(rawPreview.message, 800),
      care_date: normalizeClinicCareDate(rawPreview.care_date || obj.careDate || '') || '',
      target_department: 'Khoa Khám Bệnh',
      precheck_token: draftText(rawPreview.precheck_token, 600),
      precheck_expires_at: draftText(rawPreview.precheck_expires_at, 80),
      summary: {
        total: Number(rawPreview.summary?.total || previewRows.length || 0),
        with_nursing_url: Number(rawPreview.summary?.with_nursing_url || 0),
        missing_nursing_url: Number(rawPreview.summary?.missing_nursing_url || 0),
      },
      rows: previewRows,
    } : null,
    careEdits,
  };
}

router.get('/clinic/care-draft', (req, res) => {
  const ctx = getRuntimePaths(req);
  const draft = readJsonSafe(clinicCareDraftPath(ctx), null);
  return res.json({ status: 'ok', draft: draft && typeof draft === 'object' ? draft : null });
});

router.post('/clinic/care-draft', (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const incoming = sanitizeClinicCareDraft(req.body || {});
    const filePath = clinicCareDraftPath(ctx);
    const existing = readJsonSafe(filePath, null);
    if (existing && Number(existing.client_updated_at || 0) > Number(incoming.client_updated_at || 0)) {
      return res.json({ status: 'ok', saved_at: existing.saved_at || '', ignored_stale: true });
    }
    writeJsonAtomic(filePath, incoming);
    try { fs.chmodSync(filePath, 0o600); } catch (_) {}
    return res.json({ status: 'ok', saved_at: incoming.saved_at, file: CLINIC_CARE_DRAFT_FILE });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

router.delete('/clinic/care-draft', (req, res) => {
  const ctx = getRuntimePaths(req);
  safeUnlink(clinicCareDraftPath(ctx));
  return res.json({ status: 'ok' });
});

function normalizeClinicCareDate(value = '') {
  const text = String(value || '').trim();
  let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[3].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[1]}`;
  m = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (!m) return '';
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${year}`;
}

function clinicCarePrecheckTargets(payload = {}, rows = []) {
  const signatures = (Array.isArray(rows) ? rows : [])
    .filter(r => r && typeof r === 'object'
      && Boolean(r.has_nursing_link || r.nursing_url || r.noitruid)
      && Boolean(String(r.dieu_duong || payload?.clinicSchedule?.nurseName || '').trim()))
    .map(r => {
      const code = String(r.ma_bn || '').replace(/\D+/g, '').trim();
      const time = String(r.care_time_str || r.tg_vao || r.thoi_gian_vao_khoa || '').trim();
      const stayId = String(r.noitruid || '').trim();
      const department = String(r.khoa_chuyen_den || payload.targetDepartment || '').trim().toLowerCase();
      const nurse = String(r.dieu_duong || payload?.clinicSchedule?.nurseName || '').trim();
      return `${code}|${time}|${stayId}|${department}|${nurse}`;
    })
    .filter(Boolean)
    .sort();
  const schedule = payload.clinicSchedule && typeof payload.clinicSchedule === 'object'
    ? payload.clinicSchedule
    : {};
  signatures.push([
    'context',
    String(payload.loginUrl || '').trim(),
    String(payload.careListUrl || '').trim(),
    String(payload.targetDepartment || '').trim().toLowerCase(),
    String(schedule.nurseName || '').trim(),
    String(payload.careContent || '').trim(),
    'per-patient-dien-bien:v1',
    payload.needsVitals ? 'vitals:1' : 'vitals:0',
  ].join('|'));
  return {
    patientIds: signatures.sort(),
    selectedDates: payload.careDate ? [payload.careDate] : [],
  };
}

function sanitizeClinicCareRequest(body = {}, { requireRows = false } = {}) {
  const username         = String(body.username || '').trim();
  const password         = String(body.password || '');
  const loginUrl         = String(body.loginUrl || '').trim();
  const careListUrl      = String(body.careListUrl || body.care_list_url || '').trim();
  const headless         = body.headless !== false;
  const careDate         = normalizeClinicCareDate(body.careDate || body.care_date || '');
  const targetDepartment = 'Khoa Khám Bệnh';
  const clinicSchedule   = sanitizeClinicSchedule(body.clinicSchedule || body.clinic_schedule || {});
  const careContent      = String(body.careContent || '').trim().slice(0, 1000)
    || 'Hoàn tất hồ sơ nhập viện + Kính chuyển Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh + Hồ sơ';
  const dienBien         = String(body.dienBien || '').trim().slice(0, 1500)
    || 'Phòng khám Chấn thương chỉnh hình - Thần kinh nhận\nNgười bệnh tỉnh\nTiếp xúc tốt\nDa niêm hồng\nMạch rõ, chi ấm\nĐau vùng tổn thương\nVận động hạn chế\nTiền sử dị ứng thuốc chưa ghi nhận';
  const needsVitals      = Boolean(body.needsVitals);
  const precheckToken    = String(body.precheck_token || body.precheckToken || '').trim();

  const rawRows = Array.isArray(body.rows) ? body.rows : [];
  const rows = rawRows
    .filter(r => r && typeof r === 'object' && String(r.ma_bn || '').replace(/\D+/g, '').trim())
    .slice(0, 120)
    .map(r => ({
      ma_bn:               String(r.ma_bn || '').replace(/\D+/g, '').trim(),
      ho_ten:              String(r.ho_ten || '').trim().slice(0, 160),
      tg_vao:              String(r.tg_vao || r.thoi_gian_vao_khoa || '').trim().slice(0, 60),
      thoi_gian_vao_khoa:  String(r.thoi_gian_vao_khoa || r.tg_vao || '').trim().slice(0, 60),
      care_time_str:       String(r.care_time_str || '').trim().slice(0, 40),
      care_hour:           Number.isFinite(Number(r.care_hour)) ? Number(r.care_hour) : null,
      ngay_lam:            normalizeClinicCareDate(r.ngay_lam || '') || String(r.ngay_lam || '').trim().slice(0, 20),
      khoa_chuyen_den:     String(r.khoa_chuyen_den || '').trim().slice(0, 200),
      trang_thai:          String(r.trang_thai || '').trim().slice(0, 80),
      has_nursing_link:    Boolean(r.has_nursing_link || r.nursing_url),
      noitruid:            String(r.noitruid || '').trim().slice(0, 120),
      dieu_duong:          String(r.dieu_duong || '').trim().slice(0, 120),
      dien_bien:           String(r.dien_bien || r.dienBien || '').trim().slice(0, 1500),
      saved_for_input:     r.saved_for_input === true || r.savedForInput === true,
      source:              'inpatient_list_clinic_care',
    }));

  // Chăm sóc phòng khám dùng cùng cấu hình EMR với luồng bệnh phòng.
  // Các giá trị dưới đây chỉ là override tùy chọn; worker sẽ tự merge
  // url_login/username/password/url_inpatient_list từ config/config.json.
  if (!careDate) throw new Error('Ngày T/G vào không hợp lệ.');
  if (!targetDepartment) throw new Error('Thiếu Khoa chuyển đến cần lọc.');
  if (requireRows && !rows.length) throw new Error('Chưa có người bệnh phù hợp đã được xem trước.');
  if (requireRows && rows.some(r => !r.saved_for_input)) {
    throw new Error('Còn người bệnh chưa được lưu diễn biến để nhập.');
  }
  if (requireRows && rows.some(r => !r.dien_bien)) {
    throw new Error('Diễn biến của từng người bệnh không được để trống.');
  }

  return {
    username, password, loginUrl, careListUrl, headless,
    careDate, targetDepartment, clinicSchedule,
    careContent, dienBien, needsVitals, rows, precheckToken,
  };
}

router.post('/clinic/care-preview', async (req, res) => {
  const ctx = getRuntimePaths(req);
  let reqPath = '';
  let outPath = '';
  try {
    const payload = sanitizeClinicCareRequest(req.body || {});
    const stamp = `${Date.now()}_clinic_care_preview`;
    reqPath = path.join(ctx.dir, `clinic_care_request_${stamp}.json`);
    outPath = path.join(ctx.dir, `clinic_care_preview_${stamp}.json`);
    writeJsonAtomic(reqPath, payload);

    appendActivity(ctx, {
      kind: 'workflow.clinic.care_preview.start',
      care_date: payload.careDate,
      target_department: payload.targetDepartment,
      username: payload.username ? '[set]' : '',
    });

    const result = await enqueueHeavy(ctx.sid, async () => {
      try {
        return await runScript('clinic_input_care.py', ['preview', reqPath, outPath], {
          runtimeDir: ctx.dir,
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
        });
      } finally {
        unregisterCancel(ctx.sid);
      }
    });
    safeUnlink(reqPath);

    const data = readJsonSafe(outPath, null);
    safeUnlink(outPath);
    if (result.spawnError) return res.status(500).json({ status: 'error', message: `Không khởi động được Python: ${result.spawnError}` });
    if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: 'Timeout khi tìm người bệnh cần nhập chăm sóc.' });
    if (result.code !== 0 || !data || data.status === 'error') {
      return res.status(500).json({ status: 'error', message: data?.message || fmtPyError('Python lỗi khi tìm người bệnh cần chăm sóc.', result) });
    }

    const eligibleRows = (Array.isArray(data.rows) ? data.rows : [])
      .filter(r => Boolean(r?.has_nursing_link || r?.nursing_url || r?.noitruid) && Boolean(String(r?.dieu_duong || '').trim()));
    const precheck = eligibleRows.length
      ? issueInputPrecheckToken(
          ctx,
          'clinic_input_care',
          clinicCarePrecheckTargets(payload, eligibleRows),
          { checked_count: eligibleRows.length },
        )
      : {};

    appendActivity(ctx, {
      kind: 'workflow.clinic.care_preview.success',
      care_date: payload.careDate,
      target_department: payload.targetDepartment,
      rows: Array.isArray(data.rows) ? data.rows.length : 0,
      eligible_rows: eligibleRows.length,
    });
    return res.json({ ...data, ...precheck });
  } catch (err) {
    safeUnlink(reqPath);
    safeUnlink(outPath);
    try { appendActivity(ctx, { kind: 'workflow.clinic.care_preview.error', message: String(err.message || err) }); } catch (_) {}
    return res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

function sanitizeClinicCareOrderSeedsRequest(body = {}) {
  const payload = sanitizeClinicCareRequest(body || {});
  const rows = (Array.isArray(body.rows) ? body.rows : [])
    .filter(row => row && typeof row === 'object')
    .slice(0, 120)
    .map(row => ({
      ma_bn: String(row.ma_bn || '').replace(/\D+/g, '').trim(),
      ho_ten: String(row.ho_ten || '').trim().slice(0, 160),
      tg_vao: String(row.tg_vao || row.thoi_gian_vao_khoa || '').trim().slice(0, 60),
      care_time_str: String(row.care_time_str || row.tg_vao || '').trim().slice(0, 40),
      noitruid: String(row.noitruid || '').trim().slice(0, 120),
      khoa_chuyen_den: String(row.khoa_chuyen_den || payload.targetDepartment || '').trim().slice(0, 200),
      client_key: String(row.client_key || '').trim().slice(0, 240),
    }))
    .filter(row => row.ma_bn);
  if (!rows.length) throw new Error('Không có người bệnh để lấy y lệnh đầu tiên.');
  return { ...payload, rows };
}

router.post('/clinic/care-order-seeds', async (req, res) => {
  const ctx = getRuntimePaths(req);
  let reqPath = '';
  let outPath = '';
  try {
    const payload = sanitizeClinicCareOrderSeedsRequest(req.body || {});
    const stamp = `${Date.now()}_clinic_care_order_seeds`;
    reqPath = path.join(ctx.dir, `clinic_care_order_seeds_${stamp}.json`);
    outPath = path.join(ctx.dir, `clinic_care_order_seeds_${stamp}.out.json`);
    writeJsonAtomic(reqPath, payload);

    appendActivity(ctx, {
      kind: 'workflow.clinic.care_order_seeds.start',
      care_date: payload.careDate,
      target_department: payload.targetDepartment,
      rows: payload.rows.length,
    });

    const result = await enqueueHeavy(ctx.sid, async () => {
      try {
        return await runScript('clinic_input_care.py', ['order-seeds', reqPath, outPath], {
          runtimeDir: ctx.dir,
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
        });
      } finally {
        unregisterCancel(ctx.sid);
      }
    });
    safeUnlink(reqPath);

    const data = readJsonSafe(outPath, null);
    safeUnlink(outPath);
    if (result.spawnError) return res.status(500).json({ status: 'error', message: `Không khởi động được Python: ${result.spawnError}` });
    if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: 'Timeout khi lấy y lệnh đầu tiên cho danh sách.' });
    if (!data) return res.status(500).json({ status: 'error', message: fmtPyError('Python không trả kết quả lấy y lệnh đầu tiên.', result) });

    appendActivity(ctx, {
      kind: 'workflow.clinic.care_order_seeds.finish',
      status: data.status || 'ok',
      succeeded: Number(data.succeeded || 0),
      failed: Number(data.failed || 0),
    });
    return res.json(data);
  } catch (err) {
    safeUnlink(reqPath);
    safeUnlink(outPath);
    try { appendActivity(ctx, { kind: 'workflow.clinic.care_order_seeds.error', message: String(err.message || err) }); } catch (_) {}
    return res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

router.post('/clinic/input-care', async (req, res) => {
  const ctx = getRuntimePaths(req);
  let reqPath = '';
  const resultPath = path.join(ctx.dir, 'clinic_input_care_result.json');
  try {
    const payload = sanitizeClinicCareRequest(req.body || {}, { requireRows: true });
    const tokenCheck = validateAndConsumeInputPrecheckToken(
      ctx,
      'clinic_input_care',
      { ...clinicCarePrecheckTargets(payload, payload.rows), precheck_token: payload.precheckToken },
    );
    if (!tokenCheck.ok) {
      appendActivity(ctx, {
        kind: 'workflow.clinic.input_care.needs_precheck',
        rows: payload.rows.length,
        care_date: payload.careDate,
        message: tokenCheck.message,
      });
      return res.status(tokenCheck.status || 428).json({ status: 'needs_precheck', message: tokenCheck.message });
    }

    const stamp = `${Date.now()}_clinic_care_input`;
    reqPath = path.join(ctx.dir, `clinic_care_request_${stamp}.json`);
    const workerPayload = { ...payload };
    delete workerPayload.precheckToken;
    writeJsonAtomic(reqPath, workerPayload);
    safeUnlink(resultPath);

    appendActivity(ctx, {
      kind: 'workflow.clinic.input_care.start',
      rows: payload.rows.length,
      care_date: payload.careDate,
      target_department: payload.targetDepartment,
      username: payload.username ? '[set]' : '',
      needsVitals: payload.needsVitals,
    });

    const result = await enqueueHeavy(ctx.sid, async () => {
      try {
        return await runScript('clinic_input_care.py', ['input', reqPath, resultPath], {
          runtimeDir: ctx.dir,
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
        });
      } finally {
        unregisterCancel(ctx.sid);
      }
    });
    safeUnlink(reqPath);

    const pyResult = readJsonSafe(resultPath, null);
    safeUnlink(resultPath);
    if (result.spawnError) return res.status(500).json({ status: 'error', message: `Không khởi động được Python: ${result.spawnError}` });
    if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: 'Timeout khi nhập chăm sóc phòng khám.' });
    if (result.code !== 0 && result.code !== 2 && !pyResult) {
      return res.status(500).json({ status: 'error', message: fmtPyError('Python lỗi khi nhập chăm sóc phòng khám.', result) });
    }
    if (!pyResult) return res.status(500).json({ status: 'error', message: 'Worker không tạo được file kết quả nhập chăm sóc.' });

    const failed = pyResult?.failed && typeof pyResult.failed === 'object' ? Object.keys(pyResult.failed).length : 0;
    const succeeded = Array.isArray(pyResult?.succeeded) ? pyResult.succeeded.length : 0;
    const skipped = Number(pyResult?.summary?.skipped_count || 0);
    const status = failed ? (succeeded ? 'partial' : 'error') : 'ok';
    const message = status === 'ok'
      ? `Đã nhập chăm sóc: ${succeeded} người bệnh.${skipped ? ` Bỏ qua an toàn: ${skipped}.` : ''}`
      : `Nhập chăm sóc: ${succeeded} thành công, ${failed} lỗi.${skipped ? ` Bỏ qua an toàn: ${skipped}.` : ''}`;

    appendActivity(ctx, { kind: 'workflow.clinic.input_care.finish', status, succeeded, failed, skipped });
    return res.status(status === 'error' ? 500 : 200).json({ status, message, result: pyResult, succeeded, failed, skipped });
  } catch (err) {
    safeUnlink(reqPath);
    safeUnlink(resultPath);
    try { appendActivity(ctx, { kind: 'workflow.clinic.input_care.error', message: String(err.message || err) }); } catch (_) {}
    return res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

module.exports = router;
