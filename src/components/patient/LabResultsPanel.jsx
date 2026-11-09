import { IconAlertTriangle, IconRefresh, IconUsers } from '@tabler/icons-react';
import { useState } from 'react';
import { C, FS } from '../../tokens.js';
import { Btn, Spinner } from '../shared.jsx';
import { SkeletonLines } from '../Skeleton.jsx';
import * as api from '../../api.js';
import { useServerData, revalidate } from '../../hooks/useServerData.js';
import {
  abnormalLabel, abnormalRows, formatFetchedAt, isStaleLabEntry, labPhieu, labResultsKey, labSummary, patientLabEntry,
} from '../../utils/labResults.js';

// Dùng chung một gói số liệu cho cả ngày: mọi thẻ người bệnh và tab này gọi máy chủ một lần.
export function useLabResultsDay(date) {
  const key = labResultsKey(date);
  return useServerData(key, () => api.getLabResults(date), { enabled: Boolean(date) });
}

const cell = { borderBottom: `1px solid ${C.border2}`, padding: '7px 10px', fontSize: FS.sm, verticalAlign: 'top', color: C.text, textAlign: 'left' };

function AbnormalValue({ row, strong = true }) {
  const label = abnormalLabel(row.bat_thuong);
  if (!label) return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{row.ket_qua}</span>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: C.red, fontWeight: strong ? 700 : 600, fontVariantNumeric: 'tabular-nums' }}>
      {row.ket_qua}
      <span aria-label={label.text} title={label.text} style={{
        display: 'inline-flex', alignItems: 'center', gap: 2, padding: '0 6px', lineHeight: '18px', borderRadius: 9,
        background: C.red, color: '#fff', fontSize: FS.xs, fontWeight: 700,
      }}>{label.arrow} {label.text}</span>
    </span>
  );
}

