// Gắn hoạt chất cho tên thuốc trong kho.
// EMR ghi tên thương mại (Aclasta, Zometa...), không ghi hoạt chất. Danh sách này gom y lệnh thuốc
// của kho theo tên thuốc, cho biết tên nào chưa nhận ra hoạt chất; người dùng chọn nhiều tên rồi
// gắn một hoạt chất. Điều kiện "Dùng hoạt chất: …" ở Tạo nghiên cứu dùng ngay, không cần chuẩn hóa lại.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { C, FS } from '../tokens.js';
import { Btn, Spinner, Segmented } from './shared.jsx';
import * as api from '../api.js';
import { SkeletonTable } from './Skeleton.jsx';

const STATUS = {
  mapped: ['Đã có hoạt chất', C.green, C.greenBg],
  catalog_no_ingredient: ['Có trong danh mục, chưa ghi hoạt chất', C.amber, C.amberBg],
  not_in_catalog: ['Chưa có trong danh mục', C.text2, C.surface2],
};

const INPUT = {
  padding: '6px 10px', borderRadius: 6, background: C.surface, border: `1px solid ${C.border}`,
  color: C.text, fontSize: FS.md, boxSizing: 'border-box', fontFamily: 'inherit',
};

const num = (n) => Number(n || 0).toLocaleString('vi-VN');

