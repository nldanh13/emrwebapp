// src/components/PatientJourneyTab.jsx — Người bệnh & tái khám (Kho người bệnh).
// 3 phần: tìm người bệnh → hành trình mọi lượt khám / nằm viện; báo cáo tái khám (đúng hẹn ±3 ngày);
// báo cáo tái nhập viện trong 30 ngày. Chỉ đọc, dữ liệu lấy từ server/services/patient_db.js.
import { useCallback, useEffect, useState } from 'react';
import { IconArrowLeft, IconRefresh, IconSearch } from '@tabler/icons-react';
import { C, FS, R } from '../tokens.js';
import { Btn, Segmented, Spinner } from './shared.jsx';
import DateField, { formatDmy } from './DateField.jsx';
import * as api from '../api.js';

const VIEWS = [
  { value: 'tim', label: 'Tìm người bệnh' },
  { value: 'tai-kham', label: 'Tái khám' },
  { value: 'tai-nhap', label: 'Tái nhập viện' },
];

const HEN = {
  dung_hen: { label: 'Đúng hẹn', color: C.green, bg: C.greenBg },
  tre_hen: { label: 'Trễ hẹn', color: C.amber, bg: C.amberBg },
  qua_hen: { label: 'Quá hẹn, chưa quay lại', color: C.red, bg: C.redBg },
  chua_den_hen: { label: 'Chưa đến hẹn', color: C.text2, bg: C.muted },
};

const NHAP = {
  tai_nhap_vien: { label: 'Tái nhập viện', color: C.red, bg: C.redBg },
  khong_tai_nhap: { label: 'Không tái nhập', color: C.green, bg: C.greenBg },
  chua_du_30_ngay: { label: 'Chưa đủ 30 ngày', color: C.text2, bg: C.muted },
};

const LIEN_KET = {
  tai_kham_dung_hen: 'Tái khám đúng hẹn',
  tai_kham_tre_hen: 'Tái khám trễ hẹn',
  tai_nhap_vien_30: 'Tái nhập viện trong 30 ngày',
  kham_nhap_vien: 'Khám → nhập viện',
};

const THAO_TAC = { hoan_tat_kham: 'Hoàn tất khám', sbbhc: 'Lập SBBHC', dieu_tri_ngoai_tru: 'Điều trị ngoại trú' };

function isoDay(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function shiftDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return isoDay(d);
}

// "2026-09-28 08:12" → "08:12 28/09/2026"; "2026-09-28" → "28/09/2026"
function fmtTime(value) {
  const s = String(value || '');
  const day = formatDmy(s.slice(0, 10));
  if (!day) return s;
  return s.length > 10 ? `${s.slice(11, 16)} ${day}` : day;
}

function signed(n) {
  if (n == null) return '';
  return n > 0 ? `+${n}` : String(n);
}

function Chip({ meta, children }) {
  if (!meta) return null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', height: 22, padding: '0 8px', borderRadius: R.sm, background: meta.bg, color: meta.color, fontSize: FS.xs, fontWeight: 650, whiteSpace: 'nowrap' }}>
      {children || meta.label}
    </span>
  );
}

function Tile({ label, value, tone }) {
  return (
    <div style={{ flex: '1 1 140px', border: `1px solid ${C.border2}`, borderRadius: R.md, background: C.surface, padding: '8px 12px' }}>
      <div style={{ fontSize: FS.xs, color: C.text2, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: tone || C.text, fontVariantNumeric: 'tabular-nums' }}>{value ?? '—'}</div>
    </div>
  );
}

function Note({ children }) {
  return <div style={{ fontSize: FS.xs, color: C.text3, lineHeight: 1.45 }}>{children}</div>;
}

