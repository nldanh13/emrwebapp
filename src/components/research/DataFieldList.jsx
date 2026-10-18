// Danh sách mọi trường dữ liệu kho lấy được, theo nhóm (Dữ liệu tổng quát).
// Gói `catalog` do máy chủ dựng từ từ điển dữ liệu (server/research/field_catalog.js) và đi
// chung gói màn hình; khung này chỉ hiển thị, không tự gọi máy chủ (UX_RULES mục 9.2).
import { useDeferredValue, useState } from 'react';
import { C, FS, FONT_MONO } from '../../tokens.js';
import { compactNumber } from './researchFormat.js';
import { SkeletonBlock, SkeletonLines } from '../Skeleton.jsx';

const card = { border: `1px solid ${C.border2}`, borderRadius: 8, background: C.surface, padding: '12px 14px' };

const TYPE_LABEL = {
  string: 'chuỗi', text: 'văn bản', integer: 'số nguyên', decimal: 'số thập phân',
  date: 'ngày', datetime: 'ngày giờ', flag01: 'có/không (1/0)', enum: 'danh mục', json: 'JSON',
};

function foldText(value) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
}

function Tag({ children, tone }) {
  const s = tone === 'red' ? { c: C.red, bg: C.redBg, b: C.redBorder }
    : tone === 'amber' ? { c: C.amber, bg: C.amberBg, b: C.amberBorder }
      : { c: C.purple, bg: C.purpleBg, b: C.purpleBorder };
  return (
    <span style={{ display: 'inline-block', marginLeft: 6, padding: '0 6px', borderRadius: 4, border: `1px solid ${s.b}`, background: s.bg, color: s.c, fontSize: FS.xs, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}

// Hiển thị số dòng có giá trị: "1.234 / 1.660 · 74%", hoặc "Chưa có" khi bảng có file mà cột trống.
export function filledText(field, group) {
  if (field.filled == null || group.counted_rows == null) return '';
  if (!field.filled) return 'Chưa có';
  const base = Number(group.counted_rows || 0);
  const pct = base ? Math.round((field.filled / base) * 100) : 0;
  return `${compactNumber(field.filled)} / ${compactNumber(base)} · ${pct}%`;
}

function FieldRow({ field, group }) {
  const filled = filledText(field, group);
  const meaning = String(field.meaning || field.name).replace(/\.$/, '');
  return (
    <tr style={{ borderTop: `1px solid ${C.border2}` }}>
      <td style={{ padding: '5px 8px 5px 0', verticalAlign: 'top' }}>
        <span style={{ fontSize: FS.sm, color: C.text }}>{meaning}</span>
        {field.use === 'excluded' && <Tag tone="red">Che khi xuất</Tag>}
        {field.use === 'approval_required' && <Tag tone="amber">Cần đề cương duyệt</Tag>}
        {field.inferred && <Tag>Suy luận</Tag>}
        <div style={{ fontFamily: FONT_MONO, fontSize: FS.xs, color: C.text3 }}>{field.name}</div>
      </td>
      <td style={{ padding: '5px 8px', verticalAlign: 'top', fontSize: FS.xs, color: C.text2, whiteSpace: 'nowrap' }}>
        {TYPE_LABEL[field.type] || field.type}{field.unit ? ` · ${field.unit}` : ''}
      </td>
      <td style={{ padding: '5px 0 5px 8px', verticalAlign: 'top', fontSize: FS.xs, textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', color: field.filled ? C.text : C.text3 }}>
        {filled}
      </td>
    </tr>
  );
}

function FieldGroup({ group, fields, forceOpen }) {
  const withData = group.has_file ? fields.filter(f => f.filled > 0).length : null;
  return (
    <details open={forceOpen || undefined} style={{ borderTop: `1px solid ${C.border2}`, padding: '6px 0' }}>
      <summary style={{ cursor: 'pointer', display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', listStyle: 'revert' }}>
        <span style={{ fontSize: FS.md, fontWeight: 600, color: C.text }}>{group.label}</span>
        <span style={{ fontSize: FS.xs, color: C.text3 }}>
          {fields.length} trường
          {withData != null ? ` · ${withData} trường đã có dữ liệu` : ' · chưa có dữ liệu trong kho'}
          {group.rows != null ? ` · ${compactNumber(group.rows)} ${group.unit}` : ''}
        </span>
      </summary>
      <div style={{ margin: '4px 0 2px 16px' }}>
        {group.grain && <div style={{ fontSize: FS.xs, color: C.text3 }}>Mỗi dòng: {group.grain}</div>}
        {group.limited && (
          <div style={{ fontSize: FS.xs, color: C.amber }}>
            Bảng lớn: số có giá trị đếm trên {compactNumber(group.counted_rows)} dòng đầu.
          </div>
        )}
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 4 }}>
          <thead>
            <tr style={{ fontSize: FS.xs, color: C.text3, textAlign: 'left' }}>
              <th style={{ fontWeight: 600, padding: '2px 8px 2px 0' }}>Trường</th>
              <th style={{ fontWeight: 600, padding: '2px 8px' }}>Kiểu</th>
              <th style={{ fontWeight: 600, padding: '2px 0 2px 8px', textAlign: 'right' }}>Đã có giá trị</th>
            </tr>
          </thead>
          <tbody>{fields.map(f => <FieldRow key={f.name} field={f} group={group} />)}</tbody>
        </table>
        {group.dynamic_columns && (
          <div style={{ marginTop: 6, fontSize: FS.xs, color: C.text3 }}>
            Ngoài ra còn cột thêm theo nghiên cứu: {Object.values(group.dynamic_columns).join(' ')}
          </div>
        )}
      </div>
    </details>
  );
}

export function filterFieldGroups(groups, { query = '', showTechnical = false } = {}) {
  const q = foldText(query).trim();
  return (groups || []).map(group => {
    const fields = (group.fields || []).filter(f => (showTechnical || !f.technical)
      && (!q || foldText(`${f.name} ${f.meaning} ${group.label}`).includes(q)));
    return { group, fields };
  }).filter(item => item.fields.length);
}

export function DataFieldList({ catalog, loading = false }) {
  const [query, setQuery] = useState('');
  const [showTechnical, setShowTechnical] = useState(false);
  const deferredQuery = useDeferredValue(query);

  if (!catalog) {
    if (!loading) return null;
    return (
      <div style={{ ...card, display: 'grid', gap: 10 }} aria-busy="true" aria-label="Đang tải danh sách trường dữ liệu">
        <SkeletonBlock width={220} height={16} />
        <SkeletonLines lines={5} />
      </div>
    );
  }

  const items = filterFieldGroups(catalog.groups, { query: deferredQuery, showTechnical });
  const shown = items.reduce((sum, item) => sum + item.fields.length, 0);
  const shownFilled = items.reduce((sum, item) => sum + item.fields.filter(f => f.filled > 0).length, 0);
  return (
    <section style={card}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>Các trường dữ liệu lấy được</span>
        <span style={{ fontSize: FS.xs, color: C.text3 }}>
          {compactNumber(shown)} trường · {compactNumber(shownFilled)} trường đã có dữ liệu trong kho
        </span>
      </div>
      <div style={{ marginTop: 2, fontSize: FS.xs, color: C.text3 }}>
        Mỗi nhóm là một bảng trong kho. Cột "Đã có giá trị" là số dòng có dữ liệu trên tổng số dòng của bảng đó.
        Từng loại xét nghiệm, thuốc, CĐHA cụ thể là giá trị trong các trường này, chọn ở Tạo nghiên cứu.
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', margin: '8px 0 4px' }}>
        <input
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Tìm trường (vd. huyết áp, chi phí, ngày mổ)"
          aria-label="Tìm trường dữ liệu"
          style={{ flex: '1 1 240px', maxWidth: 360, height: 30, padding: '0 10px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: FS.sm, color: C.text, background: C.surface }}
        />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: FS.xs, color: C.text2, cursor: 'pointer' }}>
          <input type="checkbox" checked={showTechnical} onChange={e => setShowTechnical(e.target.checked)} />
          Hiện cả cột kỹ thuật (mã ghép đợt, nguồn, mã băm)
        </label>
      </div>
      {items.length === 0 && (
        <div style={{ padding: '8px 0', fontSize: FS.sm, color: C.text3 }}>Không có trường nào khớp "{query}". Thử từ khác ngắn hơn.</div>
      )}
      {items.map(({ group, fields }) => (
        <FieldGroup key={group.key} group={group} fields={fields} forceOpen={Boolean(deferredQuery.trim()) && shown <= 60} />
      ))}
    </section>
  );
}
