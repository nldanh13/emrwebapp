'use strict';

const assert = require('assert');
const {
  sameDisplayStay,
  collapseDisplayEncounters,
  sanitizeEncounterEvents,
  sanitizePatientHistory,
  clinicalEventKey,
  classifyEvent,
} = require('../server/research/patient_history_guard');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

test('không gộp hai Mã BN khác nhau dù cùng thời điểm nhập viện', () => {
  const a = { patient_code: 'BN1', admission_date: '2026-03-05 20:26' };
  const b = { patient_code: 'BN2', admission_date: '2026-03-05 20:26' };
  assert.strictEqual(sameDisplayStay(a, b), false);
});

test('gộp một đợt đang mở với bản đã có ngày ra', () => {
  const rows = collapseDisplayEncounters([
    { patient_code: 'BN1', encounter_id: 'old-a', research_code: 'NC1', admission_date: '2026-03-05 20:26', discharge_date: '', labs: [{ id: 1 }], imaging: [], medications: [], surgeries: [{ id: 's1' }] },
    { patient_code: 'BN1', encounter_id: 'old-b', research_code: 'NC2', admission_date: '2026-03-05 20:26', discharge_date: '2026-03-09 13:00', diagnosis_raw: 'Chẩn đoán', labs: [{ id: 1 }], imaging: [{ id: 2 }], medications: [], surgeries: [] },
  ]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].discharge_date, '2026-03-09 13:00');
});

test('gộp exact duplicate đợt cùng Mã BN', () => {
  const row = { patient_code: 'BN1', encounter_id: 'e1', admission_date: '2026-04-21 09:55', discharge_date: '2026-04-23 13:00', labs: [], imaging: [], medications: [], surgeries: [{ id: 1 }] };
  const rows = collapseDisplayEncounters([row, { ...row }]);
  assert.strictEqual(rows.length, 1);
});

test('không gộp khi cùng giờ vào nhưng hai ngày ra khác nhau rõ ràng', () => {
  const rows = collapseDisplayEncounters([
    { patient_code: 'BN1', encounter_id: 'a', admission_date: '2026-04-21 09:55', discharge_date: '2026-04-23 13:00' },
    { patient_code: 'BN1', encounter_id: 'b', admission_date: '2026-04-21 09:55', discharge_date: '2026-04-24 13:00' },
  ]);
  assert.strictEqual(rows.length, 2);
});

test('tra đúng Mã BN không kéo Mã BN khác chỉ vì trước đó bị gộp theo tên/tuổi', () => {
  const payload = {
    patients: [{
      patient_code: 'BN1', patient_codes: ['BN1', 'BN2'], patient_name: 'NGUYEN VAN A', encounter_count: 3,
      encounters: [
        { patient_code: 'BN1', encounter_id: 'a', admission_date: '2026-01-01', discharge_date: '' },
        { patient_code: 'BN1', encounter_id: 'b', admission_date: '2026-01-01', discharge_date: '2026-01-03' },
        { patient_code: 'BN2', encounter_id: 'c', admission_date: '2026-02-01', discharge_date: '2026-02-03' },
      ],
    }], total_matches: 1, data_source: 'sqlite',
  };
  const out = sanitizePatientHistory(payload, 'BN1');
  assert.strictEqual(out.patients.length, 1);
  assert.deepStrictEqual(out.patients[0].patient_codes, ['BN1']);
  assert.ok(out.patients[0].encounters.every(e => e.patient_code === 'BN1'));
});

