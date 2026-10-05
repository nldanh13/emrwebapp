'use strict';

const assert = require('assert');
const {
  sameDisplayStay,
  collapseDisplayEncounters,
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

console.log(`research_patient_history_guard_test: ${passed} kịch bản pass.`);
if (process.exitCode) process.exit(process.exitCode);
