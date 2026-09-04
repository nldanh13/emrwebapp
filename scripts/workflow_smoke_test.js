#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { writeJsonAtomic } = require('../server/utils/file');
const { clearSessionDerivedState } = require('../server/services/session');
const {
  issueInputPrecheckToken,
  validateAndConsumeInputPrecheckToken,
  hashTargets,
  taskNameFromTargets,
} = require('../server/services/input_precheck_tokens');

function tmpCtx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emr-workflow-'));
  const dataDir = path.join(dir, 'data');
  const stateDir = path.join(dir, 'state');
  const reportsDir = path.join(dir, 'reports');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(reportsDir, { recursive: true });
  return {
    sid: 'workflow_test',
    dir,
    DATA_DIR: dataDir,
    STATE_DIR: stateDir,
    REPORTS_DIR: reportsDir,
    CARE_DONE_PATH: path.join(stateDir, 'care_done.json'),
    INFUSIONS_DONE_PATH: path.join(stateDir, 'infusions_done.json'),
    PROCEDURES_DONE_PATH: path.join(stateDir, 'procedures_done.json'),
    VTYT_DONE_PATH: path.join(stateDir, 'vtyt_done.json'),
    TASK_PROGRESS_PATH: path.join(stateDir, 'task_progress.json'),
  };
}

function exists(p) { return fs.existsSync(p); }

function testDerivedStateReset() {
  const ctx = tmpCtx();
  try {
    for (const file of [ctx.CARE_DONE_PATH, ctx.INFUSIONS_DONE_PATH, ctx.PROCEDURES_DONE_PATH, ctx.VTYT_DONE_PATH, ctx.TASK_PROGRESS_PATH]) {
      writeJsonAtomic(file, { old: true });
    }
    writeJsonAtomic(path.join(ctx.dir, 'admin_nurse_state.json'), { checked: { old: true } });
    writeJsonAtomic(path.join(ctx.dir, 'input_care_result.json'), { succeeded: ['BN01::20/05/2026'] });
    fs.writeFileSync(path.join(ctx.REPORTS_DIR, 'old.pdf'), 'pdf');

    clearSessionDerivedState(ctx, { clearReports: true });

    assert.equal(exists(ctx.CARE_DONE_PATH), false, 'care_done must be reset when dataset changes');
    assert.equal(exists(ctx.INFUSIONS_DONE_PATH), false, 'infusions_done must be reset when dataset changes');
    assert.equal(exists(ctx.PROCEDURES_DONE_PATH), false, 'procedures_done must be reset when dataset changes');
    assert.equal(exists(ctx.VTYT_DONE_PATH), false, 'vtyt_done must be reset when dataset changes');
    assert.equal(exists(ctx.TASK_PROGRESS_PATH), false, 'task progress must be reset when dataset changes');
    assert.equal(exists(path.join(ctx.dir, 'admin_nurse_state.json')), false, 'admin checklist must be reset when dataset changes');
    assert.equal(exists(ctx.REPORTS_DIR), false, 'old reports must be reset when dataset changes');
  } finally {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
}

function testPrecheckTokenWorkflow() {
  const ctx = tmpCtx();
  try {
    const targets = {
      patientIds: ['BN02', 'BN01'],
      patientDates: { BN01: ['20/05/2026'], BN02: ['19/05/2026', '20/05/2026'] },
      selectedDates: [],
      taskType: 'care',
    };
    const sameMeaningDifferentOrder = {
      patientIds: ['BN01', 'BN02'],
      patientDates: { BN02: ['20/05/2026', '19/05/2026'], BN01: ['20/05/2026'] },
      selectedDates: [],
    };

    assert.equal(taskNameFromTargets({ taskType: 'infusion' }), 'input_infusions');
    assert.equal(hashTargets('input_care', targets), hashTargets('care', sameMeaningDifferentOrder), 'target hash should be stable for same BN/day set');

    const issued = issueInputPrecheckToken(ctx, 'input_care', targets, { checked_count: 3 });
    assert.ok(issued.precheck_token, 'precheck token should be issued after ok check');

    const ok = validateAndConsumeInputPrecheckToken(ctx, 'input_care', { ...targets, precheck_token: issued.precheck_token });
    assert.equal(ok.ok, true, 'valid token should allow the matching input action once');

    const reused = validateAndConsumeInputPrecheckToken(ctx, 'input_care', { ...targets, precheck_token: issued.precheck_token });
    assert.equal(reused.ok, false, 'precheck token must be one-time use');

    const issued2 = issueInputPrecheckToken(ctx, 'input_care', targets, { checked_count: 3 });
    const wrongTask = validateAndConsumeInputPrecheckToken(ctx, 'input_infusions', { ...targets, precheck_token: issued2.precheck_token });
    assert.equal(wrongTask.ok, false, 'precheck token must not be reused for a different input type');

    const issued3 = issueInputPrecheckToken(ctx, 'input_care', targets, { checked_count: 3 });
    const wrongTarget = validateAndConsumeInputPrecheckToken(ctx, 'input_care', {
      ...targets,
      patientIds: ['BN01'],
      precheck_token: issued3.precheck_token,
    });
    assert.equal(wrongTarget.ok, false, 'precheck token must match the exact BN/day target set');
  } finally {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
}

testDerivedStateReset();
testPrecheckTokenWorkflow();
console.log('[workflow-smoke] OK');
