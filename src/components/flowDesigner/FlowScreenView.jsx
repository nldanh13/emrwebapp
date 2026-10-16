// Vẽ một màn hình của luồng giống giao diện thật. Dùng chung cho chế độ Chạy thử (bấm ô có nối thì
// mở màn hình kế) và khung xem trước bên phần Thiết kế (bấm ô thì chọn ô đó để sửa).
import { C, FS, FW, R, SP } from '../../tokens.js';

export const INPUT_STYLE = {
  width: '100%', padding: '6px 10px', borderRadius: R.sm, background: C.surface, border: `1px solid ${C.border}`,
  color: C.text, fontSize: FS.md, boxSizing: 'border-box', fontFamily: 'inherit',
};

function Selectable({ selected, onSelect, children, style }) {
  if (!onSelect) return <div style={style}>{children}</div>;
  return (
    <div onClick={onSelect} style={{
      ...style, cursor: 'pointer', borderRadius: R.md, outlineOffset: 2,
      outline: selected ? `2px solid ${C.blue}` : '1px dashed transparent',
    }}>{children}</div>
  );
}

export default function FlowScreenView({ screen, screenName, onOpen, selectedId, onSelect }) {
  if (!screen) return null;
  const pick = el => (onSelect ? () => onSelect(el.id) : undefined);
  const open = el => (!onSelect && el.target ? () => onOpen?.(el.target) : undefined);

  const renderEl = (el) => {
    switch (el.type) {
      case 'heading':
        return <div style={{ fontSize: FS.lg, fontWeight: FW.bold, color: C.text }}>{el.label}{el.hint && <div style={{ fontSize: FS.sm, fontWeight: FW.regular, color: C.text2 }}>{el.hint}</div>}</div>;
      case 'input':
        return (
          <label style={{ display: 'grid', gap: 3, fontSize: FS.sm, color: C.text2 }}>
            {el.label}
            <input style={INPUT_STYLE} placeholder={el.hint || ''} readOnly={Boolean(onSelect)} />
          </label>
        );
      case 'select':
        return (
          <label style={{ display: 'grid', gap: 3, fontSize: FS.sm, color: C.text2 }}>
            {el.label}
            <select style={INPUT_STYLE} disabled={Boolean(onSelect)}>{(el.options.length ? el.options : ['(chưa có lựa chọn)']).map(o => <option key={o}>{o}</option>)}</select>
          </label>
        );
      case 'button':
        return (
          <button type="button" onClick={open(el)} title={el.target ? `Mở "${screenName(el.target)}"` : 'Nút chưa nối màn hình nào'} style={{
            height: 32, padding: '0 14px', borderRadius: R.sm, fontSize: FS.sm, fontWeight: FW.semibold, cursor: 'pointer',
            border: `1px solid ${el.target ? C.blue : C.border}`, background: el.target ? C.blue : C.surface, color: el.target ? '#fff' : C.text,
          }}>{el.label}{onSelect && el.target ? ` → ${screenName(el.target)}` : ''}</button>
        );
      case 'tile':
        return (
          <button type="button" onClick={open(el)} style={{
            width: '100%', minHeight: 72, textAlign: 'left', padding: SP[3], borderRadius: R.lg, cursor: 'pointer',
            border: `1px solid ${el.target ? C.blueBorder : C.border}`, background: el.target ? C.blueBg : C.surface,
          }}>
            <div style={{ fontSize: FS.md, fontWeight: FW.bold, color: C.text }}>{el.label}</div>
            {el.hint && <div style={{ fontSize: FS.xs, color: C.text2, marginTop: 2 }}>{el.hint}</div>}
            {onSelect && <div style={{ fontSize: FS.xs, color: C.text3, marginTop: 4 }}>{el.target ? `→ ${screenName(el.target)}` : 'Chưa nối màn hình'}</div>}
          </button>
        );
      case 'list': {
        const cols = el.options.length ? el.options : ['Cột 1', 'Cột 2'];
        return (
          <div style={{ display: 'grid', gap: 4 }}>
            <div style={{ fontSize: FS.sm, fontWeight: FW.semibold, color: C.text2 }}>{el.label}</div>
            <div style={{ border: `1px solid ${C.border}`, borderRadius: R.md, overflow: 'hidden' }}>
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols.length}, 1fr)`, background: C.surface2, fontSize: FS.xs, fontWeight: FW.semibold, color: C.text2 }}>
                {cols.map(c => <div key={c} style={{ padding: '6px 8px' }}>{c}</div>)}
              </div>
              <div style={{ padding: '10px 8px', fontSize: FS.xs, color: C.text3 }}>Dữ liệu mẫu sẽ hiện ở đây.</div>
            </div>
          </div>
        );
      }
      default:
        return null;
    }
  };

  // Các ô chức năng đứng liền nhau được xếp thành lưới, các ô khác xếp dọc.
  const blocks = [];
  for (const el of screen.elements) {
    const last = blocks[blocks.length - 1];
    if (el.type === 'tile' && last?.grid) last.items.push(el);
    else blocks.push(el.type === 'tile' ? { grid: true, items: [el] } : { grid: false, items: [el] });
  }

  return (
    <div style={{ display: 'grid', gap: SP[3], alignContent: 'start' }}>
      {screen.elements.length === 0 && (
        <div style={{ padding: SP[4], textAlign: 'center', color: C.text3, fontSize: FS.md, border: `1px dashed ${C.border}`, borderRadius: R.lg }}>
          Màn hình chưa có ô nào{onSelect ? '. Thêm ô bằng các nút "+" phía trên.' : '.'}
        </div>
      )}
      {blocks.map(block => (block.grid ? (
        <div key={block.items[0].id} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: SP[2] }}>
          {block.items.map(el => <Selectable key={el.id} selected={selectedId === el.id} onSelect={pick(el)}>{renderEl(el)}</Selectable>)}
        </div>
      ) : (
        <Selectable key={block.items[0].id} selected={selectedId === block.items[0].id} onSelect={pick(block.items[0])}>{renderEl(block.items[0])}</Selectable>
      )))}
    </div>
  );
}
