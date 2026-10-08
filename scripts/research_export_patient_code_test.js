'use strict';

const assert = require('node:assert/strict');
const { buildSelectedAnalysisDataset } = require('../server/research/variable_selection');
const { analysisDatasetColumns } = require('../server/research/export_utils');

const patientCode = '26057471';
const selected = buildSelectedAnalysisDataset([{
  research_code: 'NC1311',
  encounter_id: 'enc_test',
  patient_code: patientCode,
  patient_key: 'P000002',
  age: '65',
  needs_manual_review: '',
}], { selected_variables: [] });

assert.ok(selected.columns.includes('patient_code'));
assert.equal(selected.rows[0].patient_code, patientCode);
assert.equal(selected.rows[0].patient_key, 'P000002');

assert.deepEqual(
  analysisDatasetColumns(['research_code', 'patient_code', 'patient_key', 'patient_name', 'citizen_id', 'age']),
  ['research_code', 'patient_code', 'patient_key', 'age'],
);

console.log('research export includes original patient code and preserves pseudonymous key');
