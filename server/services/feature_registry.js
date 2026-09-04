// server/services/feature_registry.js — Registry hiệu lực, override runtime và ánh xạ route.

'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG_DIR, RUNTIME_ROOT } = require('../constants');
const { ensureDir, readJsonSafe, writeJsonAtomic } = require('../utils/file');

const REGISTRY_PATH = path.join(CONFIG_DIR, 'feature_registry.json');
const OVERRIDES_PATH = path.resolve(
  process.env.EMR_FEATURE_OVERRIDES_FILE || path.join(RUNTIME_ROOT, 'config', 'feature_overrides.json'),
);

const ALLOWED_FEATURE_OVERRIDE_KEYS = new Set([
  'enabled', 'failurePolicy', 'disabledPolicy', 'timeoutMs', 'retry', 'notes',
]);
const ALLOWED_WORKFLOW_OVERRIDE_KEYS = new Set([
  'enabled', 'continueOnFailure', 'notes', 'steps',
]);

let cache = null;
let cacheStamp = '';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function fileStamp(filePath) {
  try {
    const s = fs.statSync(filePath);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return 'missing';
  }
}

function normalizeRetry(value, defaults = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  const maxAttempts = Math.max(1, Math.min(5, Number.parseInt(raw.maxAttempts ?? defaults.maxAttempts ?? 1, 10) || 1));
  const delayMs = Math.max(0, Math.min(60_000, Number.parseInt(raw.delayMs ?? defaults.delayMs ?? 500, 10) || 0));
  const retryStatuses = Array.isArray(raw.retryStatuses)
    ? raw.retryStatuses.map(Number).filter(n => Number.isFinite(n) && n >= 400 && n <= 599)
    : (Array.isArray(defaults.retryStatuses) ? [...defaults.retryStatuses] : [429, 502, 503, 504]);
  return { maxAttempts, delayMs, retryStatuses };
}

function normalizeRoute(route, executor = {}) {
  if (!route || typeof route !== 'object') return null;
  const method = String(route.method || executor.method || 'GET').toUpperCase();
  const routePath = String(route.path || executor.path || '').trim();
  if (!routePath.startsWith('/')) return null;
  return {
    method,
    path: routePath,
    gate: route.gate !== false,
    action: String(route.action || 'execute'),
  };
}

function normalizeExecutor(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const type = String(raw.type || (raw.path ? 'http' : 'manual')).toLowerCase();
  const out = {
    type: ['http', 'virtual', 'manual'].includes(type) ? type : 'manual',
    method: String(raw.method || 'GET').toUpperCase(),
    path: String(raw.path || '').trim(),
    inputKey: String(raw.inputKey || '').trim(),
    queryKey: String(raw.queryKey || '').trim(),
    payloadRequired: raw.payloadRequired === true,
    safeAutoRun: raw.safeAutoRun === true,
    defaultBody: raw.defaultBody === undefined ? undefined : clone(raw.defaultBody),
    defaultQuery: raw.defaultQuery && typeof raw.defaultQuery === 'object' ? clone(raw.defaultQuery) : {},
  };
  if (out.type === 'http' && !out.path.startsWith('/')) out.type = 'manual';
  return out;
}

function normalizeFeature(feature, defaults = {}) {
  const executor = normalizeExecutor(feature.executor);
  const routes = (Array.isArray(feature.routes) ? feature.routes : [])
    .map(route => normalizeRoute(route, executor))
    .filter(Boolean);
  if (executor.type === 'http' && executor.path && !routes.some(r => r.method === executor.method && r.path === executor.path)) {
    routes.push(normalizeRoute({ method: executor.method, path: executor.path }, executor));
  }
  return {
    ...clone(feature),
    id: String(feature.id || '').trim(),
    enabled: feature.enabled !== false,
    protected: feature.protected === true,
    failurePolicy: String(feature.failurePolicy || defaults.failurePolicy || 'stop-dependents'),
    disabledPolicy: String(feature.disabledPolicy || defaults.disabledPolicy || 'skip'),
    timeoutMs: Math.max(1000, Math.min(6 * 60 * 60 * 1000, Number(feature.timeoutMs || defaults.timeoutMs || 30 * 60 * 1000))),
    retry: normalizeRetry(feature.retry, defaults.retry),
    requires: Array.isArray(feature.requires) ? [...feature.requires] : [],
    optionalRequires: Array.isArray(feature.optionalRequires) ? [...feature.optionalRequires] : [],
    provides: Array.isArray(feature.provides) ? [...feature.provides] : [],
    actions: Array.isArray(feature.actions) ? [...feature.actions] : [],
    executor,
    routes,
  };
}

