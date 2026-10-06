// Mục "Sẵn có" của Danh mục thuốc: kiến thức thuốc cài sẵn (config/medication_builtin.json).
// Chỉ xem; muốn đổi thì "Chép vào danh mục" → thuốc trong danh mục luôn được ưu tiên hơn.
import { C, FS } from '../tokens.js';
import { Btn } from './shared.jsx';
import { builtinSections } from '../utils/medicationBuiltin.js';
import { SkeletonLines } from './Skeleton.jsx';

export default function MedicationBuiltinPanel({ builtin, error, catalogNames = new Set(), onCopy }) {
  if (error) {
    return <div role="alert" style={{ padding: 14, color: C.red, fontSize: FS.sm }}>{error}</div>;
  }
  if (!builtin) {
    return <div role="status" aria-busy="true" aria-label="Đang tải kiến thức sẵn có" style={{ padding: 14 }}><SkeletonLines lines={6} /></div>;
  }
  const sections = builtinSections(builtin);
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ padding: '9px 12px', borderRadius: 7, background: C.blueBg, border: `1px solid ${C.blueBorder}`,
        fontSize: FS.sm, color: C.text2, lineHeight: 1.5 }}>
        <b>Kiến thức sẵn có</b> đi kèm phần mềm (cập nhật theo phiên bản, không sửa trực tiếp được). Bước xử lý dữ liệu dùng
        các mục này khi thuốc <b>chưa có</b> trong Danh mục. Muốn đổi: bấm <b>Chép vào danh mục</b>, sửa rồi lưu — từ đó thuốc
        trong danh mục được ưu tiên.
      </div>
      {sections.map(section => (
        <section key={section.id} style={{ border: `1px solid ${C.border2}`, borderRadius: 7, background: C.surface }}>
          <div style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border2}` }}>
            <div style={{ fontSize: FS.md, fontWeight: 600, color: C.text }}>{section.title} ({section.rows.length})</div>
            {section.desc && <div style={{ fontSize: FS.xs, color: C.text3, marginTop: 2, lineHeight: 1.45 }}>{section.desc}</div>}
          </div>
          <div>
            {section.rows.map((row, i) => {
              const inCatalog = catalogNames.has(String(row.prefill.canonical || '').toLowerCase());
              return (
                <div key={`${row.label}-${i}`} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
                  padding: '7px 12px', borderTop: i ? `1px solid ${C.border2}` : 'none' }}>
                  <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                    <div style={{ fontSize: FS.sm, fontWeight: 600, color: C.text }}>{row.label}</div>
                    <div style={{ fontSize: FS.xs, color: C.text2 }}>{row.detail}</div>
                  </div>
                  <Btn variant="secondary" onClick={() => onCopy?.(row.prefill)} style={{ fontSize: FS.xs, padding: '2px 10px' }}
                    title={inCatalog ? 'Thuốc đã có trong danh mục: mở để bổ sung các ô còn trống' : ''}>
                    {inCatalog ? 'Bổ sung vào thuốc đã có' : 'Chép vào danh mục'}
                  </Btn>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
