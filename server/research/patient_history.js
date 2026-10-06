'use strict';

// Tra cứu người bệnh (lịch sử các đợt, XN/CĐHA/thuốc/phẫu thuật) trong một run; ưu tiên SQLite, không có thì đọc CSV theo dòng.

const { cell, safeReadRunTable, readRunTableRowsWhere } = require('./table_io');
const { datasetDirFromRunDir } = require('./research_db');
const { databaseInfo, queryResearchDatabase } = require('./sqlite_store');
const path = require('path');
const fs = require('fs');

function foldSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

function rowSearchText(row, keys = null) {
  const vals = keys ? keys.map(k => row?.[k]) : Object.values(row || {});
  return foldSearchText(vals.map(v => String(v || '')).join(' '));
}

function normalizeQuery(q) {
  return foldSearchText(q);
}

function sortByDateLike(rows, keys) {
  return [...(rows || [])].sort((a, b) => {
    const av = cell(a, keys);
    const bv = cell(b, keys);
    return String(av).localeCompare(String(bv));
  });
}

function normalizedPersonName(row) {
  return foldSearchText(cell(row, ['patient_name', 'Họ tên', 'Ho ten', 'name']));
}

function normalizedPersonSex(row) {
  return foldSearchText(cell(row, ['sex', 'Giới', 'GT']));
}

function normalizedPersonBirthYear(row) {
  const birthYear = cell(row, ['birth_year', 'Năm sinh']);
  if (/^\d{4}$/.test(birthYear)) return birthYear;
  const birthDate = cell(row, ['birth_date', 'Ngày sinh']);
  const m = String(birthDate || '').match(/(\d{4})|(?:\d{1,2})[-/](?:\d{1,2})[-/](\d{4})/);
  return m ? (m[1] || m[2] || '') : '';
}

function normalizedPersonAge(row) {
  const age = cell(row, ['age', 'Tuổi']);
  const m = String(age || '').match(/\d{1,3}/);
  return m ? m[0] : '';
}

function personIdentitySignatures(row) {
  const name = normalizedPersonName(row);
  const sex = normalizedPersonSex(row);
  if (!name || !sex) return [];
  const out = [];
  const birthYear = normalizedPersonBirthYear(row);
  const age = normalizedPersonAge(row);
  if (birthYear) out.push(`name_sex_birth:${name}|${sex}|${birthYear}`);
  // HIS nội trú có thể cấp mã BN mới cho lần nhập viện sau, nhưng tuổi/năm sinh có khi chỉ đủ ở một lượt.
  // Vì vậy dùng thêm chữ ký họ tên + giới + tuổi để gộp lịch sử, nhưng vẫn trả cảnh báo nếu có nhiều mã BN.
  if (age) out.push(`name_sex_age:${name}|${sex}|${age}`);
  return [...new Set(out)];
}

function normalizeIdentityRow(row) {
  return {
    patient_code: cell(row, ['patient_code', 'Mã BN']),
    research_code: cell(row, ['first_research_code', 'research_code', 'Mã NC']),
    patient_name: cell(row, ['patient_name', 'Họ tên']),
    sex: cell(row, ['sex', 'Giới', 'GT']),
    age: cell(row, ['age', 'Tuổi']),
    birth_year: cell(row, ['birth_year', 'Năm sinh']),
    birth_date: cell(row, ['birth_date', 'Ngày sinh']),
    source_row: row,
  };
}