test('dữ liệu chưa xác định đợt vẫn hiển thị riêng theo đúng Mã BN và không tính thành một đợt thật', () => {
  const payload = {
    patients: [{
      patient_code: 'BN1',
      patient_codes: ['BN1'],
      patient_name: 'NGUYEN VAN A',
      encounter_count: 1,
      encounters: [
        {
          patient_code: 'BN1', encounter_id: 'e1',
          admission_date: '2026-04-21', discharge_date: '2026-04-23',
          labs: [], imaging: [], medications: [{ patient_code: 'BN1', encounter_id: 'e1', order_datetime: '2026-04-22', drug_name_raw: 'Paracetamol' }], surgeries: [],
        },
        {
          unmatched: true,
          patient_code: 'BN1', encounter_id: '', admission_date: '', discharge_date: '',
          match_reasons: ['encounter_match_outside_time'],
          labs: [
            { patient_code: 'BN1', encounter_match_status: 'missing', encounter_match_reason: 'encounter_match_outside_time', lab_datetime: '2026-05-01', test_name_raw: 'Hb', result_raw: '120' },
            { patient_code: 'BN2', encounter_match_status: 'missing', lab_datetime: '2026-05-01', test_name_raw: 'CRP', result_raw: '5' },
          ],
          imaging: [{ patient_code: 'BN1', encounter_match_status: 'missing', ordered_at: '2026-05-01', service_name_raw: 'X-quang', conclusion_raw: 'Không gãy' }],
          medications: [], surgeries: [],
        },
      ],
    }],
    total_matches: 1,
    data_source: 'sqlite',
  };
  const out = sanitizePatientHistory(payload, 'BN1');
  assert.strictEqual(out.patients[0].encounter_count, 1, 'nhóm chưa xác định không được tính thành đợt');
  assert.strictEqual(out.patients[0].unassigned_count, 2);
  assert.strictEqual(out.patients[0].encounters.length, 2);
  assert.strictEqual(out.patients[0].encounters[1].unmatched, true);
  assert.strictEqual(out.patients[0].encounters[1].labs.length, 1, 'giữ XN đúng Mã BN');
  assert.strictEqual(out.patients[0].encounters[1].imaging.length, 1, 'giữ CĐHA đúng Mã BN');
  assert.strictEqual(out.patients[0].encounters[1].labs[0].test_name_raw, 'Hb');
});

test('phẫu thuật ngoài khoảng nằm viện bị loại và ngày mổ tóm tắt sai bị xóa', () => {
  const enc = sanitizeEncounterEvents({
    patient_code: 'BN1', encounter_id: 'e1', admission_date: '2026-04-21 09:55', discharge_date: '2026-04-23 13:00', surgery_date: '2026-10-04 18:39',
    surgeries: [
      { patient_code: 'BN1', encounter_id: 'e1', surgery_datetime: '2026-10-04 18:39', surgery_name: 'Rút đinh', method: 'Rút đinh', anesthesia: 'Gây mê' },
      { patient_code: 'BN1', encounter_id: 'e1', surgery_datetime: '2026-10-04 18:39', surgery_name: 'Rút đinh', method: 'Rút đinh', anesthesia: 'Gây mê' },
    ], labs: [], imaging: [], medications: [],
  });
  assert.strictEqual(enc.surgeries.length, 0);
  assert.strictEqual(enc.surgery_date, '');
  assert.strictEqual(enc.integrity.status, 'critical');
  assert.strictEqual(enc.integrity.critical, 2);
});

test('phẫu thuật trùng nội dung trong đúng đợt chỉ giữ một dòng', () => {
  const enc = sanitizeEncounterEvents({
    patient_code: 'BN1', encounter_id: 'e1', admission_date: '2026-04-21', discharge_date: '2026-04-23',
    surgeries: [
      { id: 'raw-a', patient_code: 'BN1', surgery_datetime: '2026-04-22 08:00', surgery_name: 'Kết hợp xương', method: 'Nẹp vít', anesthesia: 'Tê tủy sống' },
      { id: 'raw-b', patient_code: 'BN1', surgery_datetime: '2026-04-22 08:00', surgery_name: 'Kết hợp xương', method: 'Nẹp vít', anesthesia: 'Tê tủy sống' },
    ], labs: [], imaging: [], medications: [],
  });
  assert.strictEqual(enc.surgeries.length, 1);
  assert.strictEqual(enc.integrity.deduplicated, 1);
});

