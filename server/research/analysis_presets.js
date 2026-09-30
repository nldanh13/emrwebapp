'use strict';

// Preset phân tích theo chuyên khoa: cột suy luận từ văn bản, kiểm tra cần duyệt tay, cột tự định nghĩa.
//
// Mỗi preset định nghĩa: inference_fields (các cột tự động suy luận từ text)
// và needs_review_checks (các điều kiện dùng để tạo cột needs_manual_review).
// Khi tạo nghiên cứu mới, user chọn preset; config lưu vào study.json.
// normalizeRunOutputs đọc config này để sinh analysis_ready phù hợp.

const { normalizeSimple, parseAnyDate } = require('./encounter_context');
const { NORMALIZED_COLUMNS } = require('./normalized_schema');
const { sanitizeCustomFields } = require('./analysis_config');
const path = require('path');
const { readJsonSafe } = require('../utils/file');

function inferInjurySide(...texts) {
  const s = normalizeSimple(texts.filter(Boolean).join(' '));
  const hasLeft = /\btrai\b|ben trai|hang trai|dui trai/.test(s);
  const hasRight = /\bphai\b|ben phai|hang phai|dui phai/.test(s);
  if (hasLeft && hasRight) return 'Hai bên/không rõ';
  if (hasLeft) return 'Trái';
  if (hasRight) return 'Phải';
  return '';
}

function inferHipFracture(...texts) {
  const s = normalizeSimple(texts.filter(Boolean).join(' '));
  return /(gay|fracture).*(co xuong dui|lien mau chuyen|duoi mau chuyen|dau tren xuong dui|vung hang|khop hang|femur|hip)|s72/.test(s) ? '1' : '';
}

const ANALYSIS_PRESETS = {
  ortho_fracture: {
    label: 'Chấn thương chỉnh hình — Gãy xương',
    inference_fields: [
      { key: 'injury_side_suggested',  label: 'Bên tổn thương',   fn: 'inferInjurySide' },
      { key: 'hip_fracture_suggested', label: 'Gãy vùng háng',    fn: 'inferHipFracture' },
      { key: 'spine_involved',         label: 'Cột sống',         fn: 'inferSpineInvolved' },
    ],
    needs_review_checks: [
      { field: 'injury_side_suggested',  empty_label: 'bên tổn thương' },
      { field: 'hip_fracture_suggested', empty_label: 'gãy vùng háng' },
      { field: 'surgery_date',           empty_label: 'ngày phẫu thuật' },
    ],
  },
  ortho_joint: {
    label: 'Chấn thương chỉnh hình — Khớp / Thay khớp',
    inference_fields: [
      { key: 'injury_side_suggested', label: 'Bên tổn thương', fn: 'inferInjurySide' },
      { key: 'joint_type_suggested',  label: 'Loại khớp',      fn: 'inferJointType' },
    ],
    needs_review_checks: [
      { field: 'injury_side_suggested', empty_label: 'bên tổn thương' },
      { field: 'joint_type_suggested',  empty_label: 'loại khớp' },
      { field: 'surgery_date',          empty_label: 'ngày phẫu thuật' },
    ],
  },
  neuro_spine: {
    label: 'Thần kinh — Cột sống / Tủy sống',
    inference_fields: [
      { key: 'injury_side_suggested', label: 'Bên tổn thương', fn: 'inferInjurySide' },
      { key: 'spine_involved',        label: 'Cột sống',       fn: 'inferSpineInvolved' },
      { key: 'neuro_deficit',         label: 'Thiếu hụt thần kinh', fn: 'inferNeuroDeficit' },
    ],
    needs_review_checks: [
      { field: 'spine_involved',  empty_label: 'vị trí cột sống' },
      { field: 'neuro_deficit',   empty_label: 'thiếu hụt thần kinh' },
      { field: 'surgery_date',    empty_label: 'ngày phẫu thuật' },
    ],
  },
  neuro_brain: {
    label: 'Thần kinh — Sọ não / Đột quỵ',
    inference_fields: [
      { key: 'injury_side_suggested', label: 'Bên tổn thương', fn: 'inferInjurySide' },
      { key: 'stroke_type',           label: 'Loại đột quỵ',   fn: 'inferStrokeType' },
      { key: 'neuro_deficit',         label: 'Thiếu hụt thần kinh', fn: 'inferNeuroDeficit' },
    ],
    needs_review_checks: [
      { field: 'stroke_type',   empty_label: 'loại đột quỵ' },
      { field: 'neuro_deficit', empty_label: 'thiếu hụt thần kinh' },
    ],
  },
  general: {
    label: 'Tổng quát (không inference)',
    inference_fields: [],
    needs_review_checks: [],
  },
};

