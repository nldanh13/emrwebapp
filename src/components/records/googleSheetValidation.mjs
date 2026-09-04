function cleanText(value) {
  return String(value ?? '').replace(/^\uFEFF/, '').replace(/\s+/g, ' ').trim();
}

// Chuẩn hóa để xác định tên khớp chính xác. Giữ nguyên dấu tiếng Việt vì
// "Phương" và "Phượng" có thể là hai người khác nhau.
export function normalizePersonName(value) {
  return cleanText(value)
    .normalize('NFC')
    .toLocaleLowerCase('vi-VN')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Bản bỏ dấu chỉ dùng để gợi ý tên gần giống, không dùng để tự xác nhận hồ sơ.
export function foldPersonName(value) {
  return normalizePersonName(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function storageIdentity(value) {
  const raw = cleanText(value);
  if (!raw) return { raw: '', number: '', kind: '', year: '', fullKey: '' };

  const parts = raw.split('/').map(part => part.trim()).filter(Boolean);
  let number = parts.length >= 2 && /^\d+$/.test(parts[1])
    ? (parts[1].replace(/^0+/, '') || '0')
    : '';
  const compact = raw.replace(/[.,\s]/g, '');
  if (!number && /^\d+$/.test(compact)) number = compact.replace(/^0+/, '') || '0';

  const groups = raw.match(/\d+/g) || [];
  if (!number) {
    const candidates = groups.filter(group => !(group.length === 4 && /^20\d{2}$/.test(group)));
    const selected = [...(candidates.length ? candidates : groups)].sort((a, b) => b.length - a.length)[0] || '';
    number = selected ? (selected.replace(/^0+/, '') || '0') : '';
  }

  const upper = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toUpperCase();
  const kind = /(^|[^A-Z0-9])BT([^A-Z0-9]|$)|BINH\s*THUONG/.test(upper)
    ? 'BT'
    : (/(^|[^A-Z0-9])TN([^A-Z0-9]|$)|TAI\s*NAN/.test(upper) ? 'TN' : '');
  const year = groups.find(group => /^20\d{2}$/.test(group)) || '';
  return {
    raw,
    number,
    kind,
    year,
    fullKey: number && kind && year ? `${year}::${kind}::${number}` : '',
  };
}

function damerauLevenshtein(valueA, valueB) {
  const a = String(valueA || '');
  const b = String(valueB || '');
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const matrix = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        matrix[i][j] = Math.min(matrix[i][j], matrix[i - 2][j - 2] + cost);
      }
    }
  }
  return matrix[a.length][b.length];
}

export function compareNames(valueA, valueB) {
  const exactA = normalizePersonName(valueA);
  const exactB = normalizePersonName(valueB);
  if (!exactA || !exactB) {
    return { exact: false, close: false, similarity: 0, distance: null, a: exactA, b: exactB };
  }
  if (exactA === exactB) {
    return { exact: true, close: true, similarity: 1, distance: 0, a: exactA, b: exactB };
  }

  const a = foldPersonName(valueA);
  const b = foldPersonName(valueB);
  const compactA = a.replace(/\s+/g, '');
  const compactB = b.replace(/\s+/g, '');
  const distance = damerauLevenshtein(compactA, compactB);
  const similarity = 1 - (distance / Math.max(compactA.length, compactB.length, 1));
  const tokensA = new Set(a.split(' ').filter(Boolean));
  const tokensB = new Set(b.split(' ').filter(Boolean));
  const common = [...tokensA].filter(token => tokensB.has(token)).length;
  const tokenOverlap = common / Math.max(tokensA.size, tokensB.size, 1);
  const close = Math.min(compactA.length, compactB.length) >= 5 && (
    similarity >= 0.9
    || (distance <= 2 && tokenOverlap >= 0.6)
  );
  return { exact: false, close, similarity, distance, tokenOverlap, a: exactA, b: exactB };
}

export function namesMatch(valueA, valueB) {
  return compareNames(valueA, valueB).exact;
}