test('hai xét nghiệm giống nội dung nhưng khác giờ trong cùng ngày không bị gộp', () => {
  const a = { lab_datetime: '2026-04-22 08:00', test_name_raw: 'Glucose', result_raw: '5.1', unit_raw: 'mmol/L' };
  const b = { lab_datetime: '2026-04-22 16:00', test_name_raw: 'Glucose', result_raw: '5.1', unit_raw: 'mmol/L' };
  assert.notStrictEqual(clinicalEventKey('labs', a), clinicalEventKey('labs', b));
  const enc = sanitizeEncounterEvents({ patient_code: 'BN1', admission_date: '2026-04-22', discharge_date: '2026-04-22', labs: [a, b], imaging: [], medications: [], surgeries: [] });
  assert.strictEqual(enc.labs.length, 2);
});

test('dữ liệu thiếu timestamp được giữ nhưng phải đánh dấu ambiguous', () => {
  const enc = sanitizeEncounterEvents({
    patient_code: 'BN1', encounter_id: 'e1', admission_date: '2026-04-21', discharge_date: '2026-04-23',
    labs: [{ patient_code: 'BN1', encounter_id: 'e1', test_name_raw: 'CRP', result_raw: '5' }], imaging: [], medications: [], surgeries: [],
  });
  assert.strictEqual(enc.labs.length, 1);
  assert.strictEqual(enc.labs[0]._integrity_status, 'ambiguous');
  assert.ok(enc.labs[0]._integrity_reasons.includes('missing_event_time'));
  assert.strictEqual(enc.integrity.status, 'ambiguous');
});

test('đợt chưa có ngày ra không coi dữ liệu tương lai là verified', () => {
  const verdict = classifyEvent('medications', { patient_code: 'BN1', order_datetime: '2026-04-25 10:00' }, { patient_code: 'BN1', admission_date: '2026-04-21', discharge_date: '' });
  assert.strictEqual(verdict.status, 'ambiguous');
  assert.ok(verdict.reasons.includes('open_encounter_no_discharge'));
});

test('chỉ so xung đột strong id cùng loại, không nhầm treatment_id với encounter_id', () => {
  const ok = classifyEvent('medications', { patient_code: 'BN1', treatment_id: 'T1', order_datetime: '2026-04-22 10:00' }, { patient_code: 'BN1', encounter_id: 'E1', treatment_id: 'T1', admission_date: '2026-04-21', discharge_date: '2026-04-23' });
  assert.strictEqual(ok.status, 'verified');
  const bad = classifyEvent('medications', { patient_code: 'BN1', treatment_id: 'T2', order_datetime: '2026-04-22 10:00' }, { patient_code: 'BN1', treatment_id: 'T1', admission_date: '2026-04-21', discharge_date: '2026-04-23' });
  assert.strictEqual(bad.status, 'rejected');
  assert.ok(bad.reasons.includes('strong_id_mismatch:treatment_id'));
});

test('XN ngoài đợt bị loại và duplicate cùng timestamp được dedup', () => {
  const enc = sanitizeEncounterEvents({
    patient_code: 'BN1', encounter_id: 'e1', admission_date: '2026-04-21', discharge_date: '2026-04-23',
    labs: [
      { patient_code: 'BN1', lab_datetime: '2026-04-20 07:00', test_name_raw: 'Hb', result_raw: '120', unit_raw: 'g/L' },
      { patient_code: 'BN1', lab_datetime: '2026-04-22 07:00', test_name_raw: 'Hb', result_raw: '118', unit_raw: 'g/L' },
      { patient_code: 'BN1', lab_datetime: '2026-04-22 07:00', test_name_raw: 'Hb', result_raw: '118', unit_raw: 'g/L' },
    ], imaging: [], medications: [], surgeries: [],
  });
  assert.strictEqual(enc.labs.length, 1);
  assert.strictEqual(enc.integrity.rejected, 1);
  assert.strictEqual(enc.integrity.deduplicated, 1);
});