function normalizeStep(step, index, workflow = {}, stepDefaults = {}) {
  const raw = typeof step === 'string' ? { id: step, feature: step } : (step || {});
  const featureId = String(raw.feature || raw.featureId || raw.id || '').trim();
  const id = String(raw.id || featureId || `step-${index + 1}`).trim();
  const workflowOptions = workflow.stepOptions && typeof workflow.stepOptions === 'object'
    ? workflow.stepOptions[id] || workflow.stepOptions[featureId] || {}
    : {};
  const merged = { ...workflowOptions, ...raw };
  return {
    ...clone(merged),
    id,
    feature: featureId,
    label: String(merged.label || '').trim(),
    enabled: merged.enabled !== false,
    optional: merged.optional === true,
    onFailure: String(merged.onFailure || stepDefaults.onFailure || 'stop-dependents'),
    onDisabled: String(merged.onDisabled || stepDefaults.onDisabled || 'skip'),
    inputKey: String(merged.inputKey || '').trim(),
    queryKey: String(merged.queryKey || '').trim(),
    requires: Array.isArray(merged.requires) ? [...merged.requires] : null,
    provides: Array.isArray(merged.provides) ? [...merged.provides] : null,
    inject: merged.inject && typeof merged.inject === 'object' ? clone(merged.inject) : {},
  };
}

function normalizeWorkflow(workflow, defaults = {}, stepDefaults = {}) {
  const steps = (Array.isArray(workflow.steps) ? workflow.steps : [])
    .map((step, index) => normalizeStep(step, index, workflow, stepDefaults));
  return {
    ...clone(workflow),
    id: String(workflow.id || '').trim(),
    enabled: workflow.enabled !== false,
    continueOnFailure: workflow.continueOnFailure !== false,
    steps,
  };
}

function sanitizeOverrideObject(raw, allowedKeys) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (allowedKeys.has(key)) out[key] = clone(value);
  }
  return out;
}

function loadOverrides() {
  const filePayload = readJsonSafe(OVERRIDES_PATH, {});
  let envPayload = {};
  const inline = String(process.env.EMR_FEATURE_OVERRIDES_JSON || '').trim();
  if (inline) {
    try { envPayload = JSON.parse(inline); }
    catch (err) { throw new Error(`EMR_FEATURE_OVERRIDES_JSON không hợp lệ: ${err.message}`); }
  }
  const mergeBucket = (a, b) => ({ ...(a || {}), ...(b || {}) });
  return {
    version: 1,
    features: mergeBucket(filePayload?.features, envPayload?.features),
    workflows: mergeBucket(filePayload?.workflows, envPayload?.workflows),
  };
}

function applyOverrides(registry, overrides) {
  for (const feature of registry.functions) {
    const raw = sanitizeOverrideObject(overrides.features?.[feature.id], ALLOWED_FEATURE_OVERRIDE_KEYS);
    if (feature.protected && raw.enabled === false) delete raw.enabled;
    Object.assign(feature, raw);
    feature.retry = normalizeRetry(feature.retry);
  }
  for (const workflow of registry.workflows) {
    const raw = sanitizeOverrideObject(overrides.workflows?.[workflow.id], ALLOWED_WORKFLOW_OVERRIDE_KEYS);
    if (raw.steps && typeof raw.steps === 'object' && !Array.isArray(raw.steps)) {
      for (const step of workflow.steps) {
        const stepOverride = raw.steps[step.id] || raw.steps[step.feature];
        if (stepOverride && typeof stepOverride === 'object') Object.assign(step, clone(stepOverride));
      }
      delete raw.steps;
    }
    Object.assign(workflow, raw);
  }
  return registry;
}

