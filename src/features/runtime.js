import { useEffect, useMemo, useState } from 'react';
import * as api from '../api.js';
import { FEATURE_DEFINITIONS, WORKFLOW_DEFINITIONS, normalizeWorkflowStep } from './registry.js';

let cachedRegistry = null;
let pendingRegistry = null;

function normalizePayload(payload = {}) {
  return {
    ...payload,
    functions: (Array.isArray(payload.functions) ? payload.functions : FEATURE_DEFINITIONS).map(item => ({ ...item, enabled: item.enabled !== false })),
    workflows: (Array.isArray(payload.workflows) ? payload.workflows : WORKFLOW_DEFINITIONS).map(item => ({
      ...item,
      enabled: item.enabled !== false,
      steps: (Array.isArray(item.steps) ? item.steps : []).map(normalizeWorkflowStep),
    })),
  };
}

export async function loadRuntimeRegistry({ force = false } = {}) {
  if (!force && cachedRegistry) return cachedRegistry;
  if (!force && pendingRegistry) return pendingRegistry;
  pendingRegistry = api.getFeatureRegistry()
    .then(normalizePayload)
    .then(value => { cachedRegistry = value; return value; })
    .finally(() => { pendingRegistry = null; });
  return pendingRegistry;
}

export function invalidateRuntimeRegistry() {
  cachedRegistry = null;
}

export function useRuntimeRegistry() {
  const [state, setState] = useState(() => cachedRegistry || normalizePayload({}));
  const [loading, setLoading] = useState(!cachedRegistry);
  const [error, setError] = useState('');

  const refresh = async (force = true) => {
    setLoading(true);
    setError('');
    try {
      const next = await loadRuntimeRegistry({ force });
      setState(next);
      return next;
    } catch (err) {
      setError(String(err.message || err));
      throw err;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(false).catch(() => {}); }, []);
  return { registry: state, loading, error, refresh };
}

export function useFeatureStates(ids = []) {
  const key = ids.join('|');
  const { registry, loading, error, refresh } = useRuntimeRegistry();
  const states = useMemo(() => {
    const wanted = new Set(ids);
    return Object.fromEntries((registry.functions || []).filter(item => wanted.has(item.id)).map(item => [item.id, item]));
  }, [registry, key]);
  return { states, loading, error, refresh };
}