test('XN Cấp cứu tối hôm trước (đã ghép vào đợt khi chuẩn hóa) vẫn hiển thị; dòng khác ngày đó vẫn bị loại', () => {
  const enc = sanitizeEncounterEvents({
    patient_code: 'BN1', encounter_id: 'e1', admission_date: '2026-04-21 08:00', discharge_date: '2026-04-23',
    labs: [
      { patient_code: 'BN1', lab_datetime: '2026-04-20 22:00', test_name_raw: 'Hb', result_raw: '120', unit_raw: 'g/L', encounter_match_method: 'emergency_before_ward' },
      { patient_code: 'BN1', lab_datetime: '2026-04-20 21:00', test_name_raw: 'PLT', result_raw: '200', unit_raw: 'G/L' },
    ], imaging: [], medications: [], surgeries: [],
  });
  assert.deepStrictEqual(enc.labs.map(l => l.test_name_raw), ['Hb']);
  assert.strictEqual(enc.integrity.rejected, 1);
});

test('XN trước nhập viện đã gắn kèm đợt vẫn hiển thị (có nhãn); dòng sau ra viện và dòng ngoài đợt khác bị loại', () => {
  const enc = sanitizeEncounterEvents({
    patient_code: 'BN1', encounter_id: 'e1', admission_date: '2026-04-21 08:00', discharge_date: '2026-04-23',
    labs: [
      { patient_code: 'BN1', lab_datetime: '2026-04-19 07:00', test_name_raw: 'Hb', result_raw: '120', unit_raw: 'g/L', encounter_match_method: 'pre_admission' },
      { patient_code: 'BN1', lab_datetime: '2026-04-30 07:00', test_name_raw: 'CRP', result_raw: '5', unit_raw: 'mg/L', encounter_match_method: 'post_discharge' },
      { patient_code: 'BN1', lab_datetime: '2026-04-10 07:00', test_name_raw: 'PLT', result_raw: '200', unit_raw: 'G/L' },
    ], imaging: [], medications: [], surgeries: [],
  });
  assert.deepStrictEqual(enc.labs.map(l => l.test_name_raw), ['Hb']);
  assert.strictEqual(enc.integrity.rejected, 2);
});

test('CĐHA và thuốc ngoài đợt hoặc sai strong id không được hiển thị', () => {
  const enc = sanitizeEncounterEvents({
    patient_code: 'BN1', encounter_id: 'e1', admission_date: '2026-04-21', discharge_date: '2026-04-23', labs: [], surgeries: [],
    imaging: [
      { patient_code: 'BN1', encounter_id: 'e1', ordered_at: '2026-04-22 09:00', service_name_raw: 'X-quang', conclusion_raw: 'Không lệch' },
      { patient_code: 'BN1', encounter_id: 'e1', ordered_at: '2026-05-01 09:00', service_name_raw: 'X-quang', conclusion_raw: 'Khác' },
    ],
    medications: [
      { patient_code: 'BN1', encounter_id: 'e1', order_datetime: '2026-04-22 10:00', medication_name_raw: 'Paracetamol', dose_raw: '1 g' },
      { patient_code: 'BN1', encounter_id: 'e2', order_datetime: '2026-04-22 10:00', medication_name_raw: 'Ceftriaxone', dose_raw: '2 g' },
    ],
  });
  assert.strictEqual(enc.imaging.length, 1);
  assert.strictEqual(enc.medications.length, 1);
  assert.strictEqual(enc.integrity.status, 'critical');
});

test('dòng dữ liệu có Mã BN khác không được đi theo encounter đang hiển thị', () => {
  const enc = sanitizeEncounterEvents({
    patient_code: 'BN1', encounter_id: 'e1', admission_date: '2026-04-21', discharge_date: '2026-04-23',
    labs: [{ patient_code: 'BN2', lab_datetime: '2026-04-22', test_name_raw: 'CRP', result_raw: '5' }], imaging: [], medications: [], surgeries: [],
  });
  assert.strictEqual(enc.labs.length, 0);
  assert.strictEqual(enc.integrity.status, 'critical');
});

console.log(`research_patient_history_guard_test: ${passed} kịch bản pass.`);
if (process.exitCode) process.exit(process.exitCode);
