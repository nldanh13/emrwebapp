// Chế độ "Sơ đồ" của tab Thiết kế luồng: đọc luồng như một cây.
// Màn hình → các ô nhập trên đó → từng nút/ô chức năng bấm được → màn hình mở ra → các nút của nó…
// Màn hình đã bung ở nhánh khác thì ghi "đã có ở nhánh khác" và bấm vào để nhảy tới.
import { useMemo, useState } from 'react';
import { C, FS, FW, R, SP } from '../../tokens.js';
import { Btn } from '../shared.jsx';
import { ELEMENT_TYPES, buildFlowTree, screenSteps } from './flowModel.js';

const nodeDomId = id => `flow-tree-${id}`;

// Màn hình thuộc nhóm "Trên EMR" là thao tác máy làm trên trang EMR: luôn hiện các bước,
// mỗi bước ghi rõ chỉ đọc hay có ghi lên EMR.
export const EMR_GROUP = 'Trên EMR';
const isEmrScreen = screen => screen.group === EMR_GROUP;

function Chip({ bg, border, color, children }) {
  return (
    <span style={{ padding: '0 6px', borderRadius: R.sm, fontSize: FS.xs, fontWeight: FW.semibold, background: bg, border: `1px solid ${border}`, color, whiteSpace: 'nowrap' }}>{children}</span>
  );
}

function StepLine({ text }) {
  const m = /^\((GHI|đọc)\)\s*/i.exec(text);
  const body = (m ? text.slice(m[0].length) : text).replace(/^\d+\.\s*/, '');
  if (!m) return <li>{body}</li>;
  const write = m[1].toUpperCase() === 'GHI';
  return (
    <li>
      {write
        ? <Chip bg={C.redBg} border={C.redBorder} color={C.red}>Ghi EMR</Chip>
        : <Chip bg={C.surface2} border={C.border} color={C.text2}>Chỉ đọc</Chip>}
      {' '}{body}
    </li>
  );
}

function jumpTo(id) {
  const el = typeof document !== 'undefined' ? document.getElementById(nodeDomId(id)) : null;
  if (!el) return;
  for (let p = el.parentElement; p; p = p.parentElement) if (p.tagName === 'DETAILS') p.open = true;
  el.open = true;
  el.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
}