function customFieldValidationOptions(presetId = 'general') {
  const reservedColumns = [...new Set(Object.values(NORMALIZED_COLUMNS).flat())];
  const inferenceFields = Object.values(ANALYSIS_PRESETS)
    .flatMap(item => (item?.inference_fields || []).map(field => field.key));
  const selectedPreset = ANALYSIS_PRESETS[presetId] || ANALYSIS_PRESETS.general;
  return {
    reservedColumns,
    inferenceFields: [...new Set([
      ...inferenceFields,
      ...(selectedPreset?.inference_fields || []).map(field => field.key),
    ])],
  };
}

function cleanCustomFields(rawFields, presetId = 'general', strict = true) {
  return sanitizeCustomFields(rawFields, {
    ...customFieldValidationOptions(presetId),
    strict,
  });
}

// Các hàm inference theo preset
function _runInference(fnName, diagnosisText) {
  switch (fnName) {
    case 'inferInjurySide':     return inferInjurySide(diagnosisText);
    case 'inferHipFracture':    return inferHipFracture(diagnosisText);
    case 'inferSpineInvolved': {
      const s = normalizeSimple(diagnosisText);
      // Chỉ đánh dấu cột sống khi có từ khóa đặc hiệu
      // KHÔNG dùng 'nguc'/'co lung' đơn độc (xuất hiện trong X-quang ngực thông thường)
      return /(cot song|doi song|dot song|that lung|dau lung|co lung cot song|tuy song|thoat vi dia dem|hep ong song|truot dot song|viem cot song|gap khuc cot song|gay cot song|gay doi|lumbar|cervical|thoracic spine|spinal|vertebr|than kinh toa|radiculopathy|myelopathy)/.test(s) ? '1' : '';
    }
    case 'inferJointType': {
      const s = normalizeSimple(diagnosisText);
      if (/(khop goi|knee|goi)/.test(s)) return 'Gối';
      if (/(khop hang|hip|hang)/.test(s)) return 'Háng';
      if (/(khop vai|shoulder|vai)/.test(s)) return 'Vai';
      if (/(khop khuy|elbow|khuy tay)/.test(s)) return 'Khuỷu';
      if (/(khop co chan|ankle|co chan)/.test(s)) return 'Cổ chân';
      if (/(khop co tay|wrist|co tay)/.test(s)) return 'Cổ tay';
      return '';
    }
    case 'inferStrokeType': {
      const s = normalizeSimple(diagnosisText);
      if (/(xuat huyet|hemorrhage|chay mau|xhnn|xhmc|xhdn)/.test(s)) return 'Xuất huyết';
      if (/(nhet mach|infarct|thieu mau cuc bo|nhoi mau|nhoi mau nao)/.test(s)) return 'Nhồi máu';
      if (/(thoang qua|tia|tia stroke|thoang thieu mau)/.test(s)) return 'TIA';
      return '';
    }
    case 'inferNeuroDeficit': {
      const s = normalizeSimple(diagnosisText);
      if (/(liet nua nguoi|hemiplegia|hemiparesis|liet chi|paraplegia|tu chi)/.test(s)) return 'Liệt vận động';
      if (/(roi loan ngon ngu|aphasia|kho noi|noi kho)/.test(s)) return 'Ngôn ngữ';
      if (/(roi loan y thuc|mat y thuc|hom me|lom)/.test(s)) return 'Ý thức';
      return '';
    }
    default: return '';
  }
}

// Đọc analysis_config từ study.json; fallback về general để tránh bias theo chuyên khoa.
function loadAnalysisConfig(runDir) {
  // Tìm study.json ngược từ runDir: runs/<runId>/ -> study root -> study.json
  try {
    const studyRoot = path.dirname(path.dirname(path.resolve(runDir)));
    const studyMeta = readJsonSafe(path.join(studyRoot, 'study.json'), {});
    if (studyMeta?.analysis_config) {
      const preset = ANALYSIS_PRESETS[studyMeta.analysis_config.preset] ? studyMeta.analysis_config.preset : 'general';
      return {
        ...studyMeta.analysis_config,
        preset,
        // Nghiên cứu cũ có thể chứa tên cột/pattern không còn an toàn. Khi đọc để
        // normalize thì bỏ qua field lỗi thay vì để nó ghi đè cột hệ thống.
        custom_fields: cleanCustomFields(studyMeta.analysis_config.custom_fields, preset, false),
      };
    }
  } catch (_) {}
  // Fallback: backward compat với kho gốc và nghiên cứu cũ
  return { preset: 'general', custom_fields: [] };
}

function hoursBetween(start, end) {
  const a = parseAnyDate(start);
  const b = parseAnyDate(end);
  if (!a || !b) return '';
  const diff = (b.getTime() - a.getTime()) / 3600000;
  return Number.isFinite(diff) ? String(Math.round(diff * 10) / 10) : '';
}

module.exports = {
  inferInjurySide,
  inferHipFracture,
  ANALYSIS_PRESETS,
  customFieldValidationOptions,
  cleanCustomFields,
  _runInference,
  loadAnalysisConfig,
  hoursBetween,
};