function storageNumbersNear(valueA, valueB) {
  const a = String(valueA || '').replace(/^0+/, '') || '0';
  const b = String(valueB || '').replace(/^0+/, '') || '0';
  if (!a || !b || a === b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  return damerauLevenshtein(a, b) <= 1;
}

function identitiesCompatible(base, candidate) {
  if (base?.kind && candidate?.kind && base.kind !== candidate.kind) return false;
  if (base?.year && candidate?.year && base.year !== candidate.year) return false;
  return true;
}

export function recordStorageIdentity(record) {
  const parsed = storageIdentity(record?.storage_raw);
  const number = cleanText(record?.storage_number || record?.storage_key || parsed.number);
  const kind = cleanText(record?.storage_kind || parsed.kind).toUpperCase();
  const year = cleanText(record?.storage_year || parsed.year);
  return {
    raw: cleanText(record?.storage_raw || parsed.raw),
    number,
    kind,
    year,
    fullKey: cleanText(record?.storage_full_key) || (number && kind && year ? `${year}::${kind}::${number}` : ''),
  };
}

export function sheetRecordKey(record) {
  return [
    cleanText(record?.row_number),
    cleanText(record?.storage_raw),
    normalizePersonName(record?.patient_name),
    cleanText(record?.timestamp),
  ].join('::');
}

export function buildGoogleSheetIndex(records) {
  const byNumber = new Map();
  const byFull = new Map();
  const byName = new Map();
  const byFoldedName = new Map();
  const all = Array.isArray(records) ? records : [];
  all.forEach(record => {
    const identity = recordStorageIdentity(record);
    if (identity.number) {
      if (!byNumber.has(identity.number)) byNumber.set(identity.number, []);
      byNumber.get(identity.number).push(record);
      if (identity.fullKey) {
        if (!byFull.has(identity.fullKey)) byFull.set(identity.fullKey, []);
        byFull.get(identity.fullKey).push(record);
      }
    }
    const normalizedName = normalizePersonName(record?.patient_name);
    if (normalizedName) {
      if (!byName.has(normalizedName)) byName.set(normalizedName, []);
      byName.get(normalizedName).push(record);
    }
    const foldedName = foldPersonName(record?.patient_name);
    if (foldedName) {
      if (!byFoldedName.has(foldedName)) byFoldedName.set(foldedName, []);
      byFoldedName.get(foldedName).push(record);
    }
  });
  return { byNumber, byFull, byName, byFoldedName, all };
}

export function latestGoogleSheetRecord(records) {
  return [...(records || [])].sort((a, b) => (
    Number(b?.timestamp_ms ?? -1) - Number(a?.timestamp_ms ?? -1)
    || Number(b?.row_number || 0) - Number(a?.row_number || 0)
  ))[0] || null;
}

export const PAPER_ISSUE_STATES = new Set([
  'possible_name_typo',
  'storage_name_conflict',
  'name_mismatch',
  'possible_name_and_storage_typo',
  'missing_name',
  'ambiguous_storage',
]);

function makeStatus(state, tone, label, record = null, candidates = [], issueDetail = '', options = {}) {
  const relatedRecords = Array.isArray(options.relatedRecords) ? options.relatedRecords : candidates;
  return {
    state,
    tone,
    label,
    record,
    candidates,
    related_records: relatedRecords,
    informational_records: Array.isArray(options.informationalRecords) ? options.informationalRecords : [],
    issue_detail: issueDetail,
    is_issue: PAPER_ISSUE_STATES.has(state),
  };
}

function storageCandidatesForIdentity(identity, index) {
  let candidates = identity.fullKey ? [...(index?.byFull?.get(identity.fullKey) || [])] : [];
  if (!candidates.length) candidates = [...(index?.byNumber?.get(identity.number) || [])];
  return candidates.filter(record => identitiesCompatible(identity, recordStorageIdentity(record)));
}

function storageList(records, limit = 4) {
  const values = [];
  (records || []).forEach(record => {
    const identity = recordStorageIdentity(record);
    const value = cleanText(record?.storage_raw) || identity.number;
    if (value && !values.includes(value)) values.push(value);
  });
  const shown = values.slice(0, limit);
  return `${shown.join(', ')}${values.length > shown.length ? ` và ${values.length - shown.length} số khác` : ''}`;
}

// Đánh dấu các dòng Sheet đã có cặp khớp chắc chắn (Số LT + tên chính xác)
// trong toàn bộ danh sách EMR. Dòng Sheet đã khớp không được dùng lại để suy
// đoán một ca cùng tên nhưng khác Số LT là nhập sai.
export function buildClaimedExactSheetKeys(rows, index) {
  const claimed = new Set();
  (Array.isArray(rows) ? rows : []).forEach(row => {
    const identity = storageIdentity(row?.storage);
    const emrName = cleanText(row?.displayName);
    if (!identity.number || !normalizePersonName(emrName)) return;
    const candidates = storageCandidatesForIdentity(identity, index);
    const namedCandidates = candidates.filter(record => cleanText(record?.patient_name));
    const distinctNames = new Set(namedCandidates.map(record => normalizePersonName(record?.patient_name)).filter(Boolean));
    if (distinctNames.size > 1) return;
    candidates
      .filter(record => compareNames(emrName, record?.patient_name).exact)
      .forEach(record => claimed.add(sheetRecordKey(record)));
  });
  return claimed;
}

export function googleSheetRecordStatus(row, index, context = {}) {
  const identity = storageIdentity(row?.storage);
  const emrName = cleanText(row?.displayName);
  const claimedExactSheetKeys = context?.claimedExactSheetKeys instanceof Set
    ? context.claimedExactSheetKeys
    : new Set();
  if (!identity.number) return makeStatus('no_storage', 'gray', 'Chưa có Số LT');

  const storageCandidates = storageCandidatesForIdentity(identity, index);
  if (storageCandidates.length) {
    const namedCandidates = storageCandidates.filter(record => cleanText(record?.patient_name));
    const distinctNames = new Set(namedCandidates.map(record => normalizePersonName(record?.patient_name)).filter(Boolean));
    const exactNames = storageCandidates.filter(record => compareNames(emrName, record?.patient_name).exact);
    if (distinctNames.size > 1) {
      const conflictingNames = [...new Set(namedCandidates.map(record => cleanText(record?.patient_name)).filter(Boolean))]
        .slice(0, 4)
        .join(' / ');
      return makeStatus(
        'storage_name_conflict',
        'red',
        'Một Số LT có nhiều tên',
        latestGoogleSheetRecord(exactNames.length ? exactNames : storageCandidates),
        storageCandidates,
        `Google Sheet có ${distinctNames.size} tên khác nhau cùng dùng Số LT ${identity.raw || identity.number}: ${conflictingNames}.`,
      );
    }
    if (exactNames.length) {
      return makeStatus('available', 'green', 'Đã có hồ sơ', latestGoogleSheetRecord(exactNames), storageCandidates);
    }

    const closeNames = storageCandidates.filter(record => compareNames(emrName, record?.patient_name).close);
    if (closeNames.length === 1) {
      const record = closeNames[0];
      return makeStatus(
        'possible_name_typo',
        'amber',
        'Cần xác minh tên',
        record,
        storageCandidates,
        `Cùng Số LT nhưng tên Sheet “${cleanText(record?.patient_name) || 'để trống'}” gần giống tên EMR “${emrName}”.`,
      );
    }

    if (!namedCandidates.length) {
      return makeStatus(
        'missing_name',
        'amber',
        'Sheet thiếu tên',
        latestGoogleSheetRecord(storageCandidates),
        storageCandidates,
        `Google Sheet có Số LT ${identity.raw || identity.number} nhưng chưa nhập họ tên.`,
      );
    }
    if (storageCandidates.length > 1) {
      return makeStatus(
        'ambiguous_storage',
        'amber',
        'Trùng số, chưa xác định',
        latestGoogleSheetRecord(storageCandidates),
        storageCandidates,
        `Có ${storageCandidates.length} dòng Google Sheet dùng Số LT này nhưng không có tên khớp chính xác với EMR.`,
      );
    }

    const record = storageCandidates[0];
    return makeStatus(
      'name_mismatch',
      'red',
      'Cần xác minh tên',
      record,
      storageCandidates,
      `Cùng Số LT nhưng tên Sheet “${cleanText(record?.patient_name)}” khác tên EMR “${emrName}”.`,
    );
  }

  // Chỉ trùng họ tên nhưng khác Số LT không đủ để kết luận sai Số LT. Đây có
  // thể là một lượt điều trị khác của cùng người bệnh hoặc một người trùng tên.
  const normalizedEmrName = normalizePersonName(emrName);
  let sameNameCandidates = normalizedEmrName ? [...(index?.byName?.get(normalizedEmrName) || [])] : [];
  sameNameCandidates = sameNameCandidates.filter(record => identitiesCompatible(identity, recordStorageIdentity(record)));
  if (sameNameCandidates.length) {
    const claimedCandidates = sameNameCandidates.filter(record => claimedExactSheetKeys.has(sheetRecordKey(record)));
    const referenceRecord = latestGoogleSheetRecord(sameNameCandidates);
    const otherStorages = storageList(sameNameCandidates);
    const detail = claimedCandidates.length === sameNameCandidates.length
      ? `Tên này đã khớp với hồ sơ ${otherStorages} trên Google Sheet. Dòng EMR hiện tại có thể là lượt điều trị khác hoặc người trùng tên nên vẫn được xem là chưa có hồ sơ.`
      : `Google Sheet có cùng họ tên ở Số LT khác (${otherStorages}). Chỉ có Họ tên và Số LT chưa đủ kết luận đây là cùng người bệnh; dòng hiện tại vẫn được xem là chưa có hồ sơ.`;
    return makeStatus(
      'missing_same_name',
      'gray',
      'Chưa có hồ sơ',
      referenceRecord,
      sameNameCandidates,
      detail,
      { relatedRecords: [], informationalRecords: sameNameCandidates },
    );
  }

  // Chỉ gợi ý khi cả tên lẫn Số LT đều gần giống và ứng viên chưa được ghép
  // chính xác với một ca EMR khác. Đây vẫn chỉ là yêu cầu xác minh, không tự
  // kết luận người bệnh hay Số LT bị nhập sai.
  const possibleDoubleTypo = (index?.all || []).filter(record => {
    if (claimedExactSheetKeys.has(sheetRecordKey(record))) return false;
    const recordIdentity = recordStorageIdentity(record);
    if (!identitiesCompatible(identity, recordIdentity)) return false;
    if (!storageNumbersNear(identity.number, recordIdentity.number)) return false;
    return compareNames(emrName, record?.patient_name).close;
  });
  if (possibleDoubleTypo.length === 1) {
    const record = possibleDoubleTypo[0];
    return makeStatus(
      'possible_name_and_storage_typo',
      'amber',
      'Cần xác minh',
      record,
      possibleDoubleTypo,
      `Tên và Số LT trên Sheet đều gần giống EMR nhưng không khớp hoàn toàn. Có thể là lỗi nhập hoặc một hồ sơ khác. Sheet: “${cleanText(record?.patient_name)}” · “${cleanText(record?.storage_raw)}”.`,
    );
  }

  return makeStatus('missing', 'gray', 'Chưa có hồ sơ');
}

export function applyGoogleSheetValidation(rows, index) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const claimedExactSheetKeys = buildClaimedExactSheetKeys(sourceRows, index);
  return sourceRows.map(row => ({
    ...row,
    paperRecord: googleSheetRecordStatus(row, index, { claimedExactSheetKeys }),
  }));
}