export default function DrugNameIngredientPanel({ medications = [], onChanged }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('unmapped');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [ingredient, setIngredient] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await api.getArchiveDrugNames());
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const knownIngredients = useMemo(() => [...new Set(medications.flatMap(m => m.active_ingredients || (m.active_ingredient ? [m.active_ingredient] : [])))]
    .sort((a, b) => a.localeCompare(b, 'vi')), [medications]);

  const items = data?.items || [];
  const q = query.trim().toLowerCase();
  const shown = items.filter(it => (filter === 'all' || (filter === 'mapped' ? it.status === 'mapped' : it.status !== 'mapped'))
    && (!q || `${it.name} ${it.variants.join(' ')} ${it.active_ingredients.join(' ')}`.toLowerCase().includes(q)));
  const shownKeys = shown.map(it => it.key);
  const allShownSelected = shownKeys.length > 0 && shownKeys.every(k => selected.has(k));

  const toggle = (key) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const toggleAll = () => setSelected(prev => {
    const next = new Set(prev);
    if (allShownSelected) shownKeys.forEach(k => next.delete(k)); else shownKeys.forEach(k => next.add(k));
    return next;
  });

  const assign = async () => {
    const chosen = items.filter(it => selected.has(it.key));
    const ing = ingredient.trim();
    if (!chosen.length || !ing) return;
    setSaving(true);
    setNotice('');
    try {
      const r = await api.assignMedicationIngredient({
        active_ingredient: ing,
        items: chosen.map(it => ({ name: it.name, catalog_keys: it.catalog_keys })),
      });
      const created = (r.changes || []).filter(c => c.action === 'create').length;
      setNotice(`Đã gắn "${ing}" cho ${chosen.length} tên thuốc${created ? ` (thêm mới ${created} thuốc vào danh mục)` : ''}. Ở Tạo nghiên cứu, chọn "Dùng hoạt chất: ${ing}" — không cần chuẩn hóa lại.`);
      setSelected(new Set());
      await Promise.all([load(), onChanged?.()]);
    } catch (e) {
      setNotice('Lỗi: ' + String(e.message || e));
    } finally {
      setSaving(false);
    }
  };

  const counts = data?.counts || {};
  const unmapped = Number(counts.catalog_no_ingredient || 0) + Number(counts.not_in_catalog || 0);

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ padding: '9px 12px', borderRadius: 7, background: C.blueBg, border: `1px solid ${C.blueBorder}`, fontSize: FS.sm, color: C.text2, lineHeight: 1.5 }}>
        <b>Gắn hoạt chất cho tên thuốc trong kho.</b> Y lệnh ghi tên thương mại (vd. Aclasta, Zometa), không ghi hoạt chất.
        Chọn các tên cùng một hoạt chất rồi bấm <b>Gắn hoạt chất</b>. Điều kiện "Dùng hoạt chất: …" khi tạo nghiên cứu sẽ tính mọi tên đã gắn,
        kể cả khi tên thuốc chỉ nằm trong "Y lệnh khác".
      </div>

      {loading && !data ? (
        <div role="status" aria-busy="true" aria-label="Đang đọc y lệnh thuốc trong kho"><SkeletonTable rows={5} cols={3} /></div>
      ) : error ? (
        <div role="alert" style={{ color: C.red, fontSize: FS.sm }}>Không đọc được tên thuốc trong kho: {error} <Btn onClick={load} style={{ marginLeft: 8 }}>Thử lại</Btn></div>
      ) : !counts.total ? (
        <div style={{ color: C.text3, padding: 20, textAlign: 'center' }}>Kho chưa có y lệnh thuốc (cần thu thập "Lịch sử y lệnh" và chuẩn hóa).</div>
      ) : <>
        <div style={{ fontSize: FS.sm, color: C.text2 }}>
          Kho có <b style={{ color: C.text }}>{num(counts.total)}</b> tên thuốc: <b style={{ color: C.green }}>{num(counts.mapped)}</b> đã nhận ra hoạt chất,{' '}
          <b style={{ color: unmapped ? C.amber : C.text }}>{num(unmapped)}</b> chưa
          {data.unmapped_encounters ? <> (có trong <b>{num(data.unmapped_encounters)}</b> lượt điều trị)</> : null}.
          {data.truncated ? ` Hiện ${num(items.length)} tên dùng nhiều nhất.` : ''}
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <Segmented label="Lọc tên thuốc" value={filter} onChange={setFilter}
            options={[{ value: 'unmapped', label: `Chưa gắn (${num(unmapped)})` }, { value: 'mapped', label: `Đã gắn (${num(counts.mapped)})` }, { value: 'all', label: 'Tất cả' }]} />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Tìm tên thuốc, hoạt chất..." aria-label="Tìm tên thuốc"
            style={{ ...INPUT, flex: '1 1 220px', maxWidth: 360 }} />
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '8px 10px', borderRadius: 7, border: `1px solid ${selected.size ? C.blueBorder : C.border2}`, background: selected.size ? C.blueBg : C.surface }}>
          <span style={{ fontSize: FS.sm, color: C.text2 }}>Đã chọn <b style={{ color: C.text }}>{selected.size}</b> tên</span>
          <input list="known-active-ingredients" value={ingredient} onChange={e => setIngredient(e.target.value)}
            placeholder="Hoạt chất, vd. Acid Zoledronic" aria-label="Hoạt chất cần gắn" style={{ ...INPUT, flex: '1 1 220px', maxWidth: 320 }} />
          <datalist id="known-active-ingredients">{knownIngredients.map(x => <option key={x} value={x} />)}</datalist>
          <Btn variant="solidPrimary" disabled={!selected.size || !ingredient.trim() || saving} onClick={assign}>
            {saving ? <Spinner size={11} /> : 'Gắn hoạt chất'}
          </Btn>
          {selected.size ? <Btn onClick={() => setSelected(new Set())} style={{ fontSize: FS.xs }}>Bỏ chọn</Btn> : null}
        </div>
        {notice && <div role="status" style={{ fontSize: FS.sm, color: notice.startsWith('Lỗi') ? C.red : C.green }}>{notice}</div>}

        <div style={{ background: C.surface, borderTop: `1px solid ${C.border2}`, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: C.surface2 }}>
                <th style={{ padding: '8px 10px', width: 30 }}>
                  <input type="checkbox" checked={allShownSelected} onChange={toggleAll} aria-label="Chọn tất cả tên đang hiện" />
                </th>
                {['Tên thuốc trong y lệnh', 'Lượt điều trị', 'Người bệnh', 'Hoạt chất'].map(h => (
                  <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontSize: FS.xs, fontWeight: 700, color: C.text2, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, 500).map(it => {
                const [label, color, bg] = STATUS[it.status] || STATUS.not_in_catalog;
                return (
                  <tr key={it.key} onClick={() => toggle(it.key)} style={{ borderBottom: `1px solid ${C.border2}`, cursor: 'pointer', background: selected.has(it.key) ? C.blueBg : undefined }}>
                    <td style={{ padding: '8px 10px' }} onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={selected.has(it.key)} onChange={() => toggle(it.key)} aria-label={`Chọn ${it.name}`} />
                    </td>
                    <td style={{ padding: '8px 10px', fontSize: FS.md, color: C.text }}>
                      <div style={{ fontWeight: 600 }}>{it.name}</div>
                      <div style={{ fontSize: FS.xs, color: C.text3, marginTop: 2 }} title={it.variants.join('\n')}>{it.variants[0]}</div>
                    </td>
                    <td style={{ padding: '8px 10px', fontSize: FS.sm, fontVariantNumeric: 'tabular-nums' }}>{num(it.encounters)}</td>
                    <td style={{ padding: '8px 10px', fontSize: FS.sm, fontVariantNumeric: 'tabular-nums' }}>{num(it.patients)}</td>
                    <td style={{ padding: '8px 10px', fontSize: FS.sm }}>
                      {it.active_ingredients.length
                        ? <b style={{ color: C.green }}>{it.active_ingredients.join(', ')}</b>
                        : <span style={{ fontSize: FS.xs, padding: '2px 8px', borderRadius: 999, color, background: bg, whiteSpace: 'nowrap' }}>{label}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!shown.length && <div style={{ color: C.text3, padding: 16, textAlign: 'center', fontSize: FS.sm }}>
            {filter === 'unmapped' && !q ? 'Mọi tên thuốc trong kho đã có hoạt chất.' : 'Không có tên thuốc phù hợp.'}
          </div>}
          {shown.length > 500 && <div style={{ color: C.text3, padding: 10, fontSize: FS.xs }}>Hiện 500 tên đầu; gõ tìm để thu hẹp.</div>}
        </div>
      </>}
    </div>
  );
}