// Khối tóm tắt đầu tab: mọi chỉ số bất thường của ngày, nhìn một lần là thấy.
function AbnormalSummary({ rows }) {
  if (!rows.length) return null;
  return (
    <section aria-label="Chỉ số bất thường" style={{ border: `1px solid ${C.redBorder}`, borderLeft: `4px solid ${C.red}`, background: C.redBg, borderRadius: 7, padding: '10px 12px' }}>
      <h3 style={{ margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 6, fontSize: FS.md, fontWeight: 700, color: C.red }}>
        <IconAlertTriangle size={16} stroke={2} aria-hidden="true" /> {rows.length} chỉ số ngoài khoảng tham chiếu
      </h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 6 }}>
        {rows.map((r, i) => (
          <div key={`${r.loai_xn}-${r.chi_so}-${i}`} style={{ background: C.surface, border: `1px solid ${C.redBorder}`, borderRadius: 5, padding: '6px 9px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, alignItems: 'baseline' }}>
              <span style={{ fontWeight: 600, fontSize: FS.sm, color: C.text }}>{r.chi_so}</span>
              <AbnormalValue row={r} />
            </div>
            <div style={{ fontSize: FS.xs, color: C.text2, marginTop: 2 }}>
              {r.tham_chieu ? <>BT {r.tham_chieu}{r.don_vi ? ` ${r.don_vi}` : ''}</> : 'Không có khoảng tham chiếu'}{r.loai_xn ? ` · ${r.loai_xn}` : ''}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function PhieuCard({ phieu, onlyAbnormal }) {
  const all = Array.isArray(phieu.ket_qua) ? phieu.ket_qua : [];
  const rows = onlyAbnormal ? all.filter(r => r.bat_thuong) : all;
  const bad = all.filter(r => r.bat_thuong).length;
  const hasUnit = all.some(r => r.don_vi);
  if (onlyAbnormal && phieu.hoan_tat && !bad) return null;
  const headers = ['Chỉ số', 'Kết quả', 'Tham chiếu', ...(hasUnit ? ['Đơn vị'] : [])];
  return (
    <section style={{ border: `1px solid ${bad ? C.redBorder : C.border}`, borderRadius: 7, background: C.surface, overflow: 'hidden' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 12px', alignItems: 'baseline', padding: '8px 12px', background: C.surface2, borderBottom: `1px solid ${C.border2}` }}>
        <strong style={{ fontSize: FS.md }}>{phieu.loai_xn || 'Xét nghiệm'}</strong>
        <span style={{ fontSize: FS.sm, color: C.text2, fontVariantNumeric: 'tabular-nums' }}>{phieu.tg_chi_dinh}</span>
        {phieu.nguoi_chi_dinh && <span style={{ fontSize: FS.sm, color: C.text2 }}>BS {phieu.nguoi_chi_dinh}</span>}
        <span style={{ marginLeft: 'auto', fontSize: FS.xs, fontWeight: 600, color: !phieu.hoan_tat ? C.amber : (bad ? C.red : C.green) }}>
          {!phieu.hoan_tat ? `Chưa có kết quả${phieu.trang_thai ? ` (${phieu.trang_thai})` : ''}` : (bad ? `${bad} bất thường` : 'Bình thường')}
        </span>
      </div>
      {phieu.loi && <p style={{ margin: 0, padding: '8px 12px', color: C.red, fontSize: FS.sm }}>Chưa đọc được phiếu này: {phieu.loi}</p>}
      {phieu.hoan_tat && rows.length > 0 && (
        <div className="emr-hscroll" style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 460, tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: hasUnit ? '34%' : '40%' }} /><col style={{ width: '30%' }} /><col style={{ width: hasUnit ? '22%' : '30%' }} />
              {hasUnit && <col style={{ width: '14%' }} />}
            </colgroup>
            <thead><tr>{headers.map(h => <th key={h} scope="col" style={{ ...cell, color: C.text2, fontWeight: 600, fontSize: FS.xs }}>{h}</th>)}</tr></thead>
            <tbody>{rows.map((r, i) => {
              const isBad = Boolean(r.bat_thuong);
              return (
                <tr key={`${r.chi_so}-${i}`} style={isBad ? { background: C.redBg, boxShadow: `inset 3px 0 0 ${C.red}` } : undefined}>
                  <td style={{ ...cell, fontWeight: isBad ? 700 : 500, color: isBad ? C.red : C.text }}>{r.chi_so}</td>
                  <td style={cell}><AbnormalValue row={r} /></td>
                  <td style={{ ...cell, color: C.text2, fontVariantNumeric: 'tabular-nums' }}>{r.tham_chieu || '—'}</td>
                  {hasUnit && <td style={{ ...cell, color: C.text2 }}>{r.don_vi || ''}</td>}
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function LabResultsPanel({ patient, date, dayPatients = [], toast }) {
  const { data, error, loading } = useLabResultsDay(date);
  const [busy, setBusy] = useState('');
  const [onlyAbnormal, setOnlyAbnormal] = useState(false);
  const entry = patientLabEntry(data, patient);
  const stale = isStaleLabEntry(entry);
  const phieu = stale ? [] : labPhieu(entry);
  const s = labSummary(entry);
  const bad = stale ? [] : abnormalRows(entry);
  const others = dayPatients.filter(p => (p?.ma_bn || p?.id) && (p?.ma_bn || p?.id) !== (patient?.ma_bn || patient?.id));

  const run = async (kind, list, forceIds = []) => {
    setBusy(kind);
    try {
      const r = await api.fetchLabResults(date, list, { forceIds });
      toast?.(r?.warning ? `${r.message} ${r.warning}` : r?.message || 'Đã lấy kết quả xét nghiệm.', r?.warning ? 'warn' : 'success');
    } catch (e) {
      toast?.(String(e?.message || e) || 'Không lấy được kết quả xét nghiệm. Thử lại sau ít phút.', 'error');
    } finally {
      setBusy('');
      revalidate(labResultsKey(date));
    }
  };

  if (!date) return <p style={{ color: C.text2, fontSize: FS.md }}>Chưa chọn ngày để xem kết quả xét nghiệm.</p>;

  const statusLine = !entry ? 'Chưa lấy kết quả'
    : entry.status === 'none' ? 'EMR không có phiếu xét nghiệm trong ngày'
      : entry.status === 'error' ? 'Chưa đọc được'
        : stale ? 'Cần lấy lại'
          : `${s.total} phiếu · ${s.done} có kết quả${s.pending ? ` · ${s.pending} chưa có` : ''}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Thanh điều khiển: thông tin bên trái, nút bên phải, cùng một hàng. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 12px', padding: '10px 12px', border: `1px solid ${C.border}`, borderRadius: 7, background: C.surface }}>
        <div style={{ flex: '1 1 240px', minWidth: 0 }}>
          <div style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>
            Xét nghiệm ngày {date}
            <span style={{ marginLeft: 8, fontWeight: 500, color: entry?.status === 'error' || stale ? C.amber : C.text2, fontSize: FS.sm }}>{statusLine}</span>
            {bad.length > 0 && <span style={{ marginLeft: 8, color: C.red, fontSize: FS.sm, fontWeight: 700 }}>· {bad.length} bất thường</span>}
          </div>
          <div style={{ fontSize: FS.xs, color: C.text3, marginTop: 2 }}>
            {entry?.fetched_at ? <>Đọc lúc <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatFetchedAt(entry.fetched_at)}</span> · </> : null}
            Chỉ đọc EMR (Xem kết quả → Lịch sử XN), không ghi gì.
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {phieu.some(p => p.hoan_tat && (p.ket_qua || []).length) && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: FS.sm, color: C.text2, cursor: 'pointer', marginRight: 4 }}>
              <input type="checkbox" checked={onlyAbnormal} onChange={e => setOnlyAbnormal(e.target.checked)} style={{ accentColor: C.red, margin: 0 }} />
              Chỉ hiện bất thường
            </label>
          )}
          <Btn variant="solidPrimary" disabled={Boolean(busy)} icon={busy === 'one' ? null : IconRefresh}
            title="Đọc lại kết quả xét nghiệm của người bệnh này trên EMR"
            onClick={() => run('one', [patient], [patient?.ma_bn || patient?.id])}>
            {busy === 'one' ? <><Spinner size={10} /> Đang đọc EMR</> : (entry ? 'Lấy lại' : 'Lấy kết quả XN')}
          </Btn>
          {others.length > 0 && (
            <Btn variant="secondary" disabled={Boolean(busy)} icon={busy === 'all' ? null : IconUsers}
              title="Đọc kết quả xét nghiệm cho các người bệnh đang tích chọn. Ca đã đủ kết quả không mở lại EMR."
              onClick={() => run('all', [patient, ...others])}>
              {busy === 'all' ? <><Spinner size={10} /> Đang đọc EMR</> : `Lấy cả ${others.length + 1} người đang chọn`}
            </Btn>
          )}
        </div>
      </div>

      {error && !data && <p style={{ margin: 0, color: C.red, fontSize: FS.sm }}>Không tải được kết quả xét nghiệm đã lưu. Kiểm tra kết nối máy chủ rồi mở lại tab.</p>}
      {loading && <SkeletonLines lines={3} />}

      {!loading && !entry && (
        <p style={{ margin: 0, color: C.text2, fontSize: FS.md }}>
          Chưa lấy kết quả xét nghiệm ngày {date} cho người bệnh này. Bấm <b>Lấy kết quả XN</b>.
        </p>
      )}
      {stale && (
        <p style={{ margin: 0, padding: '8px 12px', border: `1px solid ${C.amberBorder}`, background: C.amberBg, borderRadius: 7, color: C.amber, fontSize: FS.sm }}>
          Kết quả này đọc bằng bản cũ, các cột có thể bị lệch nên chưa hiện. Bấm <b>Lấy lại</b> để đọc lại.
        </p>
      )}
      {entry?.status === 'error' && (
        <p style={{ margin: 0, padding: '8px 12px', border: `1px solid ${C.amberBorder}`, background: C.amberBg, borderRadius: 7, color: C.amber, fontSize: FS.sm }}>
          Chưa đọc được kết quả xét nghiệm: {entry.error || 'lỗi không rõ'}. Bấm <b>Lấy lại</b> để thử lần nữa; nếu vẫn lỗi, mở EMR xem trực tiếp.
        </p>
      )}
      {entry?.last_error && (
        <p style={{ margin: 0, color: C.amber, fontSize: FS.xs }}>
          Lần đọc gần nhất lỗi ({entry.last_error}); đang hiện kết quả đọc lúc {formatFetchedAt(entry.fetched_at)}.
        </p>
      )}

      <AbnormalSummary rows={bad} />
      {onlyAbnormal && bad.length === 0 && phieu.length > 0 && (
        <p style={{ margin: 0, color: C.green, fontSize: FS.md }}>Không có chỉ số nào ngoài khoảng tham chiếu.</p>
      )}
      {phieu.map((p, i) => <PhieuCard key={p.ma_phieu || i} phieu={p} onlyAbnormal={onlyAbnormal} />)}
    </div>
  );
}
