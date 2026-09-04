import registry from '../../config/feature_registry.json';

function freezeList(items, compareFn = null) {
  const list = (Array.isArray(items) ? items : []).map(item => Object.freeze({ ...item }));
  if (typeof compareFn === 'function') list.sort(compareFn);
  return Object.freeze(list);
}

function normalizeFeature(item = {}) {
  return {
    ...item,
    enabled: item.enabled !== false,
    protected: item.protected === true,
    requires: Array.isArray(item.requires) ? item.requires : [],
    optionalRequires: Array.isArray(item.optionalRequires) ? item.optionalRequires : [],
    provides: Array.isArray(item.provides) ? item.provides : [],
    actions: Array.isArray(item.actions) ? item.actions : [],
    executor: item.executor && typeof item.executor === 'object' ? item.executor : { type: 'manual' },
  };
}

export function normalizeWorkflowStep(step, index = 0) {
  const raw = typeof step === 'string' ? { id: step, feature: step } : (step || {});
  return {
    ...raw,
    id: raw.id || raw.feature || `step-${index + 1}`,
    feature: raw.feature || raw.featureId || raw.id || '',
    enabled: raw.enabled !== false,
    optional: raw.optional === true,
    requires: Array.isArray(raw.requires) ? raw.requires : null,
    provides: Array.isArray(raw.provides) ? raw.provides : null,
  };
}

function normalizeWorkflow(item = {}) {
  return {
    ...item,
    enabled: item.enabled !== false,
    continueOnFailure: item.continueOnFailure !== false,
    steps: (Array.isArray(item.steps) ? item.steps : []).map(normalizeWorkflowStep),
  };
}

export const FEATURE_REGISTRY_VERSION = Number(registry.version || 1);
export const NAV_ENTRIES = freezeList(
  registry.navigation,
  (a, b) => Number(a.order || 0) - Number(b.order || 0),
);
export const FEATURE_DEFINITIONS = Object.freeze((Array.isArray(registry.functions) ? registry.functions : []).map(normalizeFeature).map(Object.freeze));
export const WORKFLOW_DEFINITIONS = Object.freeze((Array.isArray(registry.workflows) ? registry.workflows : []).map(normalizeWorkflow).map(Object.freeze));

const navById = new Map(NAV_ENTRIES.map(item => [item.id, item]));
const featureById = new Map(FEATURE_DEFINITIONS.map(item => [item.id, item]));
const workflowById = new Map(WORKFLOW_DEFINITIONS.map(item => [item.id, item]));

export function getNavigationEntry(id) {
  return navById.get(String(id || '')) || NAV_ENTRIES[0];
}

export function getFeatureDefinition(id, definitions = FEATURE_DEFINITIONS) {
  if (definitions === FEATURE_DEFINITIONS) return featureById.get(String(id || '')) || null;
  return (Array.isArray(definitions) ? definitions : []).find(item => item.id === String(id || '')) || null;
}

export function getWorkflowDefinition(id, definitions = WORKFLOW_DEFINITIONS) {
  if (definitions === WORKFLOW_DEFINITIONS) return workflowById.get(String(id || '')) || null;
  return (Array.isArray(definitions) ? definitions : []).find(item => item.id === String(id || '')) || null;
}

export function getFeatureGroups(definitions = FEATURE_DEFINITIONS) {
  const groups = [];
  for (const feature of definitions) {
    let group = groups.find(item => item.name === feature.group);
    if (!group) {
      group = { name: feature.group || 'Khác', features: [] };
      groups.push(group);
    }
    group.features.push(feature);
  }
  return groups;
}

export function resolveContextDefinition(context) {
  if (!context?.id) return null;
  return context.kind === 'workflow'
    ? getWorkflowDefinition(context.id)
    : getFeatureDefinition(context.id);
}

export function validateFeatureRegistry(source = { navigation: NAV_ENTRIES, functions: FEATURE_DEFINITIONS, workflows: WORKFLOW_DEFINITIONS }) {
  const errors = [];
  const navIds = new Set((source.navigation || []).map(item => item.id));
  const featureIds = new Set((source.functions || []).map(item => item.id));

  for (const feature of source.functions || []) {
    if (!feature.id || !feature.label) errors.push('Chức năng thiếu id hoặc label.');
    if (!navIds.has(feature.entryTab)) errors.push(`Chức năng ${feature.id} trỏ tới tab không tồn tại: ${feature.entryTab}`);
  }
  for (const workflow of source.workflows || []) {
    if (!navIds.has(workflow.entryTab)) errors.push(`Workflow ${workflow.id} trỏ tới tab không tồn tại: ${workflow.entryTab}`);
    for (const [index, rawStep] of (workflow.steps || []).entries()) {
      const step = normalizeWorkflowStep(rawStep, index);
      if (!featureIds.has(step.feature)) errors.push(`Workflow ${workflow.id} chứa bước không tồn tại: ${step.feature}`);
    }
  }
  return { ok: errors.length === 0, errors };
}
