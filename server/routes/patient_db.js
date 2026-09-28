// server/routes/patient_db.js — API Kho người bệnh (server/services/patient_db.js).
//   GET  /api/kho/tong-quan              số người bệnh, số lượt, dung lượng
//   GET  /api/kho/tim?q=                 tìm theo mã BN, họ tên (không dấu), SĐT, số thẻ BHYT
//   GET  /api/kho/benh-nhan/:maBn        hành trình 1 người bệnh (mọi lượt khám / nằm viện)
//   GET  /api/kho/luot?tu=&den=&loai=&khoa=&limit=&offset=
//   GET  /api/kho/tai-kham?tu=&den=&trang_thai=   hẹn tái khám trong khoảng ngày: đúng hẹn (±3 ngày), trễ, quá hẹn, chưa đến
//   GET  /api/kho/tai-nhap-vien?tu=&den=          ra viện trong khoảng ngày: tái nhập viện trong 30 ngày
//   POST /api/kho/dong-bo                chép dữ liệu hành chánh đã lấy từ trước vào kho
// Dữ liệu có định danh: yêu cầu vai trò operator trở lên, mỗi lần xem hồ sơ được ghi nhật ký.

'use strict';

const router = require('express').Router();
const patientDb = require('../services/patient_db');
const { syncAllToPatientDb } = require('../services/hchanh_stay_store');
const { requireRole } = require('../services/authz');
const { getRuntimePaths } = require('../services/session');
const { appendActivity } = require('../services/activity_logger');

function guard(handler) {
  return (req, res) => {
    if (!patientDb.available()) {
      return res.status(503).json({ status: 'error', code: 'PATIENT_DB_UNAVAILABLE', message: patientDb.unavailableReason() });
    }
    try {
      return handler(req, res);
    } catch (err) {
      return res.status(500).json({ status: 'error', message: `Lỗi kho người bệnh: ${err.message}` });
    }
  };
}

const safeCode = v => String(v || '').trim().slice(0, 40);

router.get('/kho/tong-quan', requireRole('operator'), guard((_req, res) => res.json({ status: 'ok', ...patientDb.summary() })));

router.get('/kho/tim', requireRole('operator'), guard((req, res) => {
  const q = String(req.query.q || '').slice(0, 80);
  return res.json({ status: 'ok', rows: patientDb.searchPatients(q, req.query.limit) });
}));

router.get('/kho/benh-nhan/:maBn', requireRole('operator'), guard((req, res) => {
  const maBn = safeCode(req.params.maBn);
  const journey = patientDb.patientJourney(maBn);
  if (!journey) return res.status(404).json({ status: 'error', message: 'Chưa có người bệnh này trong kho.' });
  try { appendActivity(getRuntimePaths(req), { kind: 'patient_db.view', ma_bn: maBn }); } catch (_) {}
  return res.json({ status: 'ok', ...journey });
}));

router.get('/kho/luot', requireRole('operator'), guard((req, res) => {
  const loai = ['kham', 'noi_tru'].includes(req.query.loai) ? req.query.loai : '';
  const data = patientDb.listVisits({
    tu: String(req.query.tu || ''), den: String(req.query.den || ''), loai,
    khoa: String(req.query.khoa || '').slice(0, 120), limit: req.query.limit, offset: req.query.offset,
  });
  return res.json({ status: 'ok', ...data });
}));

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayParam = v => (DAY_RE.test(String(v || '')) ? String(v) : '');

router.get('/kho/tai-kham', requireRole('operator'), guard((req, res) => {
  const trangThai = ['dung_hen', 'tre_hen', 'qua_hen', 'chua_den_hen'].includes(req.query.trang_thai) ? req.query.trang_thai : '';
  return res.json({ status: 'ok', ...patientDb.appointmentReport({ tu: dayParam(req.query.tu), den: dayParam(req.query.den), loai: trangThai }) });
}));

router.get('/kho/tai-nhap-vien', requireRole('operator'), guard((req, res) => (
  res.json({ status: 'ok', ...patientDb.readmissionReport({ tu: dayParam(req.query.tu), den: dayParam(req.query.den) }) })
)));

router.post('/kho/dong-bo', requireRole('operator'), guard((req, res) => {
  const result = syncAllToPatientDb();
  try { appendActivity(getRuntimePaths(req), { kind: 'patient_db.sync', ...result }); } catch (_) {}
  return res.json({
    status: result.ok ? 'ok' : 'error',
    ...result,
    message: result.ok ? `Đã góp ${result.stays} đợt của ${result.patients} người bệnh (${result.new_scans} bản dữ liệu mới).` : result.message,
    kho: patientDb.summary(),
  });
}));

module.exports = router;
