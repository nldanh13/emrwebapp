'use strict';

function stripMarks(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeText(value) {
  return stripMarks(value).toLowerCase().replace(/đ/g, 'd').replace(/\s+/g, ' ').trim();
}

function normalizedKey(value) {
  return normalizeText(value).replace(/[^a-z0-9]+/g, '');
}

function safeSegment(value, fallback = '') {
  const s = stripMarks(value)
    .replace(/đ/g, 'd')
    .replace(/[^a-zA-Z0-9_.:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return s || fallback;
}

function getCell(row, names) {
  if (!row) return '';
  const list = Array.isArray(names) ? names : [names];
  const byKey = new Map(Object.keys(row || {}).map(key => [normalizedKey(key), row[key]]));
  for (const name of list) {
    const v = byKey.get(normalizedKey(name));
    if (String(v ?? '').trim()) return String(v ?? '').trim();
  }
  return '';
}

function patientCode(row) {
  return getCell(row, [
    'Mã BN', 'Ma BN', 'MABN', 'Mã bệnh nhân', 'Ma benh nhan',
    'patient_code', 'patientCode', 'code', 'ma_bn', 'maBN', 'Mã YT', 'Ma YT',
  ]);
}

function researchCode(row) {
  return getCell(row, ['Mã NC', 'Ma NC', 'research_code', 'researchCode', 'first_research_code']);
}

function encounterId(row) {
  return getCell(row, ['encounter_id', 'visit_id']);
}

function isValidDateParts(year, month, day, hour = 0, minute = 0) {
  if (![year, month, day, hour, minute].every(Number.isInteger)) return false;
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return false;
  const d = new Date(year, month - 1, day, hour, minute);
  return d.getFullYear() === year
    && d.getMonth() === month - 1
    && d.getDate() === day
    && d.getHours() === hour
    && d.getMinutes() === minute;
}

function parseComparableDate(raw) {
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2}))?$/);
  if (iso) {
    const parts = [Number(iso[1]), Number(iso[2]), Number(iso[3]), Number(iso[4] || 0), Number(iso[5] || 0)];
    return isValidDateParts(...parts) ? new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4]).getTime() : NaN;
  }
  const dmy = raw.match(/^(?:(\d{1,2}):(\d{1,2})\s+)?(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:\s+(\d{1,2}):(\d{1,2}))?$/);
  if (dmy) {
    const hour = Number(dmy[1] || dmy[6] || 0);
    const minute = Number(dmy[2] || dmy[7] || 0);
    const parts = [Number(dmy[5]), Number(dmy[4]), Number(dmy[3]), hour, minute];
    return isValidDateParts(...parts) ? new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4]).getTime() : NaN;
  }
  return NaN;
}

function coerceComparable(value, type = '') {
  const raw = String(value ?? '').trim();
  if (!raw) return { raw, text: '', num: NaN, time: NaN };
  const num = Number(raw.replace(',', '.').replace(/[^0-9.+-]/g, ''));
  const normalizedType = String(type || '').trim().toLowerCase();
  const numericType = /^(number|numeric|integer|float|double|decimal)$/.test(normalizedType);
  const dateType = /^(date|datetime|timestamp|time)$/.test(normalizedType);
  // Không dùng Date.parse() cho dữ liệu nghiên cứu: các chuỗi số như "5.6"
  // có thể bị JavaScript diễn giải thành ngày, làm sai điều kiện lọc số.
  const time = numericType ? NaN : parseComparableDate(raw);
  return { raw, text: normalizeText(raw), num, time, type: normalizedType, numericType, dateType };
}

