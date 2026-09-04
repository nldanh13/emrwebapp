import { useEffect, useMemo, useState } from 'react';
import { C } from '../tokens.js';
import * as api from '../api.js';
import { getFeatureDefinition, getFeatureGroups } from '../features/registry.js';
import { invalidateRuntimeRegistry, useRuntimeRegistry } from '../features/runtime.js';

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function ActionTags({ actions = [] }) {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 9 }}>
      {actions.map(action => (
        <span key={action} style={{ borderRadius: 999, padding: '2px 6px', background: C.surface2, border: `1px solid ${C.border2}`, color: C.text3, fontSize: 9, fontWeight: 700 }}>
          {action}
        </span>
      ))}
    </div>
  );
}

function PolicyLine({ feature }) {
  return (
    <div style={{ display: 'grid', gap: 3, marginTop: 8, color: C.text3, fontSize: 9.5 }}>
      <div><b style={{ color: C.text2 }}>Lỗi:</b> {feature.failurePolicy || 'stop-dependents'}</div>
      <div><b style={{ color: C.text2 }}>Tắt:</b> {feature.disabledPolicy || 'skip'}</div>
      {feature.requires?.length ? <div title={feature.requires.join(', ')}><b style={{ color: C.text2 }}>Cần:</b> {feature.requires.join(', ')}</div> : null}
      {feature.provides?.length ? <div title={feature.provides.join(', ')}><b style={{ color: C.text2 }}>Tạo:</b> {feature.provides.join(', ')}</div> : null}
    </div>
  );
}