export function paperFilterMatches(row, filterValue) {
  const state = String(row?.paperRecord?.state || 'missing');
  if (filterValue === 'available') return state === 'available';
  if (filterValue === 'missing') return ['missing', 'missing_same_name', 'no_storage'].includes(state);
  if (filterValue === 'issues') return PAPER_ISSUE_STATES.has(state);
  return state === filterValue || filterValue === 'all';
}

export function buildUnlinkedSheetIssues(displayRows, records) {
  const rows = Array.isArray(displayRows) ? displayRows : [];
  const linked = new Set();
  rows.forEach(row => {
    // Chỉ các bản ghi thực sự ghép được mới được coi là đã liên kết. Các bản
    // ghi chỉ trùng tên ở Số LT khác là thông tin tham khảo, không phải liên kết.
    const related = row?.paperRecord?.related_records || [];
    related.forEach(record => linked.add(sheetRecordKey(record)));
  });

  return (Array.isArray(records) ? records : [])
    .filter(record => !linked.has(sheetRecordKey(record)))
    .map(record => {
      const recordIdentity = recordStorageIdentity(record);
      const recordName = cleanText(record?.patient_name);
      const exactNameRows = rows.filter(row => namesMatch(row?.displayName, recordName));
      const exactStorageRows = rows.filter(row => {
        const rowIdentity = storageIdentity(row?.storage);
        return rowIdentity.number && rowIdentity.number === recordIdentity.number && identitiesCompatible(rowIdentity, recordIdentity);
      });
      const closeRows = rows.filter(row => {
        const rowIdentity = storageIdentity(row?.storage);
        return identitiesCompatible(rowIdentity, recordIdentity)
          && storageNumbersNear(rowIdentity.number, recordIdentity.number)
          && compareNames(row?.displayName, recordName).close;
      });

      let label = 'Chưa có trong danh sách EMR hiện tại';
      let tone = 'gray';
      let detail = 'Dòng này chưa ghép được với các ca EMR đang hiển thị; có thể thuộc khoảng ngày hoặc khoa khác.';
      if (exactStorageRows.length) {
        label = 'Cần xác minh tên';
        tone = 'red';
        detail = `Số LT trùng EMR nhưng tên Sheet không khớp: ${exactStorageRows.map(row => row.displayName).slice(0, 3).join(', ')}.`;
      } else if (exactNameRows.length) {
        label = 'Chưa ghép được';
        tone = 'gray';
        detail = `Tên trùng với EMR nhưng Số LT khác (${exactNameRows.map(row => row.storage).slice(0, 3).join(', ')}). Có thể là lượt điều trị khác hoặc người trùng tên; không tự kết luận sai Số LT.`;
      } else if (closeRows.length === 1) {
        label = 'Cần xác minh';
        tone = 'amber';
        detail = `Tên và Số LT gần giống ca EMR: ${closeRows[0].displayName} · ${closeRows[0].storage}.`;
      }

      return { record, label, tone, detail };
    })
    .sort((a, b) => Number(b?.record?.timestamp_ms ?? -1) - Number(a?.record?.timestamp_ms ?? -1) || Number(b?.record?.row_number || 0) - Number(a?.record?.row_number || 0));
}
