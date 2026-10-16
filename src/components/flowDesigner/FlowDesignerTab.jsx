// Tab "Thiết kế luồng": vẽ luồng chức năng của web app bằng các màn hình và các ô.
// Ví dụ: Đăng nhập → Trang chính (các ô Danh sách phòng khám, Danh sách điều trị nội trú…)
// → bấm Danh sách điều trị nội trú thì hiện ô nhập tên, nút Tìm kiếm, bảng kết quả.
//  - Thiết kế: thêm/sửa màn hình và ô, nối Nút/Ô chức năng tới màn hình kế tiếp.
//  - Chạy thử: bấm qua luồng như người dùng thật, có nút quay lại.
// Tự lưu trên trình duyệt này sau mỗi thay đổi (docs/UX_RULES.md mục 2.1); Xuất/Nhập tệp .json để
// chuyển sang máy khác. Tab không gọi máy chủ, không mở EMR.
import { useEffect, useMemo, useRef, useState } from 'react';
import { IconArrowDown, IconArrowLeft, IconArrowUp, IconDownload, IconPlus, IconTrash, IconUpload } from '@tabler/icons-react';
import { C, FS, FW, R, SP } from '../../tokens.js';
import { Btn, Segmented } from '../shared.jsx';
import FlowScreenView, { INPUT_STYLE } from './FlowScreenView.jsx';
import {
  ELEMENT_TYPES, ELEMENT_TYPE_ORDER, addElement, addScreen, checkFlow, flowLinks, screenSteps,
  moveElement, removeElement, removeScreen, setStartScreen, updateElement, updateScreen,
} from './flowModel.js';
import { createFullAppFlow } from './appFlowSpec.js';
import { loadStoredFlow, parseFlowFile, saveStoredFlow } from './flowStorage.js';
import { useUnsavedChangesGuard } from '../../hooks/useTabActivity.js';

const AUTOSAVE_MS = 800;
const panel = { border: `1px solid ${C.border}`, borderRadius: R.lg, background: C.surface, padding: SP[3], display: 'grid', gap: SP[2], alignContent: 'start' };
const fieldLabel = { display: 'grid', gap: 3, fontSize: FS.xs, color: C.text2 };

// Các bước của màn hình: máy làm gì và người dùng thao tác gì, đánh số theo thứ tự.
function StepList({ screen }) {
  const steps = screenSteps(screen);
  return (
    <aside aria-label="Các bước ở màn hình này" style={{ ...panel, background: C.surface2 }}>
      <div style={{ fontSize: FS.sm, fontWeight: FW.semibold, color: C.text }}>Các bước ở màn hình này</div>
      {steps.length ? (
        <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: SP[1], fontSize: FS.sm, color: C.text, lineHeight: 1.45 }}>
          {steps.map((step, i) => <li key={i}>{step.replace(/^\d+\.\s*/, '')}</li>)}
        </ol>
      ) : (
        <div style={{ fontSize: FS.sm, color: C.text3 }}>Chưa ghi bước nào. Ghi ở phần Thiết kế, mỗi dòng một bước.</div>
      )}
    </aside>
  );
}

// Danh sách màn hình xếp theo nhóm (thứ tự nhóm theo lần xuất hiện đầu tiên).
function groupScreens(screens) {
  const groups = [];
  for (const s of screens) {
    let g = groups.find(x => x.name === s.group);
    if (!g) { g = { name: s.group, screens: [] }; groups.push(g); }
    g.screens.push(s);
  }
  return groups;
}

const hhmm = d => d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });

function ElementEditor({ el, screens, onChange, onMove, onRemove }) {
  const type = ELEMENT_TYPES[el.type];
  const hasOptions = el.type === 'select' || el.type === 'list';
  return (
    <div style={{ ...panel, background: C.surface2 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: SP[1] }}>
        <div style={{ flex: 1, fontSize: FS.sm, fontWeight: FW.semibold, color: C.text }}>Sửa ô: {type.label}</div>
        <Btn icon={IconArrowUp} aria-label="Đưa ô lên" title="Đưa ô lên" onClick={() => onMove(-1)} />
        <Btn icon={IconArrowDown} aria-label="Đưa ô xuống" title="Đưa ô xuống" onClick={() => onMove(1)} />
        <Btn icon={IconTrash} aria-label="Xóa ô" title="Xóa ô" onClick={onRemove} />
      </div>
      <label style={fieldLabel}>Kiểu ô
        <select style={INPUT_STYLE} value={el.type} onChange={e => onChange({ type: e.target.value })}>
          {ELEMENT_TYPE_ORDER.map(t => <option key={t} value={t}>{ELEMENT_TYPES[t].label}</option>)}
        </select>
      </label>
      <label style={fieldLabel}>Chữ hiện trên ô
        <input style={INPUT_STYLE} value={el.label} onChange={e => onChange({ label: e.target.value })} />
      </label>
      <label style={fieldLabel}>{el.type === 'input' ? 'Chữ gợi ý trong ô' : 'Mô tả ngắn'}
        <input style={INPUT_STYLE} value={el.hint} onChange={e => onChange({ hint: e.target.value })} />
      </label>
      {hasOptions && (
        <label style={fieldLabel}>{el.type === 'list' ? 'Các cột (mỗi dòng một cột)' : 'Các lựa chọn (mỗi dòng một lựa chọn)'}
          <textarea rows={3} style={{ ...INPUT_STYLE, resize: 'vertical' }} defaultValue={el.options.join('\n')} key={el.id + el.type}
            onBlur={e => onChange({ options: e.target.value.split('\n') })} />
        </label>
      )}
      {type.linkable && (
        <label style={fieldLabel}>Bấm vào thì mở
          <select style={INPUT_STYLE} value={el.target} onChange={e => onChange({ target: e.target.value })}>
            <option value="">(không mở màn hình nào)</option>
            {screens.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}

export default function FlowDesignerTab({ toast }) {
  const [flow, setFlow] = useState(() => loadStoredFlow() || createFullAppFlow());
  const [screenId, setScreenId] = useState(() => flow.startId);
  const [elementId, setElementId] = useState('');
  const [mode, setMode] = useState('design');
  const [history, setHistory] = useState([]); // màn hình đã đi qua khi Chạy thử
  const [saveState, setSaveState] = useState({ dirty: false, at: null, failed: false });
  const fileRef = useRef(null);
  const firstRender = useRef(true);

  // Tự lưu sau thay đổi cuối; lưu lỗi thì báo rõ để người dùng Xuất tệp giữ lại.
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return undefined; }
    setSaveState(s => ({ ...s, dirty: true }));
    const timer = setTimeout(() => {
      const ok = saveStoredFlow(flow);
      setSaveState({ dirty: false, at: ok ? new Date() : null, failed: !ok });
    }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [flow]);

  // Rời trang (đăng xuất, đóng tab) khi còn thay đổi chờ lưu: lưu ngay, không bỏ thao tác.
  const latest = useRef({ flow, dirty: false });
  latest.current = { flow, dirty: saveState.dirty };
  useEffect(() => () => { if (latest.current.dirty) saveStoredFlow(latest.current.flow); }, []);
  useUnsavedChangesGuard(saveState.dirty);

  // Màn hình/ô đang chọn bị xóa thì chọn lại cái còn tồn tại.
  const screen = flow.screens.find(s => s.id === screenId) || flow.screens[0];
  const element = screen.elements.find(el => el.id === elementId) || null;
  const screenName = id => flow.screens.find(s => s.id === id)?.name || '(màn hình đã xóa)';
  const problems = useMemo(() => checkFlow(flow), [flow]);
  const links = useMemo(() => flowLinks(flow), [flow]);

  const pickScreen = (id) => { setScreenId(id); setElementId(''); };
  const onAddScreen = () => { const r = addScreen(flow); setFlow(r.flow); pickScreen(r.screenId); };
  const onRemoveScreen = () => {
    if (flow.screens.length <= 1) { toast?.('Luồng phải còn ít nhất một màn hình.', 'warn'); return; }
    if (!window.confirm(`Xóa màn hình "${screen.name}"? Các ô đang nối tới màn hình này sẽ bị gỡ nối.`)) return;
    const next = removeScreen(flow, screen.id);
    setFlow(next); pickScreen(next.screens[0].id);
  };
  const onAddElement = (type) => { const r = addElement(flow, screen.id, type); setFlow(r.flow); setElementId(r.elementId); };

  const startRun = () => { setHistory([]); setScreenId(flow.startId); setMode('run'); };
  const runOpen = (id) => { if (!flow.screens.some(s => s.id === id)) return; setHistory(h => [...h, screen.id]); setScreenId(id); };
  const runBack = () => { if (!history.length) return; setScreenId(history[history.length - 1]); setHistory(history.slice(0, -1)); };

  const onLoadFull = () => {
    if (!window.confirm('Nạp luồng đầy đủ các chức năng Data Hub? Luồng đang thiết kế sẽ bị thay. Nên bấm "Xuất tệp" trước nếu cần giữ.')) return;
    const full = createFullAppFlow();
    setFlow(full); pickScreen(full.startId); setMode('design');
  };

  const onExport = () => {
    const blob = new Blob([JSON.stringify(flow, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'thiet-ke-luong.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const onImport = async (file) => {
    if (!file) return;
    const { flow: imported, error } = parseFlowFile(await file.text());
    if (error) { toast?.(error, 'error'); return; }
    if (!window.confirm('Thay luồng đang thiết kế bằng luồng trong tệp? Nên Xuất tệp luồng hiện tại trước nếu cần giữ.')) return;
    setFlow(imported); pickScreen(imported.startId); setMode('design');
    toast?.('Đã nhập luồng từ tệp.', 'ok');
  };

  const saveText = saveState.failed
    ? 'Không tự lưu được trên trình duyệt này. Bấm "Xuất tệp" để giữ lại bản thiết kế.'
    : saveState.dirty ? 'Có thay đổi, đang chờ tự lưu…' : saveState.at ? `Đã tự lưu lúc ${hhmm(saveState.at)}` : 'Tự lưu trên trình duyệt này';

  return (
    <div style={{ padding: SP[4], display: 'grid', gap: SP[3], alignContent: 'start' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: SP[2], flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <input aria-label="Tên luồng" value={flow.name} onChange={e => setFlow(f => ({ ...f, name: e.target.value }))}
            style={{ ...INPUT_STYLE, border: '1px solid transparent', padding: '2px 4px', fontSize: FS.xl, fontWeight: FW.bold, background: 'transparent' }} />
          <div role="status" style={{ fontSize: FS.xs, color: saveState.failed ? C.red : C.text3, paddingLeft: 4 }}>{saveText}</div>
        </div>
        <Segmented label="Chế độ" value={mode} onChange={v => (v === 'run' ? startRun() : setMode('design'))}
          options={[{ value: 'design', label: 'Thiết kế' }, { value: 'run', label: 'Chạy thử' }]} />
        <Btn onClick={onLoadFull}>Nạp luồng đầy đủ</Btn>
        <Btn icon={IconDownload} onClick={onExport}>Xuất tệp</Btn>
        <Btn icon={IconUpload} onClick={() => fileRef.current?.click()}>Nhập tệp</Btn>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={e => { onImport(e.target.files?.[0]); e.target.value = ''; }} />
      </header>

      {mode === 'run' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: SP[3], alignItems: 'start' }}>
          <section aria-label="Chạy thử" style={{ ...panel, gridColumn: 'span 2', minWidth: 0, padding: SP[4] }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
              <Btn icon={IconArrowLeft} onClick={runBack} disabled={!history.length}>Quay lại</Btn>
              <div style={{ flex: 1, fontSize: FS.xs, color: C.text3 }}>{[...history, screen.id].map(screenName).join(' › ')}</div>
            </div>
            <h2 style={{ margin: 0, fontSize: FS.xl, fontWeight: FW.bold, color: C.text }}>{screen.name}</h2>
            <FlowScreenView screen={screen} screenName={screenName} onOpen={runOpen} />
          </section>
          <StepList screen={screen} />
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: SP[3], alignItems: 'start' }}>
          <section aria-label="Các màn hình" style={panel}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <h2 style={{ margin: 0, flex: 1, fontSize: FS.lg, fontWeight: FW.bold, color: C.text }}>Màn hình</h2>
              <Btn icon={IconPlus} onClick={onAddScreen}>Thêm</Btn>
            </div>
            {groupScreens(flow.screens).map(g => (
            <div key={g.name || '_'} role="group" aria-label={g.name || 'Màn hình'} style={{ display: 'grid', gap: 2 }}>
            {g.name && <div style={{ fontSize: FS.xs, fontWeight: FW.semibold, color: C.text3, textTransform: 'uppercase', paddingTop: SP[1] }}>{g.name}</div>}
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 }}>
              {g.screens.map(s => (
                <li key={s.id}>
                  <button type="button" onClick={() => pickScreen(s.id)} aria-current={s.id === screen.id} style={{
                    width: '100%', textAlign: 'left', padding: '6px 8px', borderRadius: R.sm, cursor: 'pointer', fontSize: FS.md,
                    border: 0, background: s.id === screen.id ? C.blueBg : 'transparent', color: s.id === screen.id ? C.blue : C.text,
                    fontWeight: s.id === screen.id ? FW.semibold : FW.regular,
                  }}>
                    {s.name}{s.id === flow.startId && <span style={{ fontSize: FS.xs, color: C.text3 }}> · bắt đầu</span>}
                    <div style={{ fontSize: FS.xs, color: C.text3 }}>
                      {links.filter(l => l.from === s.id).map(l => `→ ${screenName(l.to)}`).join(', ') || 'Chưa nối đi đâu'}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
            </div>
            ))}
            {problems.length > 0 && (
              <div role="note" style={{ padding: SP[2], borderRadius: R.md, background: C.amberBg, border: `1px solid ${C.amberBorder}`, color: C.amber, fontSize: FS.xs, display: 'grid', gap: 2 }}>
                {problems.map(p => <div key={p}>{p}</div>)}
              </div>
            )}
          </section>

          <section aria-label="Màn hình đang sửa" style={{ ...panel, gridColumn: 'span 2', minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'end', gap: SP[2], flexWrap: 'wrap' }}>
              <label style={{ ...fieldLabel, flex: 1, minWidth: 180 }}>Tên màn hình
                <input style={INPUT_STYLE} value={screen.name} onChange={e => setFlow(f => updateScreen(f, screen.id, { name: e.target.value }))} />
              </label>
              <Btn onClick={() => setFlow(f => setStartScreen(f, screen.id))} disabled={screen.id === flow.startId}>Đặt làm màn hình bắt đầu</Btn>
              <Btn icon={IconTrash} onClick={onRemoveScreen}>Xóa màn hình</Btn>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 1fr) 3fr', gap: SP[2] }}>
              <label style={fieldLabel}>Nhóm
                <input style={INPUT_STYLE} value={screen.group} placeholder="vd. Điều dưỡng" onChange={e => setFlow(f => updateScreen(f, screen.id, { group: e.target.value }))} />
              </label>
              <label style={fieldLabel}>Các bước ở màn hình này (mỗi dòng một bước: máy làm gì, người dùng thao tác gì)
                <textarea rows={4} style={{ ...INPUT_STYLE, resize: 'vertical' }} value={screen.note}
                  onChange={e => setFlow(f => updateScreen(f, screen.id, { note: e.target.value }))} />
              </label>
            </div>
            <div style={{ display: 'flex', gap: SP[1], flexWrap: 'wrap' }}>
              {ELEMENT_TYPE_ORDER.map(t => <Btn key={t} icon={IconPlus} onClick={() => onAddElement(t)}>{ELEMENT_TYPES[t].label}</Btn>)}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: SP[3], alignItems: 'start' }}>
              <div style={{ border: `1px solid ${C.border2}`, borderRadius: R.lg, padding: SP[3], background: C.bg, minWidth: 0 }}>
                <FlowScreenView screen={screen} screenName={screenName} selectedId={element?.id} onSelect={setElementId} />
              </div>
              {element ? (
                <ElementEditor el={element} screens={flow.screens}
                  onChange={patch => setFlow(f => updateElement(f, screen.id, element.id, patch))}
                  onMove={d => setFlow(f => moveElement(f, screen.id, element.id, d))}
                  onRemove={() => { setFlow(f => removeElement(f, screen.id, element.id)); setElementId(''); }} />
              ) : (
                <div style={{ fontSize: FS.sm, color: C.text3, padding: SP[2] }}>Bấm vào một ô ở khung xem trước để sửa chữ, kiểu ô và màn hình mở ra khi bấm.</div>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