function FunctionCard({ feature, onOpen, onToggle, busy }) {
  const enabled = feature.enabled !== false;
  return (
    <div style={{ width: '100%', padding: '11px 12px', borderRadius: 6, border: `1px solid ${enabled ? C.border2 : C.amberBorder}`, background: enabled ? C.surface : C.amberBg, display: 'flex', flexDirection: 'column', minHeight: 170, boxShadow: 'none' }}>
      <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
        <span style={{ width: 22, height: 22, borderRadius: 4, display: 'grid', placeItems: 'center', background: 'transparent', color: enabled ? C.blue : C.amber, fontWeight: 800 }}>{feature.icon || '•'}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ color: C.text, fontSize: 12.5, fontWeight: 800 }}>{feature.label}</div>
          <div style={{ color: C.text3, fontSize: 9, marginTop: 2, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{feature.id}</div>
        </div>
        <span style={{ borderRadius: 999, padding: '3px 7px', background: enabled ? C.greenBg : C.amberBg, color: enabled ? C.green : C.amber, border: `1px solid ${enabled ? C.greenBorder : C.amberBorder}`, fontSize: 9, fontWeight: 800 }}>
          {enabled ? 'Đang bật' : 'Đã tắt'}
        </span>
      </div>
      <div style={{ color: C.text2, fontSize: 11, lineHeight: 1.45, marginTop: 7 }}>{feature.description}</div>
      <PolicyLine feature={feature} />
      <ActionTags actions={feature.actions} />
      <div style={{ display: 'flex', gap: 6, marginTop: 'auto', paddingTop: 12 }}>
        <button type="button" onClick={() => onOpen({ kind: 'feature', id: feature.id })} style={{ flex: 1, border: `1px solid ${C.blueBorder}`, background: C.surface, color: C.blue, borderRadius: 8, padding: '7px 9px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 10.5, fontWeight: 800 }}>
          Mở màn hình
        </button>
        <button type="button" disabled={busy || feature.protected} onClick={() => onToggle(feature)} title={feature.protected ? 'Chốt an toàn bắt buộc, không thể tắt.' : ''} style={{ border: `1px solid ${feature.protected ? C.border : (enabled ? C.amberBorder : C.greenBorder)}`, background: feature.protected ? C.surface2 : C.surface, color: feature.protected ? C.text3 : (enabled ? C.amber : C.green), borderRadius: 8, padding: '7px 9px', cursor: feature.protected ? 'not-allowed' : 'pointer', fontFamily: 'inherit', fontSize: 10.5, fontWeight: 800 }}>
          {feature.protected ? 'Bắt buộc' : (enabled ? 'Tắt' : 'Bật')}
        </button>
      </div>
    </div>
  );
}

function StepStatus({ status }) {
  const map = {
    ready: [C.greenBg, C.greenBorder, C.green, 'Sẵn sàng'],
    'needs-input': [C.amberBg, C.amberBorder, C.amber, 'Cần dữ liệu'],
    blocked: [C.redBg, C.redBorder, C.red, 'Bị chặn'],
    skipped: [C.surface2, C.border, C.text3, 'Bỏ qua'],
  };
  const [bg, border, color, label] = map[status] || [C.surface2, C.border, C.text3, status || 'Chưa kiểm'];
  return <span style={{ marginLeft: 'auto', border: `1px solid ${border}`, background: bg, color, borderRadius: 999, padding: '2px 6px', fontSize: 9, fontWeight: 750 }}>{label}</span>;
}

function WorkflowCard({ workflow, features, onOpen, onPlan, onToggle, plan, busy }) {
  const enabled = workflow.enabled !== false;
  return (
    <div style={{ border: `1px solid ${enabled ? C.border2 : C.amberBorder}`, background: enabled ? C.surface : C.amberBg, borderRadius: 6, padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span style={{ width: 24, height: 24, borderRadius: 4, background: 'transparent', border: 'none', color: enabled ? C.blue : C.amber, display: 'grid', placeItems: 'center', fontWeight: 800 }}>{workflow.icon || '◇'}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: C.text, fontSize: 13, fontWeight: 850 }}>{workflow.label}</div>
          <div style={{ color: C.text2, fontSize: 11, lineHeight: 1.5, marginTop: 4 }}>{workflow.description}</div>
        </div>
        <span style={{ fontSize: 9, fontWeight: 800, color: enabled ? C.green : C.amber }}>{enabled ? 'BẬT' : 'TẮT'}</span>
      </div>
      <div style={{ display: 'grid', gap: 5, marginTop: 11 }}>
        {(workflow.steps || []).map((step, index) => {
          const feature = getFeatureDefinition(step.feature, features);
          const planned = plan?.steps?.find(item => item.id === step.id);
          return (
            <div key={step.id} style={{ display: 'flex', alignItems: 'center', gap: 7, color: C.text2, fontSize: 10 }}>
              <span style={{ width: 18, height: 18, borderRadius: 999, display: 'grid', placeItems: 'center', background: C.surface, border: `1px solid ${C.border}`, color: C.blue, fontWeight: 800 }}>{index + 1}</span>
              <span>{step.label || feature?.label || step.id}</span>
              {step.optional ? <span style={{ color: C.text3 }}>(tùy chọn)</span> : null}
              {planned ? <StepStatus status={planned.status} /> : null}
            </div>
          );
        })}
      </div>
      {plan?.summary ? (
        <div style={{ marginTop: 10, padding: 8, borderRadius: 8, background: C.surface, border: `1px solid ${C.border}`, color: C.text2, fontSize: 10 }}>
          Sẵn sàng {plan.summary.ready} · Cần dữ liệu {plan.summary.needs_input} · Bị chặn {plan.summary.blocked} · Bỏ qua {plan.summary.skipped}
        </div>
      ) : null}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 12 }}>
        <button type="button" onClick={() => onPlan(workflow)} disabled={!enabled || busy} style={{ border: `1px solid ${C.blueBorder}`, background: C.surface, color: C.blue, borderRadius: 9, padding: '8px 10px', cursor: !enabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit', fontSize: 10.5, fontWeight: 800 }}>
          Kiểm tra phụ thuộc
        </button>
        <button type="button" onClick={() => onOpen({ kind: 'workflow', id: workflow.id })} style={{ border: `1px solid ${C.blue}`, background: C.blue, color: '#fff', borderRadius: 9, padding: '8px 10px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 10.5, fontWeight: 800 }}>
          Mở quy trình
        </button>
      </div>
      <button type="button" onClick={() => onToggle(workflow)} disabled={busy} style={{ marginTop: 6, width: '100%', border: `1px solid ${enabled ? C.amberBorder : C.greenBorder}`, background: C.surface, color: enabled ? C.amber : C.green, borderRadius: 8, padding: '6px 9px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 10, fontWeight: 750 }}>
        {enabled ? 'Tắt toàn bộ quy trình' : 'Bật lại quy trình'}
      </button>
    </div>
  );
}

export default function FunctionHubTab({ onOpenContext, toast }) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState('functions');
  const [busyId, setBusyId] = useState('');
  const [plans, setPlans] = useState({});
  const [artifactCount, setArtifactCount] = useState(0);
  const { registry, loading, error, refresh } = useRuntimeRegistry();
  const features = registry.functions || [];
  const workflows = registry.workflows || [];

  useEffect(() => {
    api.getArtifacts().then(result => setArtifactCount(result?.artifacts?.length || 0)).catch(() => {});
  }, []);

  const groups = useMemo(() => {
    const q = normalize(query);
    return getFeatureGroups(features).map(group => ({
      ...group,
      features: group.features.filter(feature => !q || normalize(`${feature.label} ${feature.description} ${feature.id} ${feature.group}`).includes(q)),
    })).filter(group => group.features.length);
  }, [query, features]);
  const workflowMatches = useMemo(() => {
    const q = normalize(query);
    return workflows.filter(workflow => !q || normalize(`${workflow.label} ${workflow.description} ${(workflow.steps || []).map(step => step.feature).join(' ')}`).includes(q));
  }, [query, workflows]);

  const toggleFeature = async (feature) => {
    setBusyId(feature.id);
    try {
      await api.updateFeatureState(feature.id, { enabled: feature.enabled === false });
      invalidateRuntimeRegistry();
      await refresh(true);
      toast?.(`${feature.label}: ${feature.enabled === false ? 'đã bật' : 'đã tắt'}.`, 'ok');
    } catch (err) { toast?.(String(err.message || err), 'error'); }
    finally { setBusyId(''); }
  };

  const toggleWorkflow = async (workflow) => {
    setBusyId(workflow.id);
    try {
      await api.updateWorkflowState(workflow.id, { enabled: workflow.enabled === false });
      invalidateRuntimeRegistry();
      await refresh(true);
      toast?.(`${workflow.label}: ${workflow.enabled === false ? 'đã bật' : 'đã tắt'}.`, 'ok');
    } catch (err) { toast?.(String(err.message || err), 'error'); }
    finally { setBusyId(''); }
  };

  const planWorkflow = async (workflow) => {
    setBusyId(workflow.id);
    try {
      const result = await api.planWorkflow(workflow.id, {});
      setPlans(prev => ({ ...prev, [workflow.id]: result }));
      toast?.('Đã kiểm tra phụ thuộc. Bước cần payload sẽ được đánh dấu “Cần dữ liệu”.', 'ok');
    } catch (err) { toast?.(String(err.message || err), 'error'); }
    finally { setBusyId(''); }
  };

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <section style={{ background: C.surface, borderBottom: `1px solid ${C.border2}`, padding: '4px 0 12px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ color: C.text, fontSize: 17, fontWeight: 850, letterSpacing: '-0.025em' }}>Bộ điều phối module EMR</div>
            <div style={{ color: C.text2, fontSize: 12, lineHeight: 1.6, marginTop: 5 }}>
              Quản lý module, phụ thuộc và quy trình thực thi.
            </div>
            {error ? <div style={{ color: C.red, fontSize: 11, marginTop: 5 }}>Không tải được trạng thái runtime: {error}</div> : null}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ border: 'none', borderRadius: 0, padding: '5px 0 5px 10px', background: 'transparent', color: C.text2, fontSize: 10.5 }}><b style={{ color: C.text }}>{features.length}</b> module</span>
            <span style={{ border: 'none', borderRadius: 0, padding: '5px 0 5px 10px', background: 'transparent', color: C.text2, fontSize: 10.5 }}><b style={{ color: C.text }}>{workflows.length}</b> quy trình</span>
            <span style={{ border: 'none', borderRadius: 0, padding: '5px 0 5px 10px', background: 'transparent', color: C.text2, fontSize: 10.5 }}><b style={{ color: C.text }}>{artifactCount}</b> đầu ra đã ghi nhận</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 260, display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${C.border}`, background: C.surface2, borderRadius: 5, padding: '0 9px' }}>
            <span style={{ color: C.text3 }}>⌕</span>
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Tìm module hoặc quy trình..." style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', height: 34, color: C.text, fontFamily: 'inherit', fontSize: 12 }} />
            {query && <button type="button" onClick={() => setQuery('')} style={{ border: 'none', background: 'transparent', color: C.text3, cursor: 'pointer' }}>×</button>}
          </div>
          <div style={{ display: 'flex', borderBottom: `1px solid ${C.border}`, borderRadius: 0, padding: 0, background: 'transparent' }}>
            {[["functions", 'Module'], ['workflows', 'Quy trình']].map(([id, label]) => (
              <button key={id} type="button" onClick={() => setMode(id)} style={{ border: 'none', borderRadius: 0, borderBottom: `2px solid ${mode === id ? C.blue : 'transparent'}`, padding: '7px 10px', background: 'transparent', color: mode === id ? C.text : C.text2, cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 750 }}>{label}</button>
            ))}
          </div>
        </div>
      </section>

      {loading && !features.length ? <div style={{ color: C.text3, padding: 20 }}>Đang tải registry...</div> : null}
      {mode === 'workflows' ? (
        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 9 }}>
          {workflowMatches.map(workflow => <WorkflowCard key={workflow.id} workflow={workflow} features={features} onOpen={onOpenContext} onPlan={planWorkflow} onToggle={toggleWorkflow} plan={plans[workflow.id]} busy={busyId === workflow.id} />)}
          {!workflowMatches.length && <div style={{ color: C.text3, padding: 20 }}>Không tìm thấy quy trình phù hợp.</div>}
        </section>
      ) : (
        <div style={{ display: 'grid', gap: 18 }}>
          {groups.map(group => (
            <section key={group.name}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9 }}>
                <div style={{ color: C.text, fontSize: 12, fontWeight: 850 }}>{group.name}</div>
                <div style={{ height: 1, background: C.border2, flex: 1 }} />
                <div style={{ color: C.text3, fontSize: 10 }}>{group.features.length}</div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(270px, 1fr))', gap: 8 }}>
                {group.features.map(feature => <FunctionCard key={feature.id} feature={feature} onOpen={onOpenContext} onToggle={toggleFeature} busy={busyId === feature.id} />)}
              </div>
            </section>
          ))}
          {!groups.length && <div style={{ color: C.text3, padding: 20 }}>Không tìm thấy module phù hợp.</div>}
        </div>
      )}
    </div>
  );
}
