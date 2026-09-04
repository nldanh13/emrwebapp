import { C } from '../../tokens.js';
import { Btn } from '../shared.jsx';

export default function ShiftToolbar({ subTab, isMobile, setSubTab, onShowPicker }) {
  return (
    <div style={{
      display: 'flex', borderBottom: `1px solid ${C.border}`,
      background: C.surface, padding: '0 10px', gap: 2,
      alignItems: 'center', flexShrink: 0, minHeight: 40,
    }}>
      {[
        { id: 'board', label: isMobile ? '① Xếp phòng' : '① Xếp phòng & lấy y lệnh' },
        { id: 'patients', label: isMobile ? '② Nhập liệu' : '② Bệnh nhân & nhập liệu' },
      ].map(t => (
        <button type="button" key={t.id} onClick={() => setSubTab(t.id)} style={{
          padding: '6px 10px', border: 'none', background: 'none',
          cursor: 'pointer', fontSize: isMobile ? 12 : 11, fontFamily: 'inherit',
          color: subTab === t.id ? C.blue : C.text2,
          borderBottom: subTab === t.id ? `2px solid ${C.blue}` : '2px solid transparent',
          whiteSpace: 'nowrap',
        }}>{t.label}</button>
      ))}

      <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
        {subTab === 'patients' && (
          <Btn variant="default" onClick={() => setSubTab('board')}
            style={{ padding: '4px 10px', fontSize: 11 }}>
            ⟳{!isMobile && ' Quét lại'}
          </Btn>
        )}
        <Btn variant="default" onClick={onShowPicker}
          style={{ padding: '4px 10px', fontSize: 11, color: C.text3 }}>
          {isMobile ? '≡' : '📂 Đổi dữ liệu'}
        </Btn>
      </div>
    </div>
  );
}
