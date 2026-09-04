// server/services/workflow_planner.js — Lập kế hoạch dependency, không thực thi.

'use strict';

const { getWorkflow, getFeature } = require('./feature_registry');
const { checkRequirements } = require('./artifact_store');

function stepRequirements(step, feature) {
  return Array.isArray(step.requires) ? step.requires : (feature.requires || []);
}

function stepProvides(step, feature) {
  return Array.isArray(step.provides) ? step.provides : (feature.provides || []);
}

function hasInputForStep(step, feature, request = {}) {
  const executor = feature.executor || {};
  if (!executor.payloadRequired) return true;
  const stepPayload = request.step_payloads?.[step.id] || request.step_payloads?.[feature.id];
  if (stepPayload && Object.prototype.hasOwnProperty.call(stepPayload, 'body')) return true;
  const key = step.inputKey || executor.inputKey;
  if (key && request.inputs && Object.prototype.hasOwnProperty.call(request.inputs, key)) return true;
  return executor.defaultBody !== undefined;
}

function planWorkflow(ctx, workflowId, request = {}) {
  const workflow = getWorkflow(workflowId);
  if (!workflow) {
    const err = new Error('Không tìm thấy workflow.');
    err.code = 'WORKFLOW_NOT_FOUND';
    err.status = 404;
    throw err;
  }

  const skipSteps = new Set((Array.isArray(request.skip_steps) ? request.skip_steps : []).map(String));
  const plannedProvides = new Set(Array.isArray(request.available_artifacts) ? request.available_artifacts.map(String) : []);
  const pendingProvides = new Set();
  const steps = [];

  for (const step of workflow.steps) {
    const feature = getFeature(step.feature);
    const requires = stepRequirements(step, feature || {});
    const provides = stepProvides(step, feature || {});
    let status = 'ready';
    let reason = '';

    if (!workflow.enabled) {
      status = 'skipped'; reason = 'workflow-disabled';
    } else if (!feature) {
      status = 'blocked'; reason = 'feature-not-found';
    } else if (!step.enabled || skipSteps.has(step.id) || skipSteps.has(feature.id)) {
      status = 'skipped'; reason = 'step-skipped';
    } else if (!feature.enabled) {
      status = 'skipped'; reason = 'feature-disabled';
    }

    const dependency = checkRequirements(ctx, requires, new Map(), plannedProvides);
    const pendingDependencyIds = dependency.missing.filter(id => pendingProvides.has(String(id)));
    if (status === 'ready' && !dependency.ok) {
      if (pendingDependencyIds.length) {
        status = 'blocked';
        reason = 'upstream-needs-input';
      } else {
        status = step.optional ? 'skipped' : 'blocked';
        reason = 'missing-dependency';
      }
    }
    if (status === 'ready' && !hasInputForStep(step, feature, request)) {
      status = 'needs-input';
      reason = 'payload-required';
    }

    if (status === 'ready') {
      for (const artifact of provides) plannedProvides.add(String(artifact));
    } else if (status === 'needs-input' || reason === 'upstream-needs-input') {
      // Đầu ra có thể xuất hiện sau khi người dùng bổ sung input; không coi là sẵn sàng ngay.
      for (const artifact of provides) pendingProvides.add(String(artifact));
    }

    steps.push({
      id: step.id,
      feature_id: step.feature,
      label: step.label || feature?.label || step.id,
      status,
      reason,
      optional: step.optional,
      on_failure: step.onFailure,
      on_disabled: step.onDisabled,
      requires,
      provides,
      dependency,
      pending_dependencies: pendingDependencyIds,
      executor: feature?.executor || null,
    });
  }

  const summary = {
    total: steps.length,
    ready: steps.filter(x => x.status === 'ready').length,
    needs_input: steps.filter(x => x.status === 'needs-input').length,
    skipped: steps.filter(x => x.status === 'skipped').length,
    blocked: steps.filter(x => x.status === 'blocked').length,
  };
  return {
    status: summary.blocked || summary.needs_input ? 'partial' : 'ok',
    workflow: { id: workflow.id, label: workflow.label, description: workflow.description, enabled: workflow.enabled },
    steps,
    summary,
  };
}

module.exports = { planWorkflow, stepRequirements, stepProvides, hasInputForStep };
