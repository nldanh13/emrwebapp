// server/services/workflow_runner.js — Thực thi tuần tự nhưng lỗi một nhánh không làm chết nhánh độc lập.

'use strict';

const { getWorkflow, getFeature } = require('./feature_registry');
const { checkRequirements, recordOutputs } = require('./artifact_store');
const { planWorkflow, stepRequirements, stepProvides } = require('./workflow_planner');
const workflowStore = require('./workflow_store');
const { PORT } = require('../constants');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function nowIso() { return new Date().toISOString(); }

function safeSummary(payload, httpStatus = 0) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { http_status: httpStatus, status: httpStatus >= 200 && httpStatus < 300 ? 'ok' : 'error', message: String(payload || '').slice(0, 300) };
  }
  const count = payload.count ?? payload.fetched_count ?? payload.checked_count ?? payload.plan?.length ?? payload.rows?.length ?? payload.items?.length;
  return {
    http_status: httpStatus,
    status: String(payload.status || (httpStatus >= 200 && httpStatus < 300 ? 'ok' : 'error')),
    code: String(payload.code || ''),
    count: Number.isFinite(Number(count)) ? Number(count) : undefined,
    message: String(payload.message || '').slice(0, 300),
  };
}

function stepPayloadFor(request, step, feature) {
  return request.step_payloads?.[step.id] || request.step_payloads?.[feature.id] || {};
}

function resolveInput(request, step, feature, ephemeral) {
  const executor = feature.executor || {};
  const stepPayload = stepPayloadFor(request, step, feature);
  const inputKey = step.inputKey || executor.inputKey;
  const queryKey = step.queryKey || executor.queryKey;

  let body;
  if (Object.prototype.hasOwnProperty.call(stepPayload, 'body')) body = stepPayload.body;
  else if (inputKey && request.inputs && Object.prototype.hasOwnProperty.call(request.inputs, inputKey)) body = request.inputs[inputKey];
  else if (inputKey && request.inputs && Object.prototype.hasOwnProperty.call(request.inputs, 'inputTargets') && /Targets$/.test(inputKey)) body = request.inputs.inputTargets;
  else if (executor.defaultBody !== undefined) body = executor.defaultBody;

  const query = {
    ...(executor.defaultQuery || {}),
    ...(queryKey && request.inputs?.[queryKey] && typeof request.inputs[queryKey] === 'object' ? request.inputs[queryKey] : {}),
    ...(stepPayload.query && typeof stepPayload.query === 'object' ? stepPayload.query : {}),
  };
  const params = stepPayload.params && typeof stepPayload.params === 'object' ? stepPayload.params : {};

  if (body && typeof body === 'object' && !Array.isArray(body)) {
    body = { ...body, ...(step.inject || {}) };
    for (const requirement of stepRequirements(step, feature)) {
      const ids = String(typeof requirement === 'object' ? (requirement.artifact || requirement.id || '') : requirement)
        .split('|').map(x => x.trim()).filter(Boolean);
      for (const id of ids) {
        const value = ephemeral.get(id);
        if (value?.precheck_token && !body.precheck_token && !body.precheckToken) body.precheck_token = value.precheck_token;
      }
    }
  }
  return { body, query, params };
}

function interpolatePath(template, params = {}) {
  return String(template || '').replace(/:([A-Za-z0-9_]+)/g, (_match, key) => {
    const value = params[key];
    if (value == null || String(value).trim() === '') {
      const err = new Error(`Thiếu path parameter: ${key}`);
      err.code = 'WORKFLOW_PATH_PARAM_REQUIRED';
      throw err;
    }
    return encodeURIComponent(String(value));
  });
}

function buildUrl(_req, executor, input) {
  // Không tin Host header của request bên ngoài; chỉ gọi ngược vào server cục bộ.
  const base = `http://127.0.0.1:${PORT}`;
  const routePath = interpolatePath(executor.path, input.params);
  const url = new URL(routePath.startsWith('/api/') ? routePath : `/api${routePath}`, base);
  for (const [key, value] of Object.entries(input.query || {})) {
    if (value == null || value === '') continue;
    if (Array.isArray(value)) value.forEach(item => url.searchParams.append(key, String(item)));
    else url.searchParams.set(key, String(value));
  }
  return url;
}

