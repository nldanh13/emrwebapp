'use strict';

const assert = require('node:assert/strict');
const { outsideEncounterMatchType } = require('../server/research/normalization_integrity');

function row(method, overrides = {}) {
  return {
    encounter_id: 'enc_test',
    encounter_match_method: method,
    is_within_encounter: '0',
    ...overrides,
  };
}

for (const method of [
  'encounter_id',
  'emr_treatment_id',
  'emr_treatment_noitru_alias',
  'emr_noitru_id',
  'emr_noitru_treatment_alias',
  'emr_admission_id',
  'emr_admission_noitru_alias',
]) {
  assert.equal(outsideEncounterMatchType(row(method)), 'strong_key', method);
}

assert.equal(outsideEncounterMatchType(row('event_time_range')), 'unverified');
assert.equal(outsideEncounterMatchType(row('exact_visit_time')), 'unverified');
assert.equal(outsideEncounterMatchType(row('pre_admission')), '');
assert.equal(outsideEncounterMatchType(row('emr_treatment_id', { is_within_encounter: '1' })), '');
assert.equal(outsideEncounterMatchType(row('emr_treatment_id', { encounter_id: '' })), '');

console.log('research normalization integrity classification: ok');
