'use strict';

const assert = require('assert');
const {
  sameDisplayStay,
  collapseDisplayEncounters,
  sanitizeEncounterEvents,
  sanitizePatientHistory,
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
  assert.strictEqual(rows[0].counts.labs, 1);
  assert.strictEqual(rows[0].counts.imaging, 1);
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
      patient_code: 'BN1',
      patient_codes: ['BN1', 'BN2'],
      patient_name: 'NGUYEN VAN A',
      encounter_count: 3,
      possible_same_patient_codes: true,
      encounters: [
        { patient_code: 'BN1', encounter_id: 'a', admission_date: '2026-01-01', discharge_date: '' },
        { patient_code: 'BN1', encounter_id: 'b', admission_date: '2026-01-01', discharge_date: '2026-01-03' },
        { patient_code: 'BN2', encounter_id: 'c', admission_date: '2026-02-01', discharge_date: '2026-02-03' },
      ],
    }],
    total_matches: 1,
    data_source: 'sqlite',
  };
  const out = sanitizePatientHistory(payload, 'BN1');
  assert.strictEqual(out.patients.length, 1);
  assert.deepStrictEqual(out.patients[0].patient_codes, ['BN1']);
  assert.strictEqual(out.patients[0].encounter_count, 1);
  assert.ok(out.patients[0].encounters.every(e => e.patient_code === 'BN1'));
});

test('phẫu thuật ngoài khoảng nằm viện bị loại và ngày mổ tóm tắt sai bị xóa', () => {
  const enc = sanitizeEncounterEvents({
    patient_code: 'BN1', encounter_id: 'e1',
    admission_date: '2026-04-21 09:55', discharge_date: '2026-04-23 13:00',
    surgery_date: '2026-10-04 18:39',
    surgeries: [
      { patient_code: 'BN1', encounter_id: 'e1', surgery_datetime: '2026-10-04 18:39', surgery_name: 'Rút đinh', method: 'Rút đinh', anesthesia: 'Gây mê' },
      { patient_code: 'BN1', encounter_id: 'e1', surgery_datetime: '2026-10-04 18:39', surgery_name: 'Rút đinh', method: 'Rút đinh', anesthesia: 'Gây mê' },
    ],
    labs: [], imaging: [], medications: [],
  });
  assert.strictEqual(enc.surgeries.length, 0);
  assert.strictEqual(enc.counts.surgeries, 0);
  assert.strictEqual(enc.surgery_date, '');
  assert.strictEqual(enc.excluded_counts.surgeries, 2);
});

test('phẫu thuật trùng nội dung trong đúng đợt chỉ giữ một dòng', () => {
  const enc = sanitizeEncounterEvents({
    patient_code: 'BN1', encounter_id: 'e1',
    admission_date: '2026-04-21', discharge_date: '2026-04-23',
    surgeries: [
      { id: 'raw-a', patient_code: 'BN1', surgery_datetime: '2026-04-22 08:00', surgery_name: 'Kết hợp xương', method: 'Nẹp vít', anesthesia: 'Tê tủy sống' },
      { id: 'raw-b', patient_code: 'BN1', surgery_datetime: '2026-04-22 08:00', surgery_name: 'Kết hợp xương', method: 'Nẹp vít', anesthesia: 'Tê tủy sống' },
    ],
    labs: [], imaging: [], medications: [],
  });
  assert.strictEqual(enc.surgeries.length, 1);
  assert.strictEqual(enc.counts.surgeries, 1);
  assert.strictEqual(enc.surgery_date, '2026-04-22 08:00');
});

test('XN chỉ giữ kết quả trong khoảng nằm viện và loại bản trùng lâm sàng', () => {
  const enc = sanitizeEncounterEvents({
    patient_code: 'BN1', encounter_id: 'e1',
    admission_date: '2026-04-21', discharge_date: '2026-04-23',
    labs: [
      { id: 1, patient_code: 'BN1', lab_datetime: '2026-04-20 07:00', test_name_raw: 'Hb', result_raw: '120', unit_raw: 'g/L' },
      { id: 2, patient_code: 'BN1', lab_datetime: '2026-04-22 07:00', test_name_raw: 'Hb', result_raw: '118', unit_raw: 'g/L' },
      { id: 3, patient_code: 'BN1', lab_datetime: '2026-04-22 07:00', test_name_raw: 'Hb', result_raw: '118', unit_raw: 'g/L' },
      { id: 4, patient_code: 'BN1', lab_datetime: '2026-04-24 07:00', test_name_raw: 'Hb', result_raw: '116', unit_raw: 'g/L' },
    ],
    imaging: [], medications: [], surgeries: [],
  });
  assert.strictEqual(enc.labs.length, 1);
  assert.strictEqual(enc.labs[0].result_raw, '118');
  assert.strictEqual(enc.excluded_counts.labs, 3);
});

test('CĐHA và thuốc ngoài đợt hoặc sai encounter_id không được hiển thị', () => {
  const enc = sanitizeEncounterEvents({
    patient_code: 'BN1', encounter_id: 'e1',
    admission_date: '2026-04-21', discharge_date: '2026-04-23',
    labs: [], surgeries: [],
    imaging: [
      { patient_code: 'BN1', encounter_id: 'e1', ordered_at: '2026-04-22 09:00', service_name_raw: 'X-quang', conclusion_raw: 'Không lệch' },
      { patient_code: 'BN1', encounter_id: 'e1', ordered_at: '2026-05-01 09:00', service_name_raw: 'X-quang', conclusion_raw: 'Khác' },
    ],
    medications: [
      { patient_code: 'BN1', encounter_id: 'e1', order_datetime: '2026-04-22 10:00', medication_name_raw: 'Paracetamol', dose_raw: '1 g' },
      { patient_code: 'BN1', encounter_id: 'e2', order_datetime: '2026-04-22 10:00', medication_name_raw: 'Ceftriaxone', dose_raw: '2 g' },
      { patient_code: 'BN1', encounter_id: 'e1', order_datetime: '2026-04-25 10:00', medication_name_raw: 'Ibuprofen', dose_raw: '400 mg' },
    ],
  });
  assert.strictEqual(enc.imaging.length, 1);
  assert.strictEqual(enc.medications.length, 1);
  assert.strictEqual(enc.medications[0].medication_name_raw, 'Paracetamol');
  assert.strictEqual(enc.excluded_counts.imaging, 1);
  assert.strictEqual(enc.excluded_counts.medications, 2);
});

test('dòng dữ liệu có Mã BN khác không được đi theo encounter đang hiển thị', () => {
  const enc = sanitizeEncounterEvents({
    patient_code: 'BN1', encounter_id: 'e1',
    admission_date: '2026-04-21', discharge_date: '2026-04-23',
    labs: [{ patient_code: 'BN2', lab_datetime: '2026-04-22', test_name_raw: 'CRP', result_raw: '5' }],
    imaging: [], medications: [], surgeries: [],
  });
  assert.strictEqual(enc.labs.length, 0);
  assert.strictEqual(enc.excluded_counts.labs, 1);
});

console.log(`research_patient_history_guard_test: ${passed} kịch bản pass.`);
if (process.exitCode) process.exit(process.exitCode);