function forwardedHeaders(req, ctx, runId, step) {
  const headers = {
    'x-session-id': ctx.sid,
    'x-workflow-run-id': runId,
    'x-workflow-step-id': step.id,
    'x-workflow-feature-id': step.feature,
  };
  for (const name of ['x-app-token', 'authorization', 'cookie']) {
    const value = req.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

async function invokeHttpStep(req, ctx, runId, step, feature, request, ephemeral) {
  const executor = feature.executor;
  const input = resolveInput(request, step, feature, ephemeral);
  if (executor.payloadRequired && input.body === undefined) {
    const err = new Error(`Bước ${step.id} cần dữ liệu đầu vào “${step.inputKey || executor.inputKey || 'body'}”.`);
    err.code = 'WORKFLOW_INPUT_REQUIRED';
    err.status = 422;
    throw err;
  }

  const url = buildUrl(req, executor, input);
  const headers = forwardedHeaders(req, ctx, runId, step);
  const options = { method: executor.method || 'GET', headers };
  if (!['GET', 'HEAD'].includes(options.method) && input.body !== undefined) {
    headers['content-type'] = 'application/json';
    options.body = JSON.stringify(input.body);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), feature.timeoutMs || 30 * 60 * 1000);
  options.signal = controller.signal;
  try {
    const response = await fetch(url, options);
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    let payload;
    if (contentType.includes('application/json')) payload = await response.json();
    else if (contentType.includes('application/pdf') || contentType.includes('application/octet-stream')) {
      const arrayBuffer = await response.arrayBuffer();
      payload = { status: response.ok ? 'ok' : 'error', message: response.ok ? 'Đã tạo tệp nhị phân.' : 'Tạo tệp thất bại.', size_bytes: arrayBuffer.byteLength };
    } else {
      payload = { status: response.ok ? 'ok' : 'error', message: String(await response.text()).slice(0, 1000) };
    }
    return { ok: response.ok, httpStatus: response.status, payload, summary: safeSummary(payload, response.status) };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function invokeWithRetry(req, ctx, runId, step, feature, request, ephemeral) {
  const retry = feature.retry || { maxAttempts: 1, delayMs: 0, retryStatuses: [] };
  let lastError = null;
  let lastResult = null;
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
    try {
      lastResult = await invokeHttpStep(req, ctx, runId, step, feature, request, ephemeral);
      if (lastResult.ok || !retry.retryStatuses.includes(lastResult.httpStatus) || attempt >= retry.maxAttempts) {
        return { ...lastResult, attempts: attempt };
      }
    } catch (err) {
      lastError = err;
      const retryable = err?.name === 'AbortError' || ['ECONNRESET', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'].includes(err?.code);
      if (!retryable || attempt >= retry.maxAttempts) throw err;
    }
    if (retry.delayMs > 0) await sleep(retry.delayMs * attempt);
  }
  if (lastError) throw lastError;
  return { ...lastResult, attempts: retry.maxAttempts };
}

function responseStepStatus(result) {
  const payloadStatus = String(result?.payload?.status || '').toLowerCase();
  if (!result?.ok) return payloadStatus === 'skipped' ? 'skipped' : 'failed';
  if (result.httpStatus === 207 || payloadStatus === 'partial') return 'partial';
  if (payloadStatus === 'skipped') return 'skipped';
  return 'succeeded';
}

function finalRunStatus(steps, cancelled = false) {
  if (cancelled) return 'cancelled';
  const worked = steps.filter(step => ['succeeded', 'partial'].includes(step.status)).length;
  const failed = steps.filter(step => step.status === 'failed').length;
  const blocked = steps.filter(step => ['blocked', 'needs-input'].includes(step.status)).length;
  const partial = steps.filter(step => ['partial', 'skipped'].includes(step.status)).length;
  if (failed && !worked) return 'failed';
  if (failed || blocked || partial) return 'partial';
  return 'succeeded';
}

async function runWorkflow(req, ctx, workflowId, request = {}) {
  const workflow = getWorkflow(workflowId);
  if (!workflow) {
    const err = new Error('Không tìm thấy workflow.');
    err.code = 'WORKFLOW_NOT_FOUND';
    err.status = 404;
    throw err;
  }

  const plan = planWorkflow(ctx, workflowId, request);
  const run = workflowStore.createRun(ctx, {
    workflowId,
    actor: req.auth,
    plan,
    metadata: { requested_skip_steps: Array.isArray(request.skip_steps) ? request.skip_steps.slice(0, 100) : [] },
  });
  workflowStore.updateRun(ctx, run.run_id, { status: 'running', started_at: nowIso() });

  const ephemeral = new Map();
  for (const artifact of Array.isArray(request.available_artifacts) ? request.available_artifacts : []) ephemeral.set(String(artifact), { source: 'request' });
  const stepResults = [];
  let halt = false;
  let cancelled = false;

  for (const planned of plan.steps) {
    const currentRun = workflowStore.getRun(ctx, run.run_id);
    if (currentRun?.cancel_requested) {
      cancelled = true;
      stepResults.push({ ...planned, status: 'cancelled', started_at: nowIso(), finished_at: nowIso(), message: 'Workflow đã được yêu cầu huỷ.' });
      break;
    }

    const step = workflow.steps.find(item => item.id === planned.id);
    const feature = getFeature(step.feature);
    const startedAt = nowIso();

    if (halt) {
      stepResults.push({ ...planned, status: 'cancelled', started_at: startedAt, finished_at: nowIso(), message: 'Bị dừng bởi chính sách lỗi của bước trước.' });
      continue;
    }
    if (planned.status === 'skipped') {
      stepResults.push({ ...planned, status: 'skipped', started_at: startedAt, finished_at: nowIso(), message: planned.reason });
      workflowStore.updateRun(ctx, run.run_id, { steps: stepResults });
      continue;
    }

    const dependency = checkRequirements(ctx, stepRequirements(step, feature), ephemeral, new Set());
    if (!dependency.ok) {
      stepResults.push({ ...planned, status: step.optional ? 'skipped' : 'blocked', started_at: startedAt, finished_at: nowIso(), message: `Thiếu đầu vào: ${dependency.missing.join(', ')}`, dependency });
      workflowStore.updateRun(ctx, run.run_id, { steps: stepResults });
      continue;
    }

    if (feature.executor.type === 'manual') {
      stepResults.push({ ...planned, status: 'skipped', started_at: startedAt, finished_at: nowIso(), message: 'Bước thủ công; workflow không tự thao tác.' });
      workflowStore.updateRun(ctx, run.run_id, { steps: stepResults });
      continue;
    }

    try {
      let result;
      if (feature.executor.type === 'virtual') {
        result = { ok: true, httpStatus: 200, payload: { status: 'ok', message: 'Đã xác nhận artifact và hoàn tất bước logic.' }, summary: { status: 'ok', message: 'Bước logic hoàn tất.' }, attempts: 1 };
      } else {
        result = await invokeWithRetry(req, ctx, run.run_id, step, feature, request, ephemeral);
      }
      const status = responseStepStatus(result);
      const provides = stepProvides(step, feature);
      if (['succeeded', 'partial'].includes(status)) {
        for (const artifactId of provides) {
          const artifact = String(artifactId);
          const value = /token/i.test(artifact) && result.payload?.precheck_token
            ? { precheck_token: result.payload.precheck_token, expires_at: result.payload.precheck_expires_at }
            : { summary: result.summary, source: step.id };
          ephemeral.set(artifact, value);
        }
        recordOutputs(ctx, { featureId: feature.id, stepId: step.id, runId: run.run_id, provides, status: 'ready', summary: result.summary });
      }
      const item = {
        ...planned,
        status,
        started_at: startedAt,
        finished_at: nowIso(),
        attempts: result.attempts || 1,
        http_status: result.httpStatus,
        result: result.summary,
      };
      stepResults.push(item);
      if (status === 'failed' && (step.onFailure === 'halt-workflow' || (!workflow.continueOnFailure && step.onFailure !== 'continue'))) halt = true;
    } catch (err) {
      const item = {
        ...planned,
        status: err?.code === 'WORKFLOW_INPUT_REQUIRED' ? 'needs-input' : 'failed',
        started_at: startedAt,
        finished_at: nowIso(),
        error_code: String(err?.code || (err?.name === 'AbortError' ? 'WORKFLOW_STEP_TIMEOUT' : 'WORKFLOW_STEP_FAILED')),
        message: String(err?.name === 'AbortError' ? 'Bước vượt quá thời gian cho phép.' : err?.message || err).slice(0, 1000),
      };
      stepResults.push(item);
      if (step.onFailure === 'halt-workflow' || (!workflow.continueOnFailure && step.onFailure !== 'continue')) halt = true;
    }
    workflowStore.updateRun(ctx, run.run_id, { steps: stepResults, current_step_id: step.id });
  }

  const status = finalRunStatus(stepResults, cancelled);
  return workflowStore.updateRun(ctx, run.run_id, {
    status,
    steps: stepResults,
    current_step_id: '',
    summary: {
      total: stepResults.length,
      succeeded: stepResults.filter(x => x.status === 'succeeded').length,
      partial: stepResults.filter(x => x.status === 'partial').length,
      skipped: stepResults.filter(x => x.status === 'skipped').length,
      blocked: stepResults.filter(x => ['blocked', 'needs-input'].includes(x.status)).length,
      failed: stepResults.filter(x => x.status === 'failed').length,
    },
  });
}

module.exports = { runWorkflow, safeSummary, finalRunStatus };
