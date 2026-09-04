// server/routes/features.js — Registry hiệu lực và công tắc module.

'use strict';

const router = require('express').Router();
const {
  publicRegistry,
  getFeature,
  updateFeatureOverride,
  clearOverride,
  loadRegistry,
} = require('../services/feature_registry');
const { requireRole } = require('../services/authz');

router.get('/features', (_req, res) => {
  const registry = publicRegistry();
  res.json({ status: 'ok', ...registry });
});

router.get('/features/:featureId', (req, res) => {
  const feature = getFeature(req.params.featureId);
  if (!feature) return res.status(404).json({ status: 'error', code: 'FEATURE_NOT_FOUND', message: 'Không tìm thấy chức năng.' });
  const registry = publicRegistry();
  const workflows = registry.workflows.filter(item => (item.steps || []).some(step => step.feature === feature.id));
  return res.json({ status: 'ok', feature, workflows });
});

router.patch('/features/:featureId/state', requireRole('admin'), (req, res) => {
  try {
    updateFeatureOverride(req.params.featureId, req.body || {});
    return res.json({ status: 'ok', feature: getFeature(req.params.featureId) });
  } catch (err) {
    return res.status(Number(err.status) || 500).json({ status: 'error', code: err.code || 'FEATURE_UPDATE_FAILED', message: String(err.message || err) });
  }
});

router.delete('/features/:featureId/state', requireRole('admin'), (req, res) => {
  clearOverride('feature', req.params.featureId);
  return res.json({ status: 'ok', feature: getFeature(req.params.featureId) });
});

router.post('/features/reload', requireRole('admin'), (_req, res) => {
  try {
    const registry = loadRegistry({ force: true });
    return res.json({ status: 'ok', version: registry.version, validation: registry.validation });
  } catch (err) {
    return res.status(500).json({ status: 'error', code: err.code || 'FEATURE_RELOAD_FAILED', message: String(err.message || err) });
  }
});

module.exports = router;