function validateRegistry(registry) {
  const errors = [];
  const navIds = new Set((registry.navigation || []).map(item => item.id));
  const featureIds = new Set();
  for (const feature of registry.functions || []) {
    if (!feature.id) errors.push('Có chức năng thiếu id.');
    if (featureIds.has(feature.id)) errors.push(`Trùng feature id: ${feature.id}`);
    featureIds.add(feature.id);
    if (!navIds.has(feature.entryTab)) errors.push(`Feature ${feature.id} trỏ tới tab không tồn tại: ${feature.entryTab}`);
  }
  const workflowIds = new Set();
  for (const workflow of registry.workflows || []) {
    if (!workflow.id) errors.push('Có workflow thiếu id.');
    if (workflowIds.has(workflow.id)) errors.push(`Trùng workflow id: ${workflow.id}`);
    workflowIds.add(workflow.id);
    if (!navIds.has(workflow.entryTab)) errors.push(`Workflow ${workflow.id} trỏ tới tab không tồn tại: ${workflow.entryTab}`);
    const stepIds = new Set();
    for (const step of workflow.steps || []) {
      if (stepIds.has(step.id)) errors.push(`Workflow ${workflow.id} trùng step id: ${step.id}`);
      stepIds.add(step.id);
      if (!featureIds.has(step.feature)) errors.push(`Workflow ${workflow.id} dùng feature không tồn tại: ${step.feature}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function loadRegistry({ force = false } = {}) {
  const stamp = `${fileStamp(REGISTRY_PATH)}|${fileStamp(OVERRIDES_PATH)}|${process.env.EMR_FEATURE_OVERRIDES_JSON || ''}`;
  if (!force && cache && stamp === cacheStamp) return cache;
  const raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const defaults = raw.defaults && typeof raw.defaults === 'object' ? raw.defaults : {};
  const registry = {
    version: Number(raw.version || 1),
    defaults: clone(defaults),
    navigation: Array.isArray(raw.navigation) ? clone(raw.navigation) : [],
    functions: (Array.isArray(raw.functions) ? raw.functions : []).map(item => normalizeFeature(item, defaults.feature || {})),
    workflows: (Array.isArray(raw.workflows) ? raw.workflows : []).map(item => normalizeWorkflow(item, defaults.workflow || {}, defaults.workflowStep || {})),
  };
  applyOverrides(registry, loadOverrides());
  const validation = validateRegistry(registry);
  if (!validation.ok) {
    const err = new Error(`Feature registry không hợp lệ:\n- ${validation.errors.join('\n- ')}`);
    err.code = 'FEATURE_REGISTRY_INVALID';
    throw err;
  }
  registry.validation = validation;
  cache = registry;
  cacheStamp = stamp;
  return cache;
}

function getFeature(featureId) {
  return loadRegistry().functions.find(item => item.id === String(featureId || '')) || null;
}

function getWorkflow(workflowId) {
  return loadRegistry().workflows.find(item => item.id === String(workflowId || '')) || null;
}

function routePatternToRegex(routePath) {
  const escaped = String(routePath || '')
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/:[A-Za-z0-9_]+/g, '[^/]+');
  return new RegExp(`^${escaped}/?$`);
}

function resolveFeaturesForRequest(method, requestPath) {
  const wantedMethod = String(method || 'GET').toUpperCase();
  const wantedPath = String(requestPath || '').split('?')[0] || '/';
  const matches = [];
  for (const feature of loadRegistry().functions) {
    for (const route of feature.routes || []) {
      if (!route.gate || route.method !== wantedMethod) continue;
      if (routePatternToRegex(route.path).test(wantedPath)) {
        matches.push({ feature, route });
        break;
      }
    }
  }
  return matches;
}

function readOverrideFile() {
  const payload = readJsonSafe(OVERRIDES_PATH, { version: 1, features: {}, workflows: {} });
  return {
    version: 1,
    features: payload?.features && typeof payload.features === 'object' ? payload.features : {},
    workflows: payload?.workflows && typeof payload.workflows === 'object' ? payload.workflows : {},
  };
}

function writeOverrides(payload) {
  ensureDir(path.dirname(OVERRIDES_PATH));
  writeJsonAtomic(OVERRIDES_PATH, payload);
  try { fs.chmodSync(OVERRIDES_PATH, 0o600); } catch (_) {}
  loadRegistry({ force: true });
  return readOverrideFile();
}

function updateFeatureOverride(featureId, patch = {}) {
  const feature = getFeature(featureId);
  if (!feature) {
    const err = new Error('Không tìm thấy chức năng.');
    err.code = 'FEATURE_NOT_FOUND';
    err.status = 404;
    throw err;
  }
  const clean = sanitizeOverrideObject(patch, ALLOWED_FEATURE_OVERRIDE_KEYS);
  if (feature.protected && clean.enabled === false) {
    const err = new Error('Đây là chốt an toàn bắt buộc và không thể tắt.');
    err.code = 'PROTECTED_FEATURE';
    err.status = 409;
    throw err;
  }
  const payload = readOverrideFile();
  payload.features[feature.id] = { ...(payload.features[feature.id] || {}), ...clean };
  return writeOverrides(payload);
}

function updateWorkflowOverride(workflowId, patch = {}) {
  const workflow = getWorkflow(workflowId);
  if (!workflow) {
    const err = new Error('Không tìm thấy workflow.');
    err.code = 'WORKFLOW_NOT_FOUND';
    err.status = 404;
    throw err;
  }
  const clean = sanitizeOverrideObject(patch, ALLOWED_WORKFLOW_OVERRIDE_KEYS);
  const payload = readOverrideFile();
  payload.workflows[workflow.id] = { ...(payload.workflows[workflow.id] || {}), ...clean };
  return writeOverrides(payload);
}

function clearOverride(kind, id) {
  const payload = readOverrideFile();
  const bucket = kind === 'workflow' ? payload.workflows : payload.features;
  delete bucket[String(id || '')];
  return writeOverrides(payload);
}

function publicRegistry() {
  const registry = loadRegistry();
  return clone({
    version: registry.version,
    defaults: registry.defaults,
    navigation: registry.navigation,
    functions: registry.functions,
    workflows: registry.workflows,
    override_path: path.relative(RUNTIME_ROOT, OVERRIDES_PATH).replace(/\\/g, '/'),
    validation: registry.validation,
  });
}

module.exports = {
  REGISTRY_PATH,
  OVERRIDES_PATH,
  loadRegistry,
  publicRegistry,
  validateRegistry,
  getFeature,
  getWorkflow,
  resolveFeaturesForRequest,
  updateFeatureOverride,
  updateWorkflowOverride,
  clearOverride,
};