const th = { textAlign: 'left', padding: '6px 8px', fontSize: FS.xs, color: C.text2, fontWeight: 650, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' };
const td = { padding: '7px 8px', fontSize: FS.sm, color: C.text, borderBottom: `1px solid ${C.border2}`, verticalAlign: 'top' };

function Table({ head, children }) {
  return (
    <div className="emr-hscroll" style={{ overflowX: 'auto', border: `1px solid ${C.border2}`, borderRadius: R.md, background: C.surface }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
        <thead><tr>{head.map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function PatientCell({ row, onOpen }) {
  return (
    <button type="button" onClick={() => onOpen(row.ma_bn)} style={{ border: 0, background: 'transparent', padding: 0, textAlign: 'left', cursor: 'pointer', color: C.blue, fontSize: FS.sm, fontWeight: 650 }}>
      {row.ho_ten || row.ma_bn}
      <span style={{ display: 'block', color: C.text3, fontWeight: 500, fontSize: FS.xs }}>{row.ma_bn}{row.nam_sinh ? ` · ${row.nam_sinh}` : ''}</span>
    </button>
  );
}

function RangeBar({ tu, den, setTu, setDen, loading, onReload, children }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <DateField label="Từ ngày" value={tu} onChange={setTu} />
      <span style={{ color: C.text3, fontSize: FS.sm }}>đến</span>
      <DateField label="Đến ngày" value={den} onChange={setDen} />
      <Btn icon={IconRefresh} loading={loading} onClick={onReload}>Tải lại</Btn>
      {children}
    </div>
  );
}

// ── Hành trình 1 người bệnh ──────────────────────────────────────────────────

const ABNORMAL_RE = /^(h|l|hh|ll|cao|thấp|bất thường|\*|↑|↓|[<>])/i;
const isAbnormalFlag = value => Boolean(value && ABNORMAL_RE.test(String(value).trim()));

// Kết quả XN / CĐHA của lượt (lấy từ Kho nghiên cứu), thu gọn mặc định.
function ResultsBlock({ l }) {
  const xn = l.xet_nghiem || [];
  const cd = l.cdha || [];
  if (!xn.length && !cd.length) return null;
  const abnormal = xn.filter(r => isAbnormalFlag(r.bat_thuong)).length;
  return (
    <details style={{ fontSize: FS.sm }}>
      <summary style={{ cursor: 'pointer', color: C.text2, fontWeight: 600 }}>
        {[xn.length && `Xét nghiệm: ${xn.length} kết quả${abnormal ? ` (${abnormal} bất thường)` : ''}`, cd.length && `CĐHA: ${cd.length}`].filter(Boolean).join(' · ')}
      </summary>
      {xn.length > 0 && (
        <div className="emr-hscroll" style={{ overflowX: 'auto', marginTop: 6 }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 520 }}>
            <thead><tr>{['Thời gian', 'Chỉ số', 'Kết quả', 'Đơn vị', 'Tham chiếu', 'Cờ'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {xn.map((r, i) => {
                const abnormalFlag = isAbnormalFlag(r.bat_thuong);
                return (
                <tr key={i}>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtTime(r.thoi_gian)}</td>
                  <td style={td}>{r.chi_so}{r.loai_xn ? <span style={{ color: C.text3, fontSize: FS.xs }}> · {r.loai_xn}</span> : null}</td>
                  <td style={{ ...td, fontVariantNumeric: 'tabular-nums', fontWeight: abnormalFlag ? 650 : 400, color: abnormalFlag ? C.red : C.text }}>{r.ket_qua}</td>
                  <td style={td}>{r.don_vi}</td>
                  <td style={td}>{r.tham_chieu}</td>
                  <td style={td}>{r.bat_thuong}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {cd.map((r, i) => (
        <div key={i} style={{ marginTop: 6, paddingTop: 6, borderTop: `1px solid ${C.border2}` }}>
          <b>{fmtTime(r.thoi_gian)}</b> · {r.ten_dich_vu}{r.nhom ? ` (${r.nhom})` : ''}
          {r.ket_luan && <div>Kết luận: {r.ket_luan}</div>}
          {r.mo_ta && <div style={{ color: C.text2, whiteSpace: 'pre-wrap' }}>{r.mo_ta}</div>}
        </div>
      ))}
    </details>
  );
}

function VisitCard({ l, byId }) {
  const isKham = l.loai === 'kham';
  const hen = l.trang_thai_hen;
  const dxKem = (l.chan_doan || []).filter(d => d.loai === 'kem');
  const links = (l.lien_ket || []).filter(k => k.luot_truoc === l.id);
  const services = (l.dich_vu || []).filter(s => s.ten);
  return (
    <div style={{ border: `1px solid ${C.border2}`, borderRadius: R.md, background: C.surface, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <Chip meta={{ color: isKham ? C.blue : C.text, bg: isKham ? C.blueBg : C.muted }}>{isKham ? 'Khám' : 'Nội trú'}</Chip>
        <b style={{ fontSize: FS.md, fontVariantNumeric: 'tabular-nums' }}>
          {fmtTime(l.gio_vao)}{!isKham && l.gio_ra ? ` → ${fmtTime(l.gio_ra)}` : ''}
        </b>
        {l.khoa && <span style={{ color: C.text2, fontSize: FS.sm }}>{l.khoa}</span>}
        {l.trang_thai === 'dang_dieu_tri' && <Chip meta={{ color: C.amber, bg: C.amberBg }}>{isKham ? 'Đang khám' : 'Đang nằm viện'}</Chip>}
        <span style={{ marginLeft: 'auto', color: C.text3, fontSize: FS.xs }}>{l.muc === 'goc' ? 'Dữ liệu gốc' : 'Dữ liệu tạm thời'}</span>
      </div>
      <div style={{ fontSize: FS.md }}>
        {l.chan_doan_chinh ? <>{l.icd_chinh && <b>{l.icd_chinh} </b>}{l.chan_doan_chinh}</> : <span style={{ color: C.text3 }}>Chưa có chẩn đoán</span>}
        {dxKem.length > 0 && <span style={{ color: C.text2 }}> · kèm: {dxKem.map(d => d.icd || d.ten).join(', ')}</span>}
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: FS.sm, color: C.text2 }}>
        {l.ly_do && <span>Lý do: {l.ly_do}</span>}
        {l.xu_tri && <span>Xử trí: {l.xu_tri}</span>}
        {l.co_bhyt === 1 && <span>BHYT</span>}
      </div>
      {hen && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: FS.sm }}>
          <span>Hẹn tái khám {fmtTime(hen.ngay_hen)}</span>
          <Chip meta={HEN[hen.trang_thai]}>{HEN[hen.trang_thai]?.label}{hen.lech_hen != null ? ` (${signed(hen.lech_hen)} ngày)` : ''}</Chip>
        </div>
      )}
      {links.map(k => (
        <div key={`${k.loai}-${k.luot_sau}`} style={{ fontSize: FS.sm, color: C.text2 }}>
          {LIEN_KET[k.loai] || k.loai}: {byId[k.luot_sau] ? fmtTime(byId[k.luot_sau].gio_vao) : ''}
          {k.so_ngay != null ? ` · sau ${k.so_ngay} ngày` : ''}
        </div>
      ))}
      {services.length > 0 && (
        <div style={{ fontSize: FS.xs, color: C.text3 }}>
          Dịch vụ: {services.slice(0, 8).map(s => s.so_chi_dinh ? `${s.ten} ${s.so_da_xong}/${s.so_chi_dinh}` : s.ten).join(' · ')}
          {services.length > 8 ? ` · +${services.length - 8}` : ''}
        </div>
      )}
      <ResultsBlock l={l} />
      {(l.thao_tac || []).length > 0 && (
        <div style={{ fontSize: FS.xs, color: C.text3 }}>
          Hệ thống đã làm: {l.thao_tac.map(t => `${THAO_TAC[t.loai] || t.loai} (${t.ket_qua})`).join(' · ')}
        </div>
      )}
    </div>
  );
}

function Journey({ maBn, onBack, toast }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.getPatientJourney(maBn)
      .then(r => { if (alive) setData(r); })
      .catch(e => { if (alive) { setData(null); toast?.(String(e.message || e), 'error'); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [maBn, toast]);

  const bn = data?.benh_nhan;
  const visits = [...(data?.luot || [])].reverse();
  const byId = Object.fromEntries((data?.luot || []).map(l => [l.id, l]));
  const counts = (data?.luot || []).reduce((acc, l) => ({ ...acc, [l.loai]: (acc[l.loai] || 0) + 1 }), {});
  const unlinked = data?.ket_qua_chua_xac_dinh || {};
  const unlinkedCount = (unlinked.xet_nghiem || []).length + (unlinked.cdha || []).length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <Btn icon={IconArrowLeft} onClick={onBack}>Quay lại</Btn>
        {loading && <Spinner />}
        {bn && (
          <div>
            <div style={{ fontSize: FS.lg, fontWeight: 700 }}>{bn.ho_ten || bn.ma_bn}</div>
            <div style={{ fontSize: FS.sm, color: C.text2 }}>
              {[bn.ma_bn, bn.nam_sinh && `sinh ${bn.nam_sinh}`, bn.gioi_tinh, `${counts.kham || 0} lượt khám`, `${counts.noi_tru || 0} đợt nội trú`].filter(Boolean).join(' · ')}
            </div>
          </div>
        )}
      </div>
      {unlinkedCount > 0 && (
        <div style={{ border: `1px solid ${C.amber}`, borderRadius: R.md, background: C.amberBg, color: C.text, padding: '8px 10px', fontSize: FS.sm }}>
          Có {unlinkedCount} kết quả XN/CĐHA chưa xác định được lượt vì người bệnh có nhiều lượt trùng ngày. Hệ thống giữ lại dữ liệu và không tự gắn để tránh sai hồ sơ.
        </div>
      )}
      {visits.map(l => <VisitCard key={l.id} l={l} byId={byId} />)}
      {!loading && !visits.length && <Note>Chưa có lượt nào trong kho.</Note>}
    </div>
  );
}

function SearchView({ onOpen, toast }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState(null);

  useEffect(() => {
    api.getPatientDbSummary().then(setSummary).catch(e => setSummary({ error: String(e.message || e) }));
  }, []);

  const search = async (e) => {
    e?.preventDefault();
    if (q.trim().length < 2) return;
    setLoading(true);
    try {
      setRows((await api.searchPatientDb(q.trim())).rows || []);
    } catch (err) {
      toast?.(String(err.message || err), 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <form onSubmit={search} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Mã BN, họ tên (có dấu hoặc không), SĐT, số thẻ BHYT" aria-label="Tìm người bệnh"
          style={{ flex: '1 1 280px', height: 32, padding: '0 10px', border: `1px solid ${C.border}`, borderRadius: R.sm, fontFamily: 'inherit', fontSize: FS.md, color: C.text, background: C.surface }} />
        <Btn type="submit" variant="solidPrimary" icon={IconSearch} loading={loading} disabled={q.trim().length < 2}>Tìm</Btn>
      </form>
      {summary?.error && <Note>{summary.error}</Note>}
      {summary && !summary.error && (
        <Note>Kho có {summary.benh_nhan} người bệnh · {summary.luot_kham} lượt khám · {summary.luot_noi_tru} đợt nội trú.</Note>
      )}
      {rows && (rows.length ? (
        <Table head={['Người bệnh', 'Giới', 'Số lượt', 'Lần gần nhất']}>
          {rows.map(r => (
            <tr key={r.ma_bn}>
              <td style={td}><PatientCell row={r} onOpen={onOpen} /></td>
              <td style={td}>{r.gioi_tinh}</td>
              <td style={{ ...td, fontVariantNumeric: 'tabular-nums' }}>{r.so_luot}</td>
              <td style={td}>{fmtTime(r.lan_cuoi)}</td>
            </tr>
          ))}
        </Table>
      ) : <Note>Không tìm thấy người bệnh nào.</Note>)}
    </div>
  );
}

// ── Báo cáo ─────────────────────────────────────────────────────────────────

function useReport(load, deps) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await load());
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { data, loading, error, reload };
}

const SCOPE_NOTE = 'Chỉ tính các lượt đã có trong kho (Phòng khám đang theo dõi, Kiểm HSBA, Trả HSBA, Kho nghiên cứu). Người bệnh quay lại nơi hệ thống không quét sẽ không thấy.';

function AppointmentView({ onOpen }) {
  const [tu, setTu] = useState(shiftDays(-30));
  const [den, setDen] = useState(shiftDays(14));
  const [filter, setFilter] = useState('');
  const { data, loading, error, reload } = useReport(() => api.getAppointmentReport({ tu, den }), [tu, den]);
  const t = data?.tong_ket;
  const rows = (data?.rows || []).filter(r => !filter || r.trang_thai === filter);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <RangeBar tu={tu} den={den} setTu={setTu} setDen={setDen} loading={loading} onReload={reload} />
      <Note>Theo ngày hẹn tái khám. Đúng hẹn: quay lại trong khoảng ±3 ngày so với ngày hẹn. Tỉ lệ đúng hẹn chỉ tính các hẹn đã qua hạn theo dõi.</Note>
      {error && <Note>{error}</Note>}
      {t && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Tile label="Lượt có hẹn" value={t.tong} />
          <Tile label="Đúng hẹn" value={t.dung_hen} tone={C.green} />
          <Tile label="Trễ hẹn" value={t.tre_hen} tone={C.amber} />
          <Tile label="Quá hẹn, chưa quay lại" value={t.qua_hen} tone={C.red} />
          <Tile label="Tỉ lệ đúng hẹn" value={t.ti_le_dung_hen == null ? '—' : `${t.ti_le_dung_hen}%`} />
        </div>
      )}
      <Segmented label="Lọc trạng thái" value={filter} onChange={setFilter}
        options={[{ value: '', label: 'Tất cả' }, ...Object.entries(HEN).map(([value, m]) => ({ value, label: m.label }))]} />
      {data && (rows.length ? (
        <Table head={['Ngày hẹn', 'Trạng thái', 'Người bệnh', 'Lượt có hẹn', 'Quay lại']}>
          {rows.map(r => (
            <tr key={r.luot_id}>
              <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtTime(r.ngay_hen)}</td>
              <td style={td}><Chip meta={HEN[r.trang_thai]} /></td>
              <td style={td}><PatientCell row={r} onOpen={onOpen} /></td>
              <td style={td}>
                {r.loai_luot === 'kham' ? 'Khám' : 'Ra viện'} {fmtTime(r.loai_luot === 'kham' ? r.gio_vao : r.gio_ra)}
                {r.chan_doan_chinh && <span style={{ display: 'block', color: C.text2, fontSize: FS.xs }}>{r.chan_doan_chinh}</span>}
              </td>
              <td style={{ ...td, whiteSpace: 'nowrap' }}>
                {r.luot_sau ? <>{fmtTime(r.luot_sau.gio_vao)}<span style={{ display: 'block', color: C.text2, fontSize: FS.xs }}>{signed(r.lech_hen)} ngày so với hẹn</span></> : '—'}
              </td>
            </tr>
          ))}
        </Table>
      ) : <Note>Không có lượt nào có hẹn tái khám trong khoảng ngày này.</Note>)}
      <Note>{SCOPE_NOTE}</Note>
    </div>
  );
}

function ReadmissionView({ onOpen }) {
  const [tu, setTu] = useState(shiftDays(-60));
  const [den, setDen] = useState(shiftDays(0));
  const { data, loading, error, reload } = useReport(() => api.getReadmissionReport({ tu, den }), [tu, den]);
  const t = data?.tong_ket;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <RangeBar tu={tu} den={den} setTu={setTu} setDen={setDen} loading={loading} onReload={reload} />
      <Note>Theo ngày ra viện. Tái nhập viện: có đợt nội trú mới trong 30 ngày sau ra viện. Đợt ra viện chưa đủ 30 ngày mà chưa thấy tái nhập được đếm riêng, không tính vào tỉ lệ.</Note>
      {error && <Note>{error}</Note>}
      {t && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Tile label="Đợt ra viện" value={t.ra_vien} />
          <Tile label="Tái nhập ≤ 30 ngày" value={t.tai_nhap_vien} tone={C.red} />
          <Tile label="Chưa đủ 30 ngày" value={t.chua_du_30_ngay} />
          <Tile label="Tỉ lệ tái nhập viện" value={t.ti_le_tai_nhap == null ? '—' : `${t.ti_le_tai_nhap}%`} />
        </div>
      )}
      {data && (data.rows.length ? (
        <Table head={['Ra viện', 'Trạng thái', 'Người bệnh', 'Khoa · chẩn đoán', 'Nhập lại']}>
          {data.rows.map(r => (
            <tr key={r.luot_id}>
              <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtTime(r.gio_ra)}</td>
              <td style={td}><Chip meta={NHAP[r.trang_thai]} /></td>
              <td style={td}><PatientCell row={r} onOpen={onOpen} /></td>
              <td style={td}>{r.khoa}{r.chan_doan_chinh && <span style={{ display: 'block', color: C.text2, fontSize: FS.xs }}>{r.chan_doan_chinh}</span>}</td>
              <td style={{ ...td, whiteSpace: 'nowrap' }}>
                {r.tai_nhap ? <>{fmtTime(r.tai_nhap.gio_vao)}<span style={{ display: 'block', color: C.text2, fontSize: FS.xs }}>sau {r.tai_nhap.so_ngay} ngày</span></> : '—'}
              </td>
            </tr>
          ))}
        </Table>
      ) : <Note>Không có đợt ra viện nào trong khoảng ngày này.</Note>)}
      <Note>{SCOPE_NOTE}</Note>
    </div>
  );
}

export default function PatientJourneyTab({ toast }) {
  const [view, setView] = useState('tim');
  const [open, setOpen] = useState('');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {!open && <Segmented label="Phần" value={view} onChange={setView} options={VIEWS} />}
      {open ? <Journey maBn={open} onBack={() => setOpen('')} toast={toast} /> : (
        <>
          {view === 'tim' && <SearchView onOpen={setOpen} toast={toast} />}
          {view === 'tai-kham' && <AppointmentView onOpen={setOpen} />}
          {view === 'tai-nhap' && <ReadmissionView onOpen={setOpen} />}
        </>
      )}
    </div>
  );
}
