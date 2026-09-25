import { IconFolderOpen, IconRefresh } from '@tabler/icons-react';
import { C, FS } from '../../tokens.js';
import { Btn } from '../shared.jsx';

// Thanh chuyển bước khi Xếp phòng và Nhập liệu nằm chung một màn hình.
export default function ShiftToolbar({ subTab, isMobile, setSubTab, onShowPicker }) {
  const tabs = [
    { id: 'board', label: isMobile ? 'Xếp phòng' : 'Bước 1 · Xếp phòng & lấy y lệnh' },
    { id: 'patients', label: isMobile ? 'Nhập liệu' : 'Bước 2 · Người bệnh & nhập liệu' },
  ];
  return (
    <div role="tablist" aria-label="Các bước" style={{
      display: 'flex', borderBottom: `1px solid ${C.border}`,
      background: C.surface, padding: '0 12px', gap: 4,
      alignItems: 'center', flexShrink: 0, minHeight: 44,
    }}>
      {tabs.map(t => {
        const active = subTab === t.id;
        return (
          <button type="button" role="tab" aria-selected={active} key={t.id} onClick={() => setSubTab(t.id)} style={{
            height: 44, padding: '0 10px', border: 'none', background: 'none',
            cursor: 'pointer', fontSize: FS.sm, fontWeight: active ? 650 : 550, fontFamily: 'inherit',
            color: active ? C.blue : C.text2,
            boxShadow: active ? `inset 0 -2px 0 ${C.blue}` : 'none',
            whiteSpace: 'nowrap',
          }}>{t.label}</button>
        );
      })}

      <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
        {subTab === 'patients' && (
          <Btn icon={IconRefresh} onClick={() => setSubTab('board')} aria-label="Quét lại" title="Quét lại">
            {!isMobile && 'Quét lại'}
          </Btn>
        )}
        <Btn icon={IconFolderOpen} onClick={onShowPicker} aria-label="Đổi dữ liệu" title="Đổi dữ liệu">
          {!isMobile && 'Đổi dữ liệu'}
        </Btn>
      </div>
    </div>
  );
}
