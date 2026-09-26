import { C, FS } from '../../tokens.js';
import { Chip } from './ReportShared.jsx';

function RouteFilterStrip({ options, selectedRoutes, onToggle, onClear }) {
  if (!options.length) return null;
  const selected = Array.isArray(selectedRoutes) ? selectedRoutes : [];
  const isAll = !selected.length;
  return (
    <div role="group" aria-label="Lọc theo đường dùng" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10, alignItems: 'center' }}>
      <span style={{ color: C.text2, fontSize: FS.sm, marginRight: 2 }}>Đường dùng</span>
      <Chip active={isAll} onClick={onClear} title="Hiện tất cả đường dùng đang có trong phiếu">Tất cả</Chip>
      {options.map(item => (
        <Chip
          key={item.route}
          active={selected.includes(item.route)}
          onClick={() => onToggle(item.route)}
          title={`Bấm để ${selected.includes(item.route) ? 'bỏ chọn' : 'chọn'} ${item.route}`}
        >
          {item.route} <span style={{ color: selected.includes(item.route) ? C.blue : C.text2, fontVariantNumeric: 'tabular-nums' }}>{item.count}</span>
        </Chip>
      ))}
    </div>
  );
}

export { RouteFilterStrip };
