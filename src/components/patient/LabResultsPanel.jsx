import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { useState } from 'react';
import { C, FS } from '../../tokens.js';
import { Btn, Spinner } from '../shared.jsx';
import { SkeletonLines } from '../Skeleton.jsx';
import * as api from '../../api.js';
import { useServerData, revalidate } from '../../hooks/useServerData.js';
import { formatFetchedAt, labPhieu, labResultsKey, labSummary, patientLabEntry } from '../../utils/labResults.js';

// Dùng chung một gói số liệu cho cả ngày: mọi thẻ người bệnh và tab này gọi máy chủ một lần.
export function useLabResultsDay(date) {
  const key = labResultsKey(date);
  return useServerData(key, () => api.getLabResults(date), { enabled: Boolean(date) });
}

const cell = { borderBottom: `1px solid ${C.border2}`, padding: '6px 9px', fontSize: FS.sm, verticalAlign: 'top', color: C.text, textAlign: 'left' };

function PhieuCard({ phieu }) {
  const rows = Array.isArray(phieu.ket_qua) ? phieu.ket_qua : [];
  return (
    <section style={{ border: `1px solid ${C.border}`, borderRadius: 7, background: C.surface, overflow: 'hidden' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 12px', alignItems: 'baseline', padding: '8px 12px', background: C.surface2 }}>
        <strong style={{ fontSize: FS.md }}>{phieu.loai_xn || 'Xét nghiệm'}</strong>
        <span style={{ fontSize: FS.sm, color: C.text2, fontVariantNumeric: 'tabular-nums' }}>{phieu.tg_chi_dinh}</span>
        {phieu.nguoi_chi_dinh && <span style={{ fontSize: FS.sm, color: C.text2 }}>BS {phieu.nguoi_chi_dinh}</span>}
        <span style={{ marginLeft: 'auto', fontSize: FS.xs, fontWeight: 600, color: phieu.hoan_tat ? C.green : C.amber }}>
          {phieu.hoan_tat ? 'Đã có kết quả' : `Chưa có kết quả${phieu.trang_thai ? ` (${phieu.trang_thai})` : ''}`}
        </span>
      </div>
      {phieu.loi && <p style={{ margin: 0, padding: '8px 12px', color: C.red, fontSize: FS.sm }}>Chưa đọc được phiếu này: {phieu.loi}</p>}
      {phieu.hoan_tat && rows.length > 0 && (
        <div className="emr-hscroll" style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 520 }}>
            <thead><tr>{['Chỉ số', 'Kết quả', 'Đơn vị', 'Tham chiếu'].map(h => <th key={h} scope="col" style={{ ...cell, color: C.text2, fontWeight: 600 }}>{h}</th>)}</tr></thead>
            <tbody>{rows.map((r, i) => {
              const bad = Boolean(r.bat_thuong);
              return (
                <tr key={`${r.chi_so}-${i}`} style={bad ? { background: C.redBg } : undefined}>
                  <td style={cell}>{r.chi_so}</td>
                  <td style={{ ...cell, fontWeight: 600, color: bad ? C.red : C.text, fontVariantNumeric: 'tabular-nums' }}>
                    {bad && <IconAlertTriangle size={13} stroke={2} aria-label="Ngoài khoảng tham chiếu" style={{ verticalAlign: '-2px', marginRight: 3 }} />}
                    {r.ket_qua}
                  </td>
                  <td style={{ ...cell, color: C.text2 }}>{r.don_vi || '—'}</td>
                  <td style={{ ...cell, color: C.text2 }}>{r.tham_chieu || '—'}</td>
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
  const entry = patientLabEntry(data, patient);
  const phieu = labPhieu(entry);
  const s = labSummary(entry);
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: FS.sm, color: C.text2, flex: '1 1 260px' }}>
          Xét nghiệm có thời gian chỉ định ngày <b style={{ color: C.text }}>{date}</b>, đọc từ EMR (Xem kết quả → Lịch sử XN), chỉ đọc, không ghi gì vào EMR.
          {entry?.fetched_at && <> Đọc lúc <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatFetchedAt(entry.fetched_at)}</span>.</>}
        </div>
        <Btn variant="primary" disabled={Boolean(busy)} icon={busy === 'one' ? null : IconRefresh}
          title="Đọc lại kết quả xét nghiệm của người bệnh này trên EMR"
          onClick={() => run('one', [patient], [patient?.ma_bn || patient?.id])}>
          {busy === 'one' ? <><Spinner size={10} /> Đang đọc EMR</> : (entry ? 'Lấy lại' : 'Lấy kết quả XN')}
        </Btn>
        {others.length > 0 && (
          <Btn disabled={Boolean(busy)}
            title="Đọc kết quả xét nghiệm cho các người bệnh đang tích chọn. Ca đã đủ kết quả không mở lại EMR."
            onClick={() => run('all', [patient, ...others])}>
            {busy === 'all' ? <><Spinner size={10} /> Đang đọc EMR</> : `Lấy cho ${others.length + 1} người đang chọn`}
          </Btn>
        )}
      </div>

      {error && !data && <p style={{ margin: 0, color: C.red, fontSize: FS.sm }}>Không tải được kết quả xét nghiệm đã lưu. Kiểm tra kết nối máy chủ rồi mở lại tab.</p>}
      {loading && <SkeletonLines lines={3} />}

      {!loading && !entry && (
        <p style={{ margin: 0, color: C.text2, fontSize: FS.md }}>
          Chưa lấy kết quả xét nghiệm ngày {date} cho người bệnh này. Bấm <b>Lấy kết quả XN</b>.
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
      {entry?.status === 'none' && (
        <p style={{ margin: 0, color: C.text2, fontSize: FS.md }}>EMR không có phiếu xét nghiệm nào chỉ định ngày {date}.</p>
      )}
      {entry?.status === 'ok' && (
        <div style={{ fontSize: FS.sm, color: C.text2 }}>
          {s.total} phiếu, {s.done} đã có kết quả{s.pending ? `, ${s.pending} chưa có` : ''}{s.abnormal ? <>, <b style={{ color: C.red }}>{s.abnormal} chỉ số ngoài khoảng tham chiếu</b></> : ''}.
        </div>
      )}
      {phieu.map((p, i) => <PhieuCard key={p.ma_phieu || i} phieu={p} />)}
    </div>
  );
}
