// server/middleware/feature_gate.js — Chỉ chặn đúng route thuộc feature đã tắt.

'use strict';

const { resolveFeaturesForRequest } = require('../services/feature_registry');
const { getRuntimePaths } = require('../services/session');
const { recordOutputs } = require('../services/artifact_store');

function compactSummary(payload, statusCode) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: statusCode >= 200 && statusCode < 300 ? 'ok' : 'error', message: String(payload || '').slice(0, 300) };
  }
  const count = payload.count ?? payload.fetched_count ?? payload.checked_count ?? payload.items?.length ?? payload.rows?.length;
  return {
    status: String(payload.status || (statusCode >= 200 && statusCode < 300 ? 'ok' : 'error')),
    count: Number.isFinite(Number(count)) ? Number(count) : undefined,
    message: String(payload.message || '').slice(0, 300),
  };
}

function installDirectArtifactRecorder(req, res, matches) {
  // Workflow runner tự ghi output theo step alias; tránh ghi trùng cho subrequest nội bộ.
  if (typeof req.get === 'function' && req.get('x-workflow-run-id')) return;
  if (!res || typeof res.json !== 'function' || typeof res.once !== 'function') return;
  let responsePayload = null;
  const originalJson = res.json.bind(res);
  res.json = (value) => {
    responsePayload = value;
    return originalJson(value);
  };
  res.once('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    try {
      const ctx = getRuntimePaths(req);
      for (const { feature } of matches) {
        recordOutputs(ctx, {
          featureId: feature.id,
          provides: feature.provides || [],
          status: 'ready',
          summary: compactSummary(responsePayload, res.statusCode),
        });
      }
    } catch (err) {
      console.warn('[FEATURE_GATE] Không ghi được artifact:', String(err.message || err));
    }
  });
}

function featureGate(req, res, next) {
  let matches;
  try {
    matches = resolveFeaturesForRequest(req.method, req.path);
  } catch (err) {
    return next(err);
  }
  if (!matches.length) return next();

  const disabled = matches.map(item => item.feature).find(feature => feature.enabled === false);
  if (!disabled) {
    req.featureMatches = matches.map(item => ({ id: item.feature.id, action: item.route.action }));
    installDirectArtifactRecorder(req, res, matches);
    return next();
  }

  return res.status(409).json({
    status: 'skipped',
    code: 'FEATURE_DISABLED',
    feature_id: disabled.id,
    feature_label: disabled.label,
    message: `Chức năng “${disabled.label || disabled.id}” đang tắt. Các chức năng không phụ thuộc vẫn tiếp tục hoạt động.`,
    disabled_policy: disabled.disabledPolicy || 'skip',
  });
}

module.exports = { featureGate, compactSummary };