function uniqueBy(rows, keyFn) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const key = keyFn(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function rawLabRowForLookup(row = {}) {
  return {
    patient_code: cell(row, ['ma_bn', 'patient_code', 'Mã BN']),
    research_code: cell(row, ['ma_nc', 'research_code', 'Mã NC']),
    encounter_id: '',
    encounter_match_status: 'missing',
    encounter_match_method: '',
    encounter_match_reason: 'raw_patient_lookup_unassigned',
    lab_datetime: cell(row, ['tg_chi_dinh', 'ngay_chi_dinh', 'TG chỉ định', 'Ngày chỉ định']),
    lab_date: cell(row, ['ngay_chi_dinh', 'Ngày chỉ định']),
    lab_group: cell(row, ['loai_xn', 'Loại XN']),
    lab_order_id: cell(row, ['ma_phieu', 'Mã phiếu']),
    test_name_raw: cell(row, ['chi_so', 'Chỉ số']),
    result_raw: cell(row, ['ket_qua', 'Kết quả']),
    ref_range_raw: cell(row, ['khoang_tham_chieu', 'Khoảng tham chiếu']),
    unit: cell(row, ['don_vi', 'Đơn vị']),
    flag_raw: cell(row, ['bat_thuong', 'Bất thường']),
    status: cell(row, ['trang_thai', 'Trạng thái']),
    source_type: 'raw_lookup_fallback',
    source_file: 'lich_su_xn.csv',
  };
}

function rawImagingRowForLookup(row = {}) {
  return {
    patient_code: cell(row, ['ma_bn', 'patient_code', 'Mã BN']),
    research_code: cell(row, ['ma_nc', 'research_code', 'Mã NC']),
    encounter_id: '',
    encounter_match_status: 'missing',
    encounter_match_method: '',
    encounter_match_reason: 'raw_patient_lookup_unassigned',
    ordered_at: cell(row, ['tg_chi_dinh', 'ngay_chi_dinh', 'TG chỉ định', 'Ngày chỉ định']),
    order_date: cell(row, ['ngay_chi_dinh', 'Ngày chỉ định']),
    service_name_raw: cell(row, ['ten_dich_vu', 'Tên dịch vụ']),
    modality: cell(row, ['nhom_dich_vu', 'Nhóm dịch vụ']),
    result_text: cell(row, ['mo_ta_ket_qua', 'Mô tả/Kết quả']),
    conclusion_text: cell(row, ['ket_luan', 'Kết luận']),
    status: cell(row, ['trang_thai', 'Trạng thái']),
    source_type: 'raw_lookup_fallback',
    source_file: 'lich_su_cdha.csv',
  };
}

function lookupClinicalKey(kind, row = {}) {
  if (kind === 'labs') {
    return [
      cell(row, ['patient_code', 'ma_bn']),
      cell(row, ['lab_datetime', 'tg_chi_dinh', 'lab_date', 'ngay_chi_dinh']),
      cell(row, ['lab_order_id', 'ma_phieu']),
      cell(row, ['test_name_raw', 'chi_so']),
      cell(row, ['result_raw', 'ket_qua']),
      cell(row, ['unit', 'don_vi']),
    ].map(v => foldSearchText(v)).join('|');
  }
  return [
    cell(row, ['patient_code', 'ma_bn']),
    cell(row, ['ordered_at', 'tg_chi_dinh', 'order_date', 'ngay_chi_dinh']),
    cell(row, ['service_name_raw', 'ten_dich_vu']),
    cell(row, ['result_text', 'mo_ta_ket_qua']),
    cell(row, ['conclusion_text', 'ket_luan']),
  ].map(v => foldSearchText(v)).join('|');
}

function mergeLookupRows(kind, normalizedRows = [], rawRows = []) {
  const out = [...normalizedRows];
  const seen = new Set(normalizedRows.map(row => lookupClinicalKey(kind, row)).filter(Boolean));
  for (const raw of rawRows) {
    const row = kind === 'labs' ? rawLabRowForLookup(raw) : rawImagingRowForLookup(raw);
    const key = lookupClinicalKey(kind, row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function queryPatientHistoryEventTables(runDir, {
  patientCodes = [],
  researchCodes = [],
  encounterIds = [],
} = {}) {
  try {
    const datasetDir = datasetDirFromRunDir(runDir);
    const info = databaseInfo(datasetDir);
    if (!info?.exists) return null;
    // DB chứa snapshot của một run. Không dùng DB cũ cho run mới.
    if (String(info.run_id || '') !== String(path.basename(runDir) || '')) return null;

    const whereAny = {
      patient_code: [...new Set(patientCodes)].filter(Boolean),
      research_code: [...new Set(researchCodes)].filter(Boolean),
      encounter_id: [...new Set(encounterIds)].filter(Boolean),
    };
    const specs = [
      { name: 'labs', table: 'lab_results', where_any: whereAny, limit: 5000 },
      { name: 'imaging', table: 'imaging_results', where_any: whereAny, limit: 2000 },
      { name: 'medications', table: 'medication_orders', where_any: whereAny, limit: 3000 },
      { name: 'surgeries', table: 'surgery_results', where_any: whereAny, limit: 500 },
      { name: 'raw_labs', table: 'raw_lab_results', where_any: { ma_bn: [...new Set(patientCodes)].filter(Boolean) }, limit: 5000 },
      { name: 'raw_imaging', table: 'raw_imaging_results', where_any: { ma_bn: [...new Set(patientCodes)].filter(Boolean) }, limit: 2000 },
    ];

    const payload = queryResearchDatabase({ datasetDir, queries: specs, timeoutMs: 20000 });
    if (!payload || payload.status !== 'ok') return null;
    const results = payload.results || {};
    const labs = mergeLookupRows('labs', results.labs?.rows || [], results.raw_labs?.rows || []);
    const imaging = mergeLookupRows('imaging', results.imaging?.rows || [], results.raw_imaging?.rows || []);
    return {
      labs,
      imaging,
      medications: results.medications?.rows || [],
      surgeries: results.surgeries?.rows || [],
      source: (results.raw_labs?.rows?.length || results.raw_imaging?.rows?.length) ? 'sqlite+raw' : 'sqlite',
    };
  } catch (err) {
    console.warn('[RESEARCH][PATIENT_HISTORY] SQLite fallback:', err.message);
    return null;
  }
}

const PATIENT_LOOKUP_INDEX_CACHE = new Map();

const PATIENT_LOOKUP_MAX_MATCHES = 30;

function patientLookupInputSignature(runDir) {
  const names = ['patients.csv', 'encounters.csv', 'analysis_ready.csv', 'hchanh_profile.csv'];
  return names.map(name => {
    try {
      const st = fs.statSync(path.join(runDir, name));
      return `${name}:${st.size}:${Math.floor(st.mtimeMs)}`;
    } catch (_) { return `${name}:missing`; }
  }).join('|');
}

function getPatientLookupIndex(runDir) {
  const key = path.resolve(runDir);
  const signature = patientLookupInputSignature(runDir);
  const cached = PATIENT_LOOKUP_INDEX_CACHE.get(key);
  if (cached?.signature === signature) return cached;

  const patients = safeReadRunTable(runDir, 'patients.csv');
  const encounters = safeReadRunTable(runDir, 'encounters.csv');
  const analysis = safeReadRunTable(runDir, 'analysis_ready.csv');
  const hProfile = safeReadRunTable(runDir, 'hchanh_profile.csv');

  const patientKeys = ['patient_code', 'patient_name', 'first_research_code', 'phone_number', 'citizen_id', 'insurance_card'];
  const encKeys = ['research_code', 'patient_code', 'emr_admission_id', 'emr_treatment_id', 'diagnosis_raw', 'admission_diagnosis', 'discharge_diagnosis', 'room_bed'];
  const profileKeys = ['Mã NC', 'Mã BN', 'Họ tên', 'Số CMND', 'Điện thoại', 'Số thẻ', 'Chẩn đoán'];

  const patientSearch = patients.map(row => ({ row, search: rowSearchText(row, patientKeys) }));
  const encounterSearch = encounters.map(row => ({ row, search: rowSearchText(row, encKeys) }));
  const profileSearch = hProfile.map(row => ({ row, search: rowSearchText(row, profileKeys) }));

  const patientByCode = new Map(patients.map(r => [cell(r, ['patient_code', 'Mã BN']), r]).filter(([k]) => k));
  const encounterCountByCode = new Map();
  const researchCodesByPatient = new Map();
  for (const e of encounters) {
    const pc = cell(e, ['patient_code', 'Mã BN']);
    const rc = cell(e, ['research_code', 'Mã NC']);
    if (pc) encounterCountByCode.set(pc, (encounterCountByCode.get(pc) || 0) + 1);
    if (pc && rc) {
      if (!researchCodesByPatient.has(pc)) researchCodesByPatient.set(pc, new Set());
      researchCodesByPatient.get(pc).add(rc);
    }
  }
  const identityRows = [];
  for (const row of patients) identityRows.push(normalizeIdentityRow(row));
  for (const row of hProfile) identityRows.push(normalizeIdentityRow(row));
  for (const row of analysis) identityRows.push(normalizeIdentityRow(row));
  for (const row of encounters) identityRows.push(normalizeIdentityRow(row));

  const rowsByCode = new Map();
  const codesBySignature = new Map();
  for (const row of identityRows) {
    if (!row.patient_code) continue;
    if (!rowsByCode.has(row.patient_code)) rowsByCode.set(row.patient_code, []);
    rowsByCode.get(row.patient_code).push(row);
    for (const sig of personIdentitySignatures(row)) {
      if (!codesBySignature.has(sig)) codesBySignature.set(sig, new Set());
      codesBySignature.get(sig).add(row.patient_code);
    }
  }

  const index = {
    signature, patients, encounters, analysis, hProfile,
    patientSearch, encounterSearch, profileSearch,
    patientByCode, rowsByCode, codesBySignature,
    encounterCountByCode, researchCodesByPatient,
  };
  PATIENT_LOOKUP_INDEX_CACHE.set(key, index);
  // Không giữ index của run cũ vô hạn.
  if (PATIENT_LOOKUP_INDEX_CACHE.size > 8) {
    for (const oldKey of [...PATIENT_LOOKUP_INDEX_CACHE.keys()].slice(0, PATIENT_LOOKUP_INDEX_CACHE.size - 8)) {
      PATIENT_LOOKUP_INDEX_CACHE.delete(oldKey);
    }
  }
  return index;
}

function buildPatientHistory(runDir, query) {
  const startedAt = Date.now();
  if (!runDir || !fs.existsSync(runDir)) {
    const err = new Error('Chưa có kho dữ liệu để tra cứu.');
    err.status = 400;
    throw err;
  }
  const q = normalizeQuery(query);
  if (!q) return { query: '', matches: [], patients: [], total_matches: 0 };

  const lookup = getPatientLookupIndex(runDir);
  const {
    patients, encounters, analysis, hProfile,
    patientSearch, encounterSearch, profileSearch,
    patientByCode, rowsByCode, codesBySignature,
    encounterCountByCode, researchCodesByPatient,
  } = lookup;

  const candidateCodes = new Set();
  const candidateResearch = new Set();
  const matchRows = [];
  for (const item of patientSearch) {
    if (item.search.includes(q)) {
      const row = item.row;
      const pc = cell(row, ['patient_code', 'Mã BN']);
      const rc = cell(row, ['first_research_code', 'research_code', 'Mã NC']);
      if (pc) candidateCodes.add(pc);
      if (rc) candidateResearch.add(rc);
      matchRows.push({ type: 'patient', patient_code: pc, research_code: rc, patient_name: cell(row, ['patient_name', 'Họ tên']) });
    }
  }
  for (const item of encounterSearch) {
    if (item.search.includes(q)) {
      const row = item.row;
      const pc = cell(row, ['patient_code', 'Mã BN']);
      const rc = cell(row, ['research_code', 'Mã NC']);
      if (pc) candidateCodes.add(pc);
      if (rc) candidateResearch.add(rc);
      matchRows.push({ type: 'encounter', patient_code: pc, research_code: rc, patient_name: '' });
    }
  }
  for (const item of profileSearch) {
    if (item.search.includes(q)) {
      const row = item.row;
      const pc = cell(row, ['Mã BN', 'patient_code']);
      const rc = cell(row, ['Mã NC', 'research_code']);
      if (pc) candidateCodes.add(pc);
      if (rc) candidateResearch.add(rc);
      matchRows.push({ type: 'profile', patient_code: pc, research_code: rc, patient_name: cell(row, ['Họ tên', 'patient_name']) });
    }
  }

  for (const rc of candidateResearch) {
    for (const e of encounters) {
      if (cell(e, ['research_code']) === rc && cell(e, ['patient_code'])) candidateCodes.add(cell(e, ['patient_code']));
    }
    for (const p of patients) {
      if (cell(p, ['first_research_code', 'research_code', 'Mã NC']) === rc && cell(p, ['patient_code', 'Mã BN'])) candidateCodes.add(cell(p, ['patient_code', 'Mã BN']));
    }
  }
  if (!candidateCodes.size) return { query, matches: [], patients: [], total_matches: 0 };

  // Tra cứu 2 bước:
  // - Từ khóa rộng (tên/chẩn đoán) chỉ trả danh sách ứng viên nhẹ.
  // - Chỉ khi người dùng chọn đúng mã BN/mã NC mới tải XN/CĐHA/thuốc/PT.
  const exactPatientCodes = new Set();
  for (const code of candidateCodes) {
    if (normalizeQuery(code) === q) exactPatientCodes.add(code);
    for (const rc of researchCodesByPatient.get(code) || []) {
      if (normalizeQuery(rc) === q) exactPatientCodes.add(code);
    }
    const p = patientByCode.get(code) || {};
    const directRc = cell(p, ['first_research_code', 'research_code', 'Mã NC']);
    const directName = cell(p, ['patient_name', 'Họ tên']);
    if (directRc && normalizeQuery(directRc) === q) exactPatientCodes.add(code);
    if (directName && normalizeQuery(directName) === q) {
      // Chỉ tự mở khi tên chính xác xác định duy nhất một mã.
      const sameName = [...candidateCodes].filter(other => {
        const op = patientByCode.get(other) || {};
        return normalizeQuery(cell(op, ['patient_name', 'Họ tên'])) === q;
      });
      if (sameName.length === 1) exactPatientCodes.add(code);
    }
  }

  if (!exactPatientCodes.size && candidateCodes.size > 1) {
    const candidates = [...candidateCodes]
      .slice(0, PATIENT_LOOKUP_MAX_MATCHES)
      .map(code => {
        const p = patientByCode.get(code)
          || (rowsByCode.get(code) || [])[0]?.source_row
          || {};
        const rcs = [...(researchCodesByPatient.get(code) || [])].sort();
        const firstRc = cell(p, ['first_research_code', 'research_code', 'Mã NC']) || rcs[0] || '';
        return {
          patient_code: code,
          research_code: firstRc,
          patient_name: cell(p, ['patient_name', 'Họ tên']),
          sex: cell(p, ['sex', 'Giới', 'GT']),
          age: cell(p, ['age', 'Tuổi']),
          encounter_count: Number(encounterCountByCode.get(code) || 0),
        };
      })
      .sort((a, b) =>
        String(a.patient_name || '').localeCompare(String(b.patient_name || ''), 'vi')
        || String(a.patient_code || '').localeCompare(String(b.patient_code || ''))
      );

    return {
      query,
      matches: matchRows.slice(0, 50),
      candidates,
      patients: [],
      total_matches: candidateCodes.size,
      selection_required: true,
      data_source: 'index',
      elapsed_ms: Date.now() - startedAt,
      truncated: candidateCodes.size > PATIENT_LOOKUP_MAX_MATCHES,
      matched_before_limit: candidateCodes.size,
    };
  }

  if (exactPatientCodes.size) {
    candidateCodes.clear();
    for (const code of exactPatientCodes) candidateCodes.add(code);
  }

  const matchedBeforeLimit = candidateCodes.size;
  let truncated = false;
  if (candidateCodes.size > PATIENT_LOOKUP_MAX_MATCHES) {
    const keep = [...candidateCodes].slice(0, PATIENT_LOOKUP_MAX_MATCHES);
    candidateCodes.clear();
    keep.forEach(code => candidateCodes.add(code));
    truncated = true;
  }

  // Mở rộng mã BN: nếu HIS cấp mã BN khác cho các lần nhập viện nhưng họ tên/giới/tuổi hoặc năm sinh khớp,
  // tra cứu một mã vẫn phải hiện đủ toàn bộ lịch sử điều trị của người bệnh đó.
  const expandedCodes = new Set(candidateCodes);
  let changed = true;
  while (changed) {
    changed = false;
    for (const code of [...expandedCodes]) {
      for (const row of rowsByCode.get(code) || []) {
        for (const sig of personIdentitySignatures(row)) {
          for (const other of codesBySignature.get(sig) || []) {
            if (!expandedCodes.has(other)) {
              expandedCodes.add(other);
              changed = true;
            }
          }
        }
      }
    }
  }

  // Gom các mã BN có chữ ký định danh giống nhau thành một hồ sơ hiển thị.
  const parent = new Map([...expandedCodes].map(code => [code, code]));
  const find = code => {
    let p = parent.get(code) || code;
    while (parent.get(p) && parent.get(p) !== p) p = parent.get(p);
    parent.set(code, p);
    return p;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  for (const codes of codesBySignature.values()) {
    const list = [...codes].filter(code => expandedCodes.has(code));
    for (let i = 1; i < list.length; i += 1) union(list[0], list[i]);
  }
  const groupsByRoot = new Map();
  for (const code of expandedCodes) {
    const root = find(code);
    if (!groupsByRoot.has(root)) groupsByRoot.set(root, new Set());
    groupsByRoot.get(root).add(code);
  }

  const historyResearchCodes = new Set(candidateResearch);
  const historyEncounterIds = new Set();
  for (const e of encounters) {
    const pc = cell(e, ['patient_code', 'Mã BN']);
    if (!expandedCodes.has(pc)) continue;
    const rc = cell(e, ['research_code', 'Mã NC']);
    const eid = cell(e, ['encounter_id']);
    if (rc) historyResearchCodes.add(rc);
    if (eid) historyEncounterIds.add(eid);
  }
  for (const p of patients) {
    const pc = cell(p, ['patient_code', 'Mã BN']);
    if (!expandedCodes.has(pc)) continue;
    const rc = cell(p, ['first_research_code', 'research_code', 'Mã NC']);
    if (rc) historyResearchCodes.add(rc);
  }
  for (const row of hProfile) {
    const pc = cell(row, ['Mã BN', 'patient_code']);
    if (!expandedCodes.has(pc)) continue;
    const rc = cell(row, ['Mã NC', 'research_code']);
    if (rc) historyResearchCodes.add(rc);
  }

  const sqliteTables = queryPatientHistoryEventTables(runDir, {
    // patient_code là cột đã được index trong các bảng chuẩn hóa.
    // Chỉ dùng các khóa khác làm fallback khi thực sự không có mã BN.
    patientCodes: [...expandedCodes],
    researchCodes: expandedCodes.size ? [] : [...historyResearchCodes],
    encounterIds: expandedCodes.size ? [] : [...historyEncounterIds],
  });
  // Không có SQLite: đọc CSV theo dòng và chỉ giữ dòng của người bệnh đang tra (cùng khóa
  // như truy vấn SQLite), không nạp trọn bảng XN/CĐHA/thuốc vào RAM.
  // Giữ rộng (mã BN, Mã NC hoặc mã đợt), bước ghép theo đợt bên dưới lọc chính xác.
  const historyRowMatches = row => expandedCodes.has(String(row.patient_code || '').trim())
    || historyResearchCodes.has(String(row.research_code || '').trim())
    || historyEncounterIds.has(String(row.encounter_id || '').trim());
  const tables = sqliteTables || {
    labs: readRunTableRowsWhere(runDir, 'lab_results.csv', historyRowMatches),
    imaging: readRunTableRowsWhere(runDir, 'imaging_results.csv', historyRowMatches),
    medications: readRunTableRowsWhere(runDir, 'medication_orders.csv', historyRowMatches),
    surgeries: readRunTableRowsWhere(runDir, 'surgery_results.csv', historyRowMatches),
    source: 'csv',
  };

  const outPatients = [];
  for (const groupSet of groupsByRoot.values()) {
    const groupCodes = [...groupSet].sort();
    const representative = groupCodes
      .map(code => patientByCode.get(code))
      .find(row => cell(row, ['birth_year']) || cell(row, ['birth_date']) || cell(row, ['address']))
      || patientByCode.get(groupCodes[0])
      || (rowsByCode.get(groupCodes[0]) || [])[0]?.source_row
      || {};

    const groupResearch = new Set();
    for (const code of groupCodes) {
      const p = patientByCode.get(code);
      const rc = cell(p, ['first_research_code', 'research_code', 'Mã NC']);
      if (rc) groupResearch.add(rc);
    }
    for (const e of encounters) {
      const pc = cell(e, ['patient_code']);
      const rc = cell(e, ['research_code']);
      if (groupSet.has(pc) && rc) groupResearch.add(rc);
    }
    for (const row of hProfile) {
      const pc = cell(row, ['Mã BN', 'patient_code']);
      const rc = cell(row, ['Mã NC', 'research_code']);
      if (groupSet.has(pc) && rc) groupResearch.add(rc);
    }

    const rawEncRows = encounters.filter(e => groupSet.has(cell(e, ['patient_code'])) || groupResearch.has(cell(e, ['research_code'])));
    const encRows = uniqueBy(rawEncRows, e => cell(e, ['encounter_id']) || `${cell(e, ['research_code'])}|${cell(e, ['patient_code'])}|${cell(e, ['admission_date'])}|${cell(e, ['discharge_date'])}`);

    const assigned = {
      labs: new Set(),
      imaging: new Set(),
      medications: new Set(),
      surgeries: new Set(),
    };
    const encounterList = sortByDateLike(encRows, ['admission_date', 'Ngày vào viện']).map(enc => {
      const encounterId = cell(enc, ['encounter_id']);
      const encPatientCode = cell(enc, ['patient_code']);
      const belongs = row => {
        const eid = cell(row, ['encounter_id']);
        const pc = cell(row, ['patient_code', 'Mã BN']);
        // Chỉ encounter_id đã chuẩn hóa mới được quyết định một dòng thuộc đợt nào.
        // Không dùng Mã NC và không dùng Mã BN đơn độc để ép dòng vào một đợt.
        return Boolean(encounterId && eid && eid === encounterId && pc === encPatientCode);
      };
      const allLabs = tables.labs.filter(belongs);
      const allImaging = tables.imaging.filter(belongs);
      const allMeds = tables.medications.filter(belongs);
      const allSurgeries = tables.surgeries.filter(belongs);
      allLabs.forEach(row => assigned.labs.add(row));
      allImaging.forEach(row => assigned.imaging.add(row));
      allMeds.forEach(row => assigned.medications.add(row));
      allSurgeries.forEach(row => assigned.surgeries.add(row));
      const labs = sortByDateLike(allLabs, ['lab_datetime', 'lab_date']).slice(0, 250);
      const imaging = sortByDateLike(allImaging, ['ordered_at', 'order_date']).slice(0, 100);
      const meds = sortByDateLike(allMeds, ['order_datetime', 'order_date']).slice(0, 250);
      const surgeries = sortByDateLike(allSurgeries, ['surgery_datetime', 'surgery_date']).slice(0, 60);
      const ar = analysis.find(r => cell(r, ['encounter_id']) === encounterId) || {};
      return {
        encounter_id: encounterId,
        research_code: cell(enc, ['research_code']),
        patient_code: encPatientCode,
        admission_date: cell(enc, ['admission_date', 'Ngày vào viện']),
        discharge_date: cell(enc, ['discharge_date', 'Ngày ra viện']),
        department: cell(enc, ['department', 'Khoa']),
        room_bed: cell(enc, ['room_bed', 'Phòng/Giường']),
        diagnosis_raw: cell(enc, ['diagnosis_raw', 'admission_diagnosis', 'discharge_diagnosis']) || cell(ar, ['diagnosis_raw']),
        surgery_date: cell(enc, ['surgery_date']) || cell(ar, ['surgery_date']),
        discharge_status: cell(enc, ['discharge_status']),
        treatment_duration: cell(enc, ['treatment_duration', 'hospital_stay_days']) || cell(ar, ['hospital_stay_days']),
        counts: { labs: allLabs.length, imaging: allImaging.length, medications: allMeds.length, surgeries: allSurgeries.length },
        labs,
        imaging,
        medications: meds,
        surgeries,
      };
    });

    const groupRow = row => groupSet.has(cell(row, ['patient_code', 'Mã BN']));
    const unassignedLabsAll = tables.labs.filter(row => groupRow(row) && !assigned.labs.has(row));
    const unassignedImagingAll = tables.imaging.filter(row => groupRow(row) && !assigned.imaging.has(row));
    const unassignedMedsAll = tables.medications.filter(row => groupRow(row) && !assigned.medications.has(row));
    const unassignedSurgeriesAll = tables.surgeries.filter(row => groupRow(row) && !assigned.surgeries.has(row));
    const hasUnassigned = unassignedLabsAll.length || unassignedImagingAll.length || unassignedMedsAll.length || unassignedSurgeriesAll.length;
    const unassigned = hasUnassigned ? {
      unmatched: true,
      encounter_id: '',
      research_code: '',
      patient_code: groupCodes[0] || '',
      admission_date: '',
      discharge_date: '',
      diagnosis_raw: 'Dữ liệu thuộc Mã BN nhưng chưa đủ bằng chứng để gán chắc vào một đợt điều trị.',
      counts: {
        labs: unassignedLabsAll.length,
        imaging: unassignedImagingAll.length,
        medications: unassignedMedsAll.length,
        surgeries: unassignedSurgeriesAll.length,
      },
      labs: sortByDateLike(unassignedLabsAll, ['lab_datetime', 'lab_date']).slice(0, 250),
      imaging: sortByDateLike(unassignedImagingAll, ['ordered_at', 'order_date']).slice(0, 100),
      medications: sortByDateLike(unassignedMedsAll, ['order_datetime', 'order_date']).slice(0, 250),
      surgeries: sortByDateLike(unassignedSurgeriesAll, ['surgery_datetime', 'surgery_date']).slice(0, 60),
      match_reasons: [...new Set([
        ...unassignedLabsAll,
        ...unassignedImagingAll,
        ...unassignedMedsAll,
        ...unassignedSurgeriesAll,
      ].map(row => cell(row, ['encounter_match_reason'])).filter(Boolean))].slice(0, 8),
    } : null;

    outPatients.push({
      patient_code: groupCodes[0],
      patient_codes: groupCodes,
      patient_name: cell(representative, ['patient_name', 'Họ tên']) || cell((rowsByCode.get(groupCodes[0]) || [])[0] || {}, ['patient_name']),
      sex: cell(representative, ['sex', 'Giới']),
      age: cell(representative, ['age', 'Tuổi']),
      birth_year: cell(representative, ['birth_year']) || normalizedPersonBirthYear(representative),
      first_research_code: [...groupResearch].sort()[0] || '',
      encounter_count: encounterList.length,
      unassigned_count: unassigned ? Object.values(unassigned.counts).reduce((sum, n) => sum + Number(n || 0), 0) : 0,
      possible_same_patient_codes: groupCodes.length > 1,
      merge_reason: groupCodes.length > 1 ? 'Các mã BN có cùng họ tên, giới và tuổi/năm sinh nên được gộp để xem toàn bộ lịch sử điều trị.' : '',
      encounters: unassigned ? [...encounterList, unassigned] : encounterList,
    });
  }

  outPatients.sort((a, b) => String(a.patient_name || '').localeCompare(String(b.patient_name || '')) || String(a.patient_code || '').localeCompare(String(b.patient_code || '')));
  return {
    query,
    matches: matchRows.slice(0, 50),
    patients: outPatients,
    total_matches: outPatients.length,
    data_source: tables.source || 'csv',
    elapsed_ms: Date.now() - startedAt,
    truncated,
    matched_before_limit: matchedBeforeLimit,
  };
}

module.exports = {
  foldSearchText,
  rowSearchText,
  normalizeQuery,
  sortByDateLike,
  normalizedPersonName,
  normalizedPersonSex,
  normalizedPersonBirthYear,
  normalizedPersonAge,
  personIdentitySignatures,
  normalizeIdentityRow,
  uniqueBy,
  rawLabRowForLookup,
  rawImagingRowForLookup,
  lookupClinicalKey,
  mergeLookupRows,
  queryPatientHistoryEventTables,
  PATIENT_LOOKUP_INDEX_CACHE,
  PATIENT_LOOKUP_MAX_MATCHES,
  patientLookupInputSignature,
  getPatientLookupIndex,
  buildPatientHistory,
};
