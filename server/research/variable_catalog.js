'use strict';

// Danh mục biến để chọn khi tạo nghiên cứu: thống kê có giới hạn bộ nhớ, biến ảo theo XN/CĐHA/thuốc/phẫu thuật.

const { stableHash, normalizeToken } = require('./encounter_context');
const { getCell, readCsvTable } = require('./table_io');
const { normalizeLabName } = require('./value_normalizers');
const fs = require('fs');
const path = require('path');
const { isSensitiveColumn } = require('./export_utils');
const { nowIso } = require('./store_paths');
const medicationCatalog = require('./medication_ingredient_catalog');

function inferVariableType(name, rows) {
  const n = String(name || '').toLowerCase();
  const sample = [];
  for (const row of rows || []) {
    const value = String(row?.[name] || '').trim();
    if (value) sample.push(value);
    if (sample.length >= 200) break;
  }
  if (/date|ngày|datetime|time|thời gian|_at$/.test(n)) return 'date';
  if (/age|tuổi|day|days|giờ|hours|num|value|result_num|count|số|tổng/.test(n)) return 'number';
  let numeric = 0;
  for (const v of sample) if (/^-?\d+(?:[.,]\d+)?$/.test(v)) numeric += 1;
  if (sample.length && numeric / sample.length > 0.8) return 'number';
  const distinct = new Set(sample.map(v => v.toLowerCase()));
  if (distinct.size <= 20) return 'category';
  return 'text';
}

const VARIABLE_CATALOG_MAX_ROWS = Math.max(1000, Number(process.env.EMR_VARIABLE_CATALOG_MAX_ROWS || 50000));

const VARIABLE_CATALOG_DISTINCT_LIMIT = 5000;

function summarizeVariableColumns(columns, rows) {
  const stats = new Map((columns || []).map(name => [name, {
    nonempty: 0,
    samples: new Map(),
    distinct: new Set(),
    distinct_truncated: false,
  }]));
  for (const row of rows || []) {
    for (const name of columns || []) {
      const value = String(row?.[name] || '').trim();
      if (!value) continue;
      const stat = stats.get(name);
      stat.nonempty += 1;
      if (stat.samples.has(value)) stat.samples.set(value, stat.samples.get(value) + 1);
      else if (stat.samples.size < 30) stat.samples.set(value, 1);
      if (!stat.distinct_truncated) {
        stat.distinct.add(value.toLowerCase());
        if (stat.distinct.size >= VARIABLE_CATALOG_DISTINCT_LIMIT) stat.distinct_truncated = true;
      }
    }
  }
  return stats;
}

function makeVirtualVariableId(prefix, value) {
  const hash = stableHash(String(value || '')).slice(0, 10);
  return `${prefix}.${hash}`;
}

function shortSamples(values, max = 8) {
  const map = new Map();
  for (const v of values) {
    const textValue = String(v || '').trim();
    if (!textValue) continue;
    map.set(textValue, (map.get(textValue) || 0) + 1);
    if (map.size >= max) break;
  }
  return [...map.entries()].map(([value, count]) => ({ value, count }));
}

function pushCatalogSample(values, value, max = 32) {
  if (value && values.length < max) values.push(value);
}