function ScreenNode({ node, openDepth, onEdit, showSteps }) {
  const { screen, fields, actions, depth } = node;
  const steps = screenSteps(screen);
  const emr = isEmrScreen(screen);
  const writes = emr && steps.some(t => /^\(GHI\)/i.test(t));
  return (
    <details id={nodeDomId(screen.id)} open={depth < openDepth} style={{ display: 'grid' }}>
      <summary style={{ cursor: 'pointer', padding: '4px 0', listStylePosition: 'outside' }}>
        {emr && <><Chip bg={C.amberBg} border={C.amberBorder} color={C.amber}>Trên EMR</Chip>{' '}</>}
        <span style={{ fontSize: depth === 0 ? FS.lg : FS.md, fontWeight: FW.bold, color: C.text }}>{screen.name}</span>
        {emr && <> <Chip bg={writes ? C.redBg : C.surface2} border={writes ? C.redBorder : C.border} color={writes ? C.red : C.text2}>{writes ? 'Có ghi EMR' : 'Chỉ đọc'}</Chip></>}
        <span style={{ fontSize: FS.xs, color: C.text3 }}> · {actions.length} nút bấm được{steps.length ? ` · ${steps.length} bước` : ''}</span>
        <button type="button" onClick={(e) => { e.preventDefault(); onEdit(screen.id); }} style={{
          marginLeft: SP[2], border: 0, background: 'transparent', color: C.blue, fontSize: FS.xs, cursor: 'pointer', padding: 0,
        }}>Sửa</button>
      </summary>
      <div style={{ marginLeft: 6, paddingLeft: SP[3], borderLeft: `2px solid ${C.border}`, display: 'grid', gap: SP[1], paddingBottom: SP[1] }}>
        {(showSteps || emr) && steps.length > 0 && (
          <ol aria-label={emr ? 'Thao tác máy làm trên EMR' : undefined} style={{ margin: 0, paddingLeft: 18, fontSize: FS.xs, color: C.text2, display: 'grid', gap: 2 }}>
            {steps.map((t, i) => <StepLine key={i} text={t} />)}
          </ol>
        )}
        {fields.length > 0 && (
          <div style={{ fontSize: FS.xs, color: C.text2 }}>
            Trên màn hình: {fields.map(f => `${ELEMENT_TYPES[f.type].label.toLowerCase()} "${f.label}"`).join(', ')}
          </div>
        )}
        {actions.length === 0 && <div style={{ fontSize: FS.xs, color: C.text3 }}>Không có nút nào bấm được.</div>}
        {actions.map(({ element, target, child }) => (
          <div key={element.id} style={{ display: 'grid', gap: 2 }}>
            <div style={{ display: 'flex', gap: SP[1], alignItems: 'baseline', flexWrap: 'wrap', fontSize: FS.sm }}>
              <span aria-hidden="true" style={{ color: C.text3 }}>▸</span>
              <span style={{
                padding: '1px 8px', borderRadius: R.sm, fontWeight: FW.semibold,
                background: element.type === 'tile' ? C.blueBg : C.surface2, border: `1px solid ${element.type === 'tile' ? C.blueBorder : C.border}`, color: C.text,
              }}>{element.label}</span>
              {target ? (
                child ? <span style={{ color: C.text2 }}>→ mở <b>{target.name}</b></span> : (
                  <button type="button" onClick={() => jumpTo(target.id)} style={{ border: 0, background: 'transparent', padding: 0, cursor: 'pointer', color: C.blue, fontSize: FS.sm }}>
                    → {target.name} (đã có ở nhánh khác)
                  </button>
                )
              ) : <span style={{ color: C.text3 }}>(làm tại chỗ, không mở màn hình khác)</span>}
              {element.hint && <span style={{ color: C.text3, fontSize: FS.xs }}>— {element.hint}</span>}
            </div>
            {child && (
              <div style={{ marginLeft: SP[3] }}>
                <ScreenNode node={child} openDepth={openDepth} onEdit={onEdit} showSteps={showSteps} />
              </div>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

export default function FlowTreeView({ flow, onEdit }) {
  const tree = useMemo(() => buildFlowTree(flow), [flow]);
  const [openDepth, setOpenDepth] = useState(2);
  const [showSteps, setShowSteps] = useState(false);
  const [version, setVersion] = useState(0); // đổi key để áp lại mở/thu gọn cho mọi nhánh
  const setDepth = (d) => { setOpenDepth(d); setVersion(v => v + 1); };
  if (!tree) return <div style={{ color: C.text3, fontSize: FS.md }}>Luồng chưa có màn hình bắt đầu.</div>;
  return (
    <section aria-label="Sơ đồ luồng" style={{ border: `1px solid ${C.border}`, borderRadius: R.lg, background: C.surface, padding: SP[3], display: 'grid', gap: SP[2] }}>
      <div style={{ display: 'flex', gap: SP[1], alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200, fontSize: FS.sm, color: C.text2 }}>
          Đọc từ trên xuống: mỗi màn hình bung ra các nút bấm được, mỗi nút dẫn tới màn hình kế tiếp. Bấm tên màn hình để mở/thu gọn.
          Ô có nhãn "Trên EMR" là các bước máy làm trên trang EMR, ghi rõ bước nào chỉ đọc, bước nào ghi lên EMR.
        </div>
        <Btn onClick={() => setDepth(99)}>Mở hết</Btn>
        <Btn onClick={() => setDepth(1)}>Thu gọn</Btn>
        <Btn onClick={() => setShowSteps(v => !v)} aria-pressed={showSteps}>{showSteps ? 'Ẩn các bước' : 'Hiện các bước'}</Btn>
      </div>
      <ScreenNode key={version} node={tree} openDepth={openDepth} onEdit={onEdit} showSteps={showSteps} />
    </section>
  );
}