function compareScalar(actual, operator, value, value2, type = '') {
  const op = String(operator || '').trim() || (String(value ?? '').trim() ? 'contains' : 'not_empty');
  const a = coerceComparable(actual, type);
  const b = coerceComparable(value, type);
  const c = coerceComparable(value2, type);
  if (op === 'not_empty') return Boolean(a.raw);
  if (op === 'empty') return !a.raw;
  if (!a.raw && !['!=', 'empty'].includes(op)) return false;
  if (['>', '>=', '<', '<=', 'between'].includes(op)) {
    const normalizedType = String(type || '').trim().toLowerCase();
    const useDate = /^(date|datetime|timestamp|time)$/.test(normalizedType)
      || (!/^(number|numeric|integer|float|double|decimal)$/.test(normalizedType)
        && Number.isFinite(a.time) && (Number.isFinite(b.time) || Number.isFinite(c.time)));
    const av = useDate ? a.time : a.num;
    const bv = useDate ? b.time : b.num;
    const cv = useDate ? c.time : c.num;
    if (!Number.isFinite(av)) return false;
    if (op === 'between') return Number.isFinite(bv) && Number.isFinite(cv) && av >= Math.min(bv, cv) && av <= Math.max(bv, cv);
    if (!Number.isFinite(bv)) return false;
    if (op === '>') return av > bv;
    if (op === '>=') return av >= bv;
    if (op === '<') return av < bv;
    if (op === '<=') return av <= bv;
  }
  if (op === '=' || op === '==' || op === '!=') {
    const normalizedType = String(type || '').trim().toLowerCase();
    let equal;
    if (/^(number|numeric|integer|float|double|decimal)$/.test(normalizedType)) {
      equal = Number.isFinite(a.num) && Number.isFinite(b.num) && a.num === b.num;
    } else if (/^(date|datetime|timestamp|time)$/.test(normalizedType)) {
      equal = Number.isFinite(a.time) && Number.isFinite(b.time) && a.time === b.time;
    } else {
      equal = a.text === b.text;
    }
    return op === '!=' ? !equal : equal;
  }
  if (op === 'in') {
    const choices = String(value || '').split(/[;,\n]/).map(normalizeText).filter(Boolean);
    return choices.includes(a.text);
  }
  if (op === 'starts_with') return a.text.startsWith(b.text);
  if (op === 'ends_with') return a.text.endsWith(b.text);
  return a.text.includes(b.text);
}

