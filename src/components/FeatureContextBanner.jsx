import { C } from '../tokens.js';
import { getFeatureDefinition } from '../features/registry.js';

function StepList({ steps = [] }) {
  if (!steps.length) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', marginTop: 7 }}>
      {steps.map((rawStep, index) => {
        const stepId = typeof rawStep === 'string' ? rawStep : (rawStep?.feature || rawStep?.id || '');
        const stepInstanceId = typeof rawStep === 'string' ? rawStep : (rawStep?.id || stepId);
        const step = getFeatureDefinition(stepId);
        return (
          <span key={stepInstanceId} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            {index > 0 && <span style={{ color: C.text3 }}>→</span>}
            <span style={{ border: `1px solid ${C.border}`, background: C.surface, borderRadius: 4, padding: '3px 6px', color: C.text2, fontSize: 10 }}>
              {rawStep?.label || step?.label || stepInstanceId}
            </span>
          </span>
        );
      })}
    </div>
  );
}

export default function FeatureContextBanner({ context, definition, onBack, onClose }) {
  if (!context || !definition) return null;
  const isWorkflow = context.kind === 'workflow';
  return (
    <div style={{ padding: '7px 12px', borderBottom: `1px solid ${C.border2}`, background: C.surface, flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ width: 26, height: 26, borderRadius: 6, display: 'grid', placeItems: 'center', background: C.surface, border: `1px solid ${C.blueBorder}`, color: C.blue, fontWeight: 800 }}>
          {definition.icon || (isWorkflow ? '◇' : '•')}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ color: C.text3, fontSize: 10, fontWeight: 750 }}>
            {isWorkflow ? 'Quy trình đang mở' : 'Chức năng đang mở'}
          </div>
          <div style={{ color: C.text, fontSize: 13, fontWeight: 800, marginTop: 2 }}>{definition.label}</div>
          <div style={{ color: C.text2, fontSize: 11, marginTop: 2 }}>{definition.description}</div>
          {isWorkflow && <StepList steps={definition.steps} />}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" onClick={onBack} style={{ border: `1px solid ${C.blueBorder}`, background: C.surface, color: C.blue, borderRadius: 5, padding: '5px 8px', fontSize: 11, cursor: 'pointer' }}>Bộ chức năng</button>
          <button type="button" onClick={onClose} title="Đóng chỉ dẫn" style={{ width: 30, height: 30, border: `1px solid ${C.border}`, background: C.surface, color: C.text2, borderRadius: 5, cursor: 'pointer' }}>×</button>
        </div>
      </div>
    </div>
  );
}
