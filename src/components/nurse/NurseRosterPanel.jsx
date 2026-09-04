import { C } from '../../tokens.js';
import { Btn, SectionLabel } from '../shared.jsx';

export default function NurseRosterPanel({
  isMobile = false,
  roster = [],
  newName = '',
  setNewName,
  onAddNurse,
  onRemoveNurse,
}) {
  return (
    <div style={isMobile ? { padding: '0 0 24px' } : {}}>
      <SectionLabel>Điều dưỡng</SectionLabel>
      <div style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border2}`, display: 'flex', gap: 6 }}>
        <input
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && onAddNurse()}
          placeholder="Tên điều dưỡng..."
          style={{ flex: 1, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4, padding: '6px 8px', color: C.text, fontSize: 13, fontFamily: 'inherit', outline: 'none' }}
        />
        <Btn variant="primary" onClick={onAddNurse}>+</Btn>
      </div>
      {roster.map(name => (
        <div key={name} style={{ padding: '10px 12px', borderBottom: `1px solid ${C.border2}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 13, color: C.text }}>{name}</span>
          <button type="button" onClick={() => onRemoveNurse(name)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.text3, fontSize: 16, padding: '0 4px', minWidth: 32, minHeight: 32 }}>✕</button>
        </div>
      ))}
      {roster.length === 0 && <div style={{ padding: 12, fontSize: 12, color: C.text3 }}>Chưa có điều dưỡng</div>}
    </div>
  );
}
