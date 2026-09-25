import { IconArrowLeft, IconChevronRight, IconLayoutGrid, IconRoute, IconX } from '@tabler/icons-react';
import { C, FS } from '../tokens.js';
import { Btn } from './shared.jsx';
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
            {index > 0 && <IconChevronRight size={14} stroke={1.75} color={C.text3} aria-hidden="true" />}
            <span style={{ border: `1px solid ${C.border}`, background: C.surface, borderRadius: 4, padding: '3px 7px', color: C.text2, fontSize: FS.xs }}>
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
  const Icon = isWorkflow ? IconRoute : IconLayoutGrid;
  return (
    <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border2}`, background: C.surface, flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span style={{ width: 30, height: 30, borderRadius: 7, display: 'grid', placeItems: 'center', background: C.blueBg, color: C.blue, flexShrink: 0 }} aria-hidden="true">
          <Icon size={17} stroke={1.75} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ color: C.text, fontSize: FS.md, fontWeight: 700 }}>
            {definition.label}
            <span style={{ color: C.text3, fontWeight: 500, fontSize: FS.xs, marginLeft: 8 }}>{isWorkflow ? 'Quy trình đang mở' : 'Chức năng đang mở'}</span>
          </div>
          {definition.description && <div style={{ color: C.text2, fontSize: FS.sm, marginTop: 2 }}>{definition.description}</div>}
          {isWorkflow && <StepList steps={definition.steps} />}
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <Btn icon={IconArrowLeft} onClick={onBack}>Bộ chức năng</Btn>
          <button type="button" className="emr-icon-btn" onClick={onClose} aria-label="Đóng chỉ dẫn" title="Đóng chỉ dẫn">
            <IconX size={17} stroke={1.75} />
          </button>
        </div>
      </div>
    </div>
  );
}
