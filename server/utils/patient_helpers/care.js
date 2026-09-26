'use strict';

const path = require('path');
const { readJsonSafe } = require('../file');
const { dedupeStrings } = require('./common');
const routeModel = require('../routeModel');

const _RULES_PATH = path.resolve(__dirname, '../../../config/clinical_rules.json');

function _loadClinicalRules() {
  return readJsonSafe(_RULES_PATH, {});
}

// ── Từ điển tên thuốc chuẩn (từ cau_hinh_thuoc.json) ─────────────────────────

function loadDiagMap() {
  const rules = _loadClinicalRules();
  const raw   = Array.isArray(rules.pain_location_map) ? rules.pain_location_map : [];
  if (raw.length > 0) return raw;
  // Fallback cứng nếu JSON bị xoá/hỏng
  return [
    { keywords: ['cột sống', 'thoát vị đĩa đệm', 'thoai hoa cot song'], label: 'cột sống' },
    { keywords: ['gối', 'khớp gối'],                                     label: 'gối' },
    { keywords: ['vai', 'khớp vai'],                                      label: 'vai' },
    { keywords: ['háng', 'khớp háng'],                                    label: 'háng' },
    { keywords: ['cẳng chân', 'xương chày', 'xương mác'],                 label: 'cẳng chân' },
    { keywords: ['đùi', 'xương đùi'],                                     label: 'đùi' },
    { keywords: ['cánh tay', 'xương cánh tay'],                           label: 'cánh tay' },
    { keywords: ['cẳng tay', 'xương quay', 'xương trụ'],                  label: 'cẳng tay' },
    { keywords: ['bàn chân'],                                              label: 'bàn chân' },
  ];
}

// ── Hằng số nghiệp vụ ─────────────────────────────────────────────────────────

function loadDienBienBaseLines() {
  const fallback = [
    'Người bệnh tỉnh',
    'Tiếp xúc tốt',
    'Da niêm hồng',
    'Mạch rõ, chi ấm',
    '__PAIN_LINE__',
    'Vận động hạn chế',
    'Ăn được, ngủ được',
  ];
  const rules = _loadClinicalRules();
  const raw = rules?.care_dien_bien_rules?.base_lines;
  if (!Array.isArray(raw)) return fallback;
  const lines = raw.map(x => String(x || '').trim()).filter(Boolean);
  return lines.includes('__PAIN_LINE__') ? lines : fallback;
}

function normalizeVi(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/đ/g, 'd').replace(/Đ/g, 'd')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // bỏ combining diacritics
    .replace(/\s+/g, ' ')
    .trim();
}

function inferPainLocation(record = {}) {
  const raw = [
    String(record.nhap_cham_soc?.dien_bien || '').replace(/^---\s*\n?/, '').trim(),
    String(record.chan_doan || record['Chẩn đoán'] || '').trim(),
  ].filter(Boolean).join('\n').trim();

  // 1. Tìm mẫu "đau <vị trí>" trong diễn biến / chẩn đoán
  for (const line of raw.split(/\r?\n/).map(x => x.trim()).filter(Boolean)) {
    const m = line.match(/\bđau\b\s*(.+)$/i);
    if (m && m[1].trim()) return m[1].trim().replace(/^[+:-]\s*/, '');
  }

  // 2. Khớp từ khoá chẩn đoán — normalize cả hai phía để tránh lỗi encoding
  const diagMap = loadDiagMap();
  const fullNorm = normalizeVi(raw);
  for (const { keywords, label } of diagMap) {
    if ((keywords || []).some(key => fullNorm.includes(normalizeVi(key)))) return label;
  }
  return 'vị trí tổn thương';
}

function buildPainLine(record = {}) {
  let loc = String(inferPainLocation(record) || '').trim();
  if (!loc) return 'Đau vùng tổn thương';
  loc = loc.replace(/^(vùng|tại|ở)\s+/i, '').trim();
  return `Đau vùng ${loc}`.trim();
}

// ── Chăm sóc diễn biến ────────────────────────────────────────────────────────

function hasVipScore(record = {}) {
  const thuoc = record.thuoc || {};
  if ((thuoc.dich_truyen || []).length > 0) return true;
  // Tiêm tĩnh mạch (TMC) theo model đường dùng duy nhất — đồng bộ has_vip_score() trong care_templates.py.
  return (thuoc.thuoc_tiem || []).some(item => routeModel.routeCodeOfItem(item) === 'TMC');
}

function buildCareDienBien(record = {}, actions = []) {
  const hasThayBang = (actions || []).some(x => String(x || '').toLowerCase().includes('thay băng'));
  const lines = [];

  for (const rawLine of loadDienBienBaseLines()) {
    const line = String(rawLine || '').trim();
    if (!line) continue;
    if (line === '__PAIN_LINE__') {
      lines.push(hasThayBang ? 'Đau vết mổ' : buildPainLine(record));
    } else {
      lines.push(line);
    }
  }

  if (hasThayBang) lines.push('Vết mổ rỉ dịch ít');
  if (hasVipScore(record)) lines.push('Vip Score: 0');
  return dedupeStrings(lines).join('\n');
}

module.exports = { loadDiagMap, loadDienBienBaseLines, normalizeVi, inferPainLocation, buildPainLine, hasVipScore, buildCareDienBien };
