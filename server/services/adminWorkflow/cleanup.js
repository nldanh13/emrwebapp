'use strict';

const { clearWorkflowFiles } = require('./snapshot_store');

function clearAdminWorkflowState(ctx) {
  return clearWorkflowFiles(ctx);
}

module.exports = { clearAdminWorkflowState };