// "Dùng hoạt chất: X" — một cú chọn gộp mọi tên thương mại/tên gọi khác của hoạt chất X đã khai báo
// ở Cài đặt → Danh mục thuốc. Hoạt chất đã khai báo luôn có mặt (kể cả khi kho chưa có lượt nào dùng,
// để biết là chưa có dữ liệu chứ không phải tìm không ra); hoạt chất có sẵn trong dữ liệu cũng được thêm.
function addActiveIngredientVariables(add, rows, medications = medicationCatalog.loadCatalog()) {
  const byIngredient = new Map();
  const bucketFor = (value) => {
    const key = normalizeToken(value);
    if (!key) return null;
    if (!byIngredient.has(key)) byIngredient.set(key, { value, count: 0, encounters: new Set(), samples: [], names: [] });
    return byIngredient.get(key);
  };
  for (const ingredient of medicationCatalog.allActiveIngredients(medications)) {
    const bucket = bucketFor(ingredient);
    if (bucket) bucket.names = medicationCatalog.resolveIngredientTargets([ingredient], medications).medication_names;
  }
  for (const row of rows || []) {
    for (const ingredient of String(getCell(row, ['active_ingredient', 'Hoạt chất', 'Hoat chat']) || '').split(/[;+]/).map(x => x.trim()).filter(Boolean)) {
      const bucket = bucketFor(ingredient);
      if (!bucket) continue;
      bucket.count += 1;
      const encounter = getCell(row, ['encounter_id']) || getCell(row, ['research_code', 'patient_key', 'patient_code']);
      if (encounter) bucket.encounters.add(encounter);
      pushCatalogSample(bucket.samples, getCell(row, ['drug_name_raw', 'Tên thuốc']) || getCell(row, ['drug_name_norm']));
    }
  }
  const list = [...byIngredient.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  for (const b of list) {
    const names = b.names.length ? ` Gồm các tên: ${b.names.slice(0, 12).join(', ')}${b.names.length > 12 ? '…' : ''}.` : '';
    add({
      id: makeVirtualVariableId('active_ingredient', b.value),
      name: `ingredient:${b.value}`,
      label: `Dùng hoạt chất: ${b.value}`,
      type: 'category',
      nonempty: b.count,
      encounters: b.encounters.size,
      distinct_count: 2,
      sample_values: shortSamples(b.samples.length ? b.samples : b.names),
      operators: ['not_empty', '='],
      virtual_kind: 'active_ingredient',
      trade_names: b.names.slice(0, 50),
      source_note: `Có y lệnh thuốc chứa hoạt chất ${b.value} trong đợt điều trị (theo Danh mục thuốc, mọi tên thương mại đều tính).${names}`,
    });
  }
}

// extra.ingredientRows: y lệnh đã gắn hoạt chất theo Danh mục thuốc (augmentMedicationRowsForResearch);
// extra.medications: Danh mục thuốc (mặc định đọc config/medication_catalog.json).
function buildVirtualVariablesForTable(def, rows, extra = {}) {
  const variables = [];
  const total = rows.length || 0;
  const add = (item) => variables.push({
    rows: total,
    nonempty: item.nonempty || 0,
    fill_rate: total ? Math.round(((item.nonempty || 0) / total) * 100) : 0,
    distinct_count: item.distinct_count || 0,
    sample_values: item.sample_values || [],
    table: def.key,
    table_label: def.label,
    virtual: true,
    ...item,
  });

  if (def.key === 'lab_results') {
    const byTest = new Map();
    for (const row of rows) {
      const norm = getCell(row, ['test_name_norm', 'Tên XN chuẩn', 'Tên xét nghiệm chuẩn hóa']) || normalizeLabName(getCell(row, ['test_name_raw', 'Tên XN', 'Tên xét nghiệm']));
      const raw = getCell(row, ['test_name_raw', 'Tên XN', 'Tên xét nghiệm']) || norm;
      if (!norm && !raw) continue;
      const key = norm || normalizeToken(raw);
      const bucket = byTest.get(key) || { raw, norm: key, group: getCell(row, ['lab_group', 'Nhóm xét nghiệm']), unit: getCell(row, ['unit', 'Đơn vị']), count: 0, values: [], distinctValues: new Set(), distinctTruncated: false };
      bucket.count += 1;
      const val = getCell(row, ['result_num', 'Kết quả số']) || getCell(row, ['result_raw', 'Kết quả']);
      if (val) {
        const displayValue = `${val}${bucket.unit ? ` ${bucket.unit}` : ''}`;
        pushCatalogSample(bucket.values, displayValue);
        if (!bucket.distinctTruncated) {
          bucket.distinctValues.add(displayValue.toLowerCase());
          if (bucket.distinctValues.size >= VARIABLE_CATALOG_DISTINCT_LIMIT) bucket.distinctTruncated = true;
        }
      }
      if (!bucket.raw && raw) bucket.raw = raw;
      if (!bucket.group) bucket.group = getCell(row, ['lab_group', 'Nhóm xét nghiệm']);
      if (!bucket.unit) bucket.unit = getCell(row, ['unit', 'Đơn vị']);
      byTest.set(key, bucket);
    }
    for (const b of [...byTest.values()].sort((a, b) => b.count - a.count).slice(0, 240)) {
      add({
        id: makeVirtualVariableId('lab_item', `${b.norm}|${b.unit}`),
        name: `lab:${b.norm}`,
        label: `${b.raw || b.norm}${b.unit ? ` (${b.unit})` : ''}`,
        type: 'number',
        nonempty: b.count,
        distinct_count: b.distinctValues.size,
        distinct_truncated: b.distinctTruncated,
        sample_values: shortSamples(b.values),
        operators: ['=', '!=', '>', '>=', '<', '<=', 'between', 'not_empty'],
        virtual_kind: 'lab_test',
        source_filter: { test_name_norm: b.norm, unit: b.unit || '' },
        source_note: 'Biến dẫn xuất từ lab_results: lọc theo tên xét nghiệm rồi dùng result_num/result_raw.',
      });
    }
  }

  if (def.key === 'imaging_results') {
    const byModality = new Map();
    for (const row of rows) {
      const modality = getCell(row, ['modality', 'Loại']) || 'Khác';
      const bucket = byModality.get(modality) || { modality, count: 0, samples: [] };
      bucket.count += 1;
      pushCatalogSample(bucket.samples, getCell(row, ['service_name_raw', 'Dịch vụ']) || getCell(row, ['conclusion_text', 'Kết luận']));
      byModality.set(modality, bucket);
    }
    for (const b of [...byModality.values()].sort((a, b) => b.count - a.count)) {
      add({
        id: makeVirtualVariableId('imaging_modality', b.modality),
        name: `imaging:${b.modality}`,
        label: `Có ${b.modality}`,
        type: 'category',
        nonempty: b.count,
        distinct_count: 2,
        sample_values: shortSamples(b.samples),
        operators: ['=', 'not_empty'],
        virtual_kind: 'imaging_modality',
        source_filter: { modality: b.modality },
        source_note: 'Biến dẫn xuất từ imaging_results: có/không có loại CĐHA này trong đợt điều trị.',
      });
    }
  }

  if (def.key === 'medication_orders') {
    const byDrugGroup = new Map();
    const byDrug = new Map();
    for (const row of rows) {
      const groupText = getCell(row, ['drug_group_guess', 'Nhóm thuốc dự đoán']);
      for (const group of String(groupText || '').split(/[;,]/).map(x => x.trim()).filter(Boolean)) {
        const bucket = byDrugGroup.get(group) || { value: group, count: 0, samples: [] };
        bucket.count += 1;
        pushCatalogSample(bucket.samples, getCell(row, ['drug_name_raw', 'Tên thuốc']) || getCell(row, ['drug_name_norm']));
        byDrugGroup.set(group, bucket);
      }
      const drug = getCell(row, ['active_ingredient', 'drug_name_norm', 'drug_name_raw']);
      if (drug) {
        const key = normalizeToken(drug);
        const bucket = byDrug.get(key) || { value: drug, count: 0, samples: [] };
        bucket.count += 1;
        pushCatalogSample(bucket.samples, getCell(row, ['dose_raw', 'Liều dùng']) || getCell(row, ['route_raw', 'Đường dùng']));
        byDrug.set(key, bucket);
      }
    }
    for (const b of [...byDrugGroup.values()].sort((a, b) => b.count - a.count).slice(0, 80)) {
      add({ id: makeVirtualVariableId('drug_group', b.value), name: `drug_group:${b.value}`, label: `Dùng nhóm thuốc: ${b.value}`, type: 'category', nonempty: b.count, distinct_count: 2, sample_values: shortSamples(b.samples), operators: ['=', 'not_empty'], virtual_kind: 'drug_group', source_filter: { drug_group_guess: b.value } });
    }
    addActiveIngredientVariables(add, extra.ingredientRows || rows, extra.medications);
    for (const b of [...byDrug.values()].sort((a, b) => b.count - a.count).slice(0, 120)) {
      add({ id: makeVirtualVariableId('drug_item', b.value), name: `drug:${b.value}`, label: `Dùng thuốc: ${b.value}`, type: 'category', nonempty: b.count, distinct_count: 2, sample_values: shortSamples(b.samples), operators: ['=', 'not_empty'], virtual_kind: 'drug_item', source_filter: { drug_name_norm: normalizeToken(b.value) } });
    }
  }

  if (def.key === 'surgery_results') {
    const byProcedure = new Map();
    for (const row of rows) {
      const method = getCell(row, ['surgery_method', 'Phương pháp']) || getCell(row, ['surgery_name', 'Tên phẫu thuật']);
      if (!method) continue;
      const key = normalizeToken(method);
      const bucket = byProcedure.get(key) || { value: method, count: 0, samples: [] };
      bucket.count += 1;
      pushCatalogSample(bucket.samples, getCell(row, ['anesthesia_method', 'Vô cảm']) || getCell(row, ['surgery_date', 'Ngày mổ']));
      byProcedure.set(key, bucket);
    }
    for (const b of [...byProcedure.values()].sort((a, b) => b.count - a.count).slice(0, 120)) {
      add({ id: makeVirtualVariableId('procedure_item', b.value), name: `procedure:${b.value}`, label: `Phẫu thuật/TT: ${b.value}`, type: 'category', nonempty: b.count, distinct_count: 2, sample_values: shortSamples(b.samples), operators: ['=', 'contains', 'not_empty'], virtual_kind: 'procedure_item', source_filter: { surgery_method: b.value } });
    }
  }

  return variables;
}

function buildVariableCatalog(runDir, { redact = true } = {}) {
  if (!runDir || !fs.existsSync(runDir)) {
    const err = new Error('Chưa có kho dữ liệu để lập danh mục biến.');
    err.status = 400;
    throw err;
  }
  const defs = [
    { key: 'analysis_ready', label: 'Bảng tổng quát', file: 'analysis_ready.csv', purpose: 'Biến tổng hợp theo từng đợt điều trị, phù hợp để nghiên cứu viên chọn biến và điều kiện.' },
    { key: 'patients', label: 'Người bệnh', file: 'patients.csv', purpose: 'Thông tin nền người bệnh.' },
    { key: 'encounters', label: 'Đợt điều trị', file: 'encounters.csv', purpose: 'Mỗi lần nhập viện/điều trị là một dòng.' },
    { key: 'lab_results', label: 'Xét nghiệm', file: 'lab_results.csv', purpose: 'Dữ liệu dài, mỗi kết quả xét nghiệm là một dòng.' },
    { key: 'imaging_results', label: 'CĐHA', file: 'imaging_results.csv', purpose: 'Chẩn đoán hình ảnh.' },
    { key: 'medication_orders', label: 'Thuốc/y lệnh', file: 'medication_orders.csv', purpose: 'Thuốc, đường dùng, liều, thời điểm.' },
    { key: 'diagnoses', label: 'Chẩn đoán', file: 'diagnoses.csv', purpose: 'ICD/chẩn đoán theo đợt điều trị.' },
    { key: 'surgery_results', label: 'Phẫu thuật/thủ thuật', file: 'surgery_results.csv', purpose: 'Tên phẫu thuật, ngày mổ, vô cảm.' },
  ];
  const groups = [];
  for (const def of defs) {
    // Danh mục biến chỉ cần thống kê đại diện để hướng dẫn chọn biến. Không đọc vô
    // hạn vì một run thực tế có thể có hàng trăm nghìn dòng XN/y lệnh.
    const table = readCsvTable(path.join(runDir, def.file), VARIABLE_CATALOG_MAX_ROWS);
    const rows = table.rows || [];
    const visibleColumns = (table.columns || []).filter(col => !redact || !isSensitiveColumn(col));
    const columnStats = summarizeVariableColumns(visibleColumns, rows);
    const variables = visibleColumns.map(col => {
      const stat = columnStats.get(col) || { nonempty: 0, samples: new Map(), distinct: new Set(), distinct_truncated: false };
      const type = inferVariableType(col, rows);
      const operators = type === 'number' ? ['=', '!=', '>', '>=', '<', '<=', 'between', 'not_empty']
        : type === 'date' ? ['between', '>=', '<=', '=', 'not_empty']
        : ['contains', '=', '!=', 'in', 'not_empty', 'empty'];
      return {
        id: `${def.key}.${col}`,
        table: def.key,
        table_label: def.label,
        name: col,
        label: col,
        type,
        rows: rows.length,
        nonempty: stat.nonempty,
        fill_rate: rows.length ? Math.round((stat.nonempty / rows.length) * 100) : 0,
        distinct_count: stat.distinct.size,
        distinct_truncated: stat.distinct_truncated,
        sample_values: [...stat.samples.entries()].slice(0, 10).map(([value, count]) => ({ value, count })),
        operators,
      };
    });
    let extra = {};
    if (def.key === 'medication_orders') {
      // Tên thương mại -> hoạt chất theo Danh mục thuốc, gồm cả "Y lệnh khác" trong Diễn biến (chỉ trong bộ nhớ).
      const notes = readCsvTable(path.join(runDir, 'clinical_notes.csv'), VARIABLE_CATALOG_MAX_ROWS).rows || [];
      extra = { ingredientRows: medicationCatalog.augmentMedicationRowsForResearch(rows, notes) };
    }
    const virtualVariables = buildVirtualVariablesForTable(def, rows, extra);
    groups.push({ ...def, rows: rows.length, sampled: Boolean(table.limited), sample_limit: VARIABLE_CATALOG_MAX_ROWS, variables: [...variables, ...virtualVariables] });
  }
  return { run_id: path.basename(runDir), groups, sample_limit: VARIABLE_CATALOG_MAX_ROWS, generated_at: nowIso() };
}

module.exports = {
  inferVariableType,
  VARIABLE_CATALOG_MAX_ROWS,
  VARIABLE_CATALOG_DISTINCT_LIMIT,
  summarizeVariableColumns,
  makeVirtualVariableId,
  shortSamples,
  pushCatalogSample,
  buildVirtualVariablesForTable,
  addActiveIngredientVariables,
  buildVariableCatalog,
};