function sanitizeFilterObject(value, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 2) return undefined;
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    const cleanKey = safeSegment(key, '').slice(0, 80);
    if (!cleanKey || ['__proto__', 'constructor', 'prototype'].includes(cleanKey)) continue;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const nested = sanitizeFilterObject(raw, depth + 1);
      if (nested && Object.keys(nested).length) out[cleanKey] = nested;
    } else if (Array.isArray(raw)) {
      out[cleanKey] = raw.slice(0, 20).map(x => String(x ?? '').slice(0, 300));
    } else {
      out[cleanKey] = String(raw ?? '').slice(0, 500);
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function sanitizeVariableSelection(input) {
  const src = input && typeof input === 'object' ? input : {};
  const sanitizeVar = v => {
    const out = {
      id: String(v?.id || '').slice(0, 200),
      table: safeSegment(String(v?.table || '').slice(0, 80)),
      table_label: String(v?.table_label || '').slice(0, 120),
      name: String(v?.name || '').slice(0, 180),
      label: String(v?.label || v?.name || '').slice(0, 220),
      type: String(v?.type || '').slice(0, 40),
      role: String(v?.role || '').slice(0, 40),
      virtual_kind: String(v?.virtual_kind || '').slice(0, 80),
      aggregation: String(v?.aggregation || 'list').slice(0, 40),
    };
    const sourceFilter = sanitizeFilterObject(v?.source_filter);
    if (sourceFilter) out.source_filter = sourceFilter;
    return out;
  };
  const selected = Array.isArray(src.selected_variables)
    ? src.selected_variables.slice(0, 500).map(sanitizeVar).filter(v => v.id && v.name)
    : [];
  const byId = new Map(selected.map(v => [v.id, v]));
  const conditions = Array.isArray(src.conditions) ? src.conditions.slice(0, 300).map(c => {
    const base = byId.get(String(c?.variable_id || '')) || {};
    const out = {
      id: String(c?.id || '').slice(0, 120),
      variable_id: String(c?.variable_id || '').slice(0, 200),
      table: safeSegment(String(c?.table || base.table || '').slice(0, 80)),
      name: String(c?.name || base.name || '').slice(0, 180),
      label: String(c?.label || base.label || '').slice(0, 220),
      type: String(c?.type || base.type || '').slice(0, 40),
      operator: String(c?.operator || '').slice(0, 40),
      value: String(c?.value ?? '').slice(0, 500),
      value2: String(c?.value2 ?? '').slice(0, 500),
      virtual_kind: String(c?.virtual_kind || base.virtual_kind || '').slice(0, 80),
    };
    const sourceFilter = sanitizeFilterObject(c?.source_filter) || base.source_filter;
    if (sourceFilter) out.source_filter = sourceFilter;
    return out;
  }).filter(c => c.variable_id || c.name) : [];
  return {
    schema_version: Number(src.schema_version || 1) || 1,
    source: String(src.source || 'research_archive').slice(0, 80),
    run_id: safeSegment(String(src.run_id || '').slice(0, 80)),
    created_at: String(src.created_at || new Date().toISOString()).slice(0, 80),
    selected_variables: selected,
    conditions,
  };
}

function hasActiveSelection(selection) {
  return Boolean(selection && typeof selection === 'object' && (
    (Array.isArray(selection.selected_variables) && selection.selected_variables.length) ||
    (Array.isArray(selection.conditions) && selection.conditions.length)
  ));
}

function normalizeForFilter(value) {
  return normalizeText(value).replace(/[^a-z0-9]+/g, ' ').trim();
}

function sourceFilterMatches(row, sourceFilter = {}) {
  for (const [key, expectedRaw] of Object.entries(sourceFilter || {})) {
    if (expectedRaw == null || expectedRaw === '') continue;
    if (Array.isArray(expectedRaw)) {
      const actual = normalizeForFilter(getCell(row, key));
      if (!expectedRaw.map(normalizeForFilter).some(x => x && actual.includes(x))) return false;
      continue;
    }
    if (expectedRaw && typeof expectedRaw === 'object') continue;
    const expected = normalizeForFilter(expectedRaw);
    if (!expected) continue;
    const actual = normalizeForFilter(getCell(row, key));
    if (!actual.includes(expected) && expected !== actual) return false;
  }
  return true;
}

function virtualVariableMatches(row, variable) {
  const name = String(variable?.name || '');
  const kind = String(variable?.virtual_kind || '');
  if (variable?.source_filter && !sourceFilterMatches(row, variable.source_filter)) return false;
  const valueAfterColon = name.includes(':') ? name.split(':').slice(1).join(':') : '';
  const needle = normalizeForFilter(valueAfterColon || variable?.label || '');
  if (!kind && !name.includes(':')) return true;
  if (kind === 'lab_item' || name.startsWith('lab:')) {
    const hay = normalizeForFilter([getCell(row, ['test_name_norm', 'Tên XN chuẩn']), getCell(row, ['test_name_raw', 'Tên XN', 'Tên xét nghiệm'])].join(' '));
    return !needle || hay.includes(needle) || sourceFilterMatches(row, variable.source_filter || {});
  }
  if (kind === 'imaging_modality' || name.startsWith('imaging_modality:')) {
    const hay = normalizeForFilter(getCell(row, ['modality', 'Loại']));
    return !needle || hay.includes(needle);
  }
  if (kind === 'drug_group' || name.startsWith('drug_group:')) {
    const hay = normalizeForFilter(getCell(row, ['drug_group_guess', 'Nhóm thuốc dự đoán']));
    return !needle || hay.includes(needle);
  }
  if (kind === 'drug_item' || name.startsWith('drug:')) {
    const hay = normalizeForFilter([getCell(row, ['drug_name_norm', 'drug_name_raw', 'Tên thuốc']), getCell(row, ['active_ingredient'])].join(' '));
    return !needle || hay.includes(needle);
  }
  if (kind === 'procedure_item' || name.startsWith('procedure:')) {
    const hay = normalizeForFilter([getCell(row, ['surgery_method', 'Phương pháp']), getCell(row, ['surgery_name', 'Tên phẫu thuật'])].join(' '));
    return !needle || hay.includes(needle);
  }
  return sourceFilterMatches(row, variable.source_filter || {});
}

function isVirtual(variable) {
  return Boolean(variable?.virtual_kind || String(variable?.name || '').includes(':') || variable?.source_filter);
}

function conditionMatchesRows(condition, rows) {
  const candidates = Array.isArray(rows) ? rows : [];
  const op = String(condition?.operator || '').trim();
  if (!candidates.length) return op === 'empty';
  if (isVirtual(condition)) {
    const matched = candidates.filter(row => virtualVariableMatches(row, condition));
    if (!matched.length) return op === 'empty';
    if (!op || op === 'not_empty' || op === '=') return true;
    if (op === 'empty') return false;
    const values = matched.map(row => getCell(row, condition.name) || getCell(row, ['result_num', 'result_raw', 'drug_name_raw', 'surgery_method', 'modality']));
    return values.some(v => compareScalar(v, op, condition.value, condition.value2, condition.type));
  }
  if (op === 'empty') return candidates.every(row => !getCell(row, condition.name));
  if (op === 'not_empty') return candidates.some(row => Boolean(getCell(row, condition.name)));
  return candidates.some(row => compareScalar(getCell(row, condition.name), condition.operator, condition.value, condition.value2, condition.type));
}

function eventTime(row) {
  return getCell(row, [
    'lab_datetime', 'ordered_at', 'surgery_datetime', 'order_datetime', 'note_datetime',
    'lab_date', 'order_date', 'surgery_date', 'note_date', 'diagnosis_date', 'date',
    'TG chỉ định', 'TG y lệnh', 'Ngày chỉ định', 'Ngày xét nghiệm', 'Ngày phẫu thuật', 'Ngày',
  ]);
}

function timeInsideEncounter(value, admission, discharge) {
  const t = coerceComparable(value).time;
  const a = coerceComparable(admission).time;
  const d = coerceComparable(discharge).time;
  if (!Number.isFinite(t) || !Number.isFinite(a)) return false;
  const end = Number.isFinite(d) ? d : a + 60 * 86400000;
  return t >= a - 86400000 && t <= end + 86400000;
}

function relatedRows(rows, identity) {
  const list = Array.isArray(rows) ? rows : [];
  const pc = String(identity.patient_code || '').trim();
  const rc = String(identity.research_code || '').trim();
  const eid = String(identity.encounter_id || '').trim();
  const admission = String(identity.admission_date || '').trim();
  const discharge = String(identity.discharge_date || '').trim();
  return list.filter(row => {
    const rowEid = encounterId(row);
    const rowRc = researchCode(row);
    const rowPc = patientCode(row);

    if (eid) {
      if (rowEid) return rowEid === eid;
      if (rc && rowRc) return rowRc === rc;
      if (rowPc !== pc) return false;
      const event = eventTime(row);
      return Boolean(event && timeInsideEncounter(event, admission, discharge));
    }
    if (rc) {
      if (rowRc) return rowRc === rc;
      if (rowEid) return false;
      if (rowPc !== pc) return false;
      const event = eventTime(row);
      return Boolean(event && timeInsideEncounter(event, admission, discharge));
    }
    return Boolean(pc && rowPc === pc && !rowEid && !rowRc);
  });
}

function conditionRowsForSource(sourceRow, condition, tableRowsByKey) {
  const pc = patientCode(sourceRow);
  const rc = researchCode(sourceRow);
  const eid = encounterId(sourceRow);
  const identity = {
    patient_code: pc,
    research_code: rc,
    encounter_id: eid,
    admission_date: getCell(sourceRow, ['admission_date', 'Ngày vào viện']),
    discharge_date: getCell(sourceRow, ['discharge_date', 'Ngày ra viện']),
    surgery_date: getCell(sourceRow, ['surgery_date', 'Ngày phẫu thuật']),
  };
  const table = String(condition.table || '').trim();
  if (!table || ['cohort', 'initial_list', 'research_source'].includes(table)) {
    return [sourceRow, ...relatedRows(tableRowsByKey?.[table] || [], identity)];
  }
  return relatedRows(tableRowsByKey?.[table] || [], identity);
}

function filterCohortRowsByVariableSelection(rows, selectionInput, tableRowsByKey = {}) {
  const selection = sanitizeVariableSelection(selectionInput);
  const conditions = selection.conditions || [];
  if (!conditions.length) return { rows: Array.isArray(rows) ? rows : [], matched: Array.isArray(rows) ? rows.length : 0, conditions: [] };
  const out = [];
  for (const row of rows || []) {
    const ok = conditions.every(condition => conditionMatchesRows(condition, conditionRowsForSource(row, condition, tableRowsByKey)));
    if (ok) out.push(row);
  }
  return { rows: out, matched: out.length, conditions };
}

function selectedColumnName(variable, used = new Set()) {
  const base = safeSegment(`var_${variable.id || variable.table + '_' + variable.name}`, 'var_selected').replace(/[.:]+/g, '_').slice(0, 80);
  let col = base;
  let i = 2;
  while (used.has(col)) col = `${base}_${i++}`.slice(0, 90);
  used.add(col);
  return col;
}

function variableValue(variable, row) {
  return getCell(row, variable.name)
    || getCell(row, ['result_num', 'result_raw', 'drug_name_raw', 'surgery_method', 'surgery_name', 'modality', 'diagnosis_text']);
}

function summarizeVariableValue(variable, rows, identity = {}) {
  const candidates = Array.isArray(rows) ? rows : [];
  const matched = isVirtual(variable)
    ? candidates.filter(row => virtualVariableMatches(row, variable))
    : candidates;
  const aggregation = String(variable?.aggregation || 'list').trim().toLowerCase();
  if (aggregation === 'count') return String(matched.length);
  if (aggregation === 'any') return matched.length ? '1' : '0';
  if (!matched.length) return '';

  const items = matched.map((row, index) => ({
    row,
    value: variableValue(variable, row),
    index,
    time: coerceComparable(eventTime(row)).time,
  })).filter(item => String(item.value ?? '').trim());
  if (!items.length) return '';

  if (aggregation === 'first' || aggregation === 'last') {
    const datedItems = items.filter(item => Number.isFinite(item.time));
    const ordered = datedItems.length
      ? [...datedItems].sort((a, b) => a.time - b.time || a.index - b.index)
      : [...items].sort((a, b) => a.index - b.index);
    return String((aggregation === 'first' ? ordered[0] : ordered[ordered.length - 1]).value);
  }

  if (['min', 'max', 'mean'].includes(aggregation)) {
    const nums = items.map(item => coerceComparable(item.value).num).filter(Number.isFinite);
    if (!nums.length) return '';
    if (aggregation === 'min') return String(Math.min(...nums));
    if (aggregation === 'max') return String(Math.max(...nums));
    return String(Number((nums.reduce((sum, n) => sum + n, 0) / nums.length).toFixed(6)));
  }

  if (aggregation === 'closest_before_surgery' || aggregation === 'closest_after_surgery') {
    const surgeryTime = coerceComparable(identity.surgery_date || '').time;
    if (!Number.isFinite(surgeryTime)) return '';
    const eligible = items.filter(item => Number.isFinite(item.time) && (
      aggregation === 'closest_before_surgery' ? item.time <= surgeryTime : item.time >= surgeryTime
    ));
    if (!eligible.length) return '';
    eligible.sort((a, b) => Math.abs(a.time - surgeryTime) - Math.abs(b.time - surgeryTime));
    return String(eligible[0].value);
  }

  const distinct = [...new Set(items.map(item => String(item.value)))].slice(0, 8);
  return distinct.join('; ');
}

function buildSelectedAnalysisDataset(analysisRows, selectionInput, tableRowsByKey = {}) {
  const selection = sanitizeVariableSelection(selectionInput);
  const selected = selection.selected_variables || [];
  const baseColumns = [
    'research_code', 'encounter_id', 'patient_code', 'patient_name', 'sex', 'birth_year', 'age',
    'admission_date', 'surgery_date', 'discharge_date', 'hospital_stay_days', 'time_to_surgery_hours',
    'diagnosis_raw', 'needs_manual_review', 'source_run_id', 'row_hash',
  ];
  const used = new Set(baseColumns);
  const variableColumns = selected.map(variable => ({ ...variable, output_column: selectedColumnName(variable, used) }));
  const columns = [...baseColumns, ...variableColumns.map(v => v.output_column)];
  const rows = (analysisRows || []).map(row => {
    const identity = {
      patient_code: patientCode(row),
      research_code: researchCode(row),
      encounter_id: encounterId(row),
      admission_date: getCell(row, ['admission_date', 'Ngày vào viện']),
      discharge_date: getCell(row, ['discharge_date', 'Ngày ra viện']),
      surgery_date: getCell(row, ['surgery_date', 'Ngày phẫu thuật']),
    };
    const out = {};
    for (const col of baseColumns) out[col] = row?.[col] ?? getCell(row, col) ?? '';
    for (const variable of variableColumns) {
      const table = variable.table || 'analysis_ready';
      const rowsForVariable = table === 'analysis_ready'
        ? [row]
        : relatedRows(tableRowsByKey?.[table] || [], identity);
      out[variable.output_column] = summarizeVariableValue(variable, rowsForVariable, identity);
    }
    return out;
  });
  return {
    columns,
    rows,
    manifest: {
      schema_version: 1,
      created_at: new Date().toISOString(),
      selected_variable_count: variableColumns.length,
      condition_count: (selection.conditions || []).length,
      variables: variableColumns.map(v => ({
        id: v.id,
        table: v.table,
        name: v.name,
        label: v.label,
        type: v.type,
        role: v.role,
        virtual_kind: v.virtual_kind,
        source_filter: v.source_filter,
        aggregation: v.aggregation || 'list',
        output_column: v.output_column,
      })),
      conditions: selection.conditions || [],
    },
  };
}

module.exports = {
  normalizeText,
  normalizedKey,
  getCell,
  patientCode,
  researchCode,
  sanitizeVariableSelection,
  hasActiveSelection,
  compareScalar,
  sourceFilterMatches,
  virtualVariableMatches,
  conditionMatchesRows,
  relatedRows,
  filterCohortRowsByVariableSelection,
  buildSelectedAnalysisDataset,
};
