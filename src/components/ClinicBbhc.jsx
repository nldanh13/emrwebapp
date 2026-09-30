// src/components/ClinicBbhc.jsx — TH4: Sổ biên bản hội chẩn (SBBHC) cho ca chuyển viện hoặc có
// chụp CT / MRI. Bước 1 hệ thống đọc màn khám và soạn nháp theo mẫu của khoa; người dùng xem, sửa;
// bước 2 hệ thống lập trên EMR (Giấy tờ kèm theo → SBBHC → Hoàn tất) và gộp phiếu in thành 1 file.
import { useEffect, useMemo, useState } from 'react';
import { IconDownload, IconFileText, IconPencil } from '@tabler/icons-react';
import { C, FS } from '../tokens.js';
import { Btn } from './shared.jsx';
import * as api from '../api.js';

const FIELDS = [
  ['ThoiGianHoiChan', 'Ngày, giờ hội chẩn', 1],
  ['ThuKy', 'Thư ký', 1],
  ['HopTai', 'Địa điểm họp', 1],
  ['ChamSoc', 'Chăm sóc', 1],
  ['YeuCau', 'Nội dung yêu cầu hội chẩn', 2],
  ['HuongDieuTri', 'Phương pháp điều trị', 2],
  ['ChanDoanTuyenDuoi', 'Chẩn đoán (tuyến dưới, khoa khám bệnh)', 2],
  ['NguyenNhan', 'Chẩn đoán, nguyên nhân, tiên lượng', 2],
  ['TomTat', 'Tóm tắt tiền sử bệnh', 4],
  ['TinhTrang', 'Tình trạng lúc vào viện', 7],
  ['TomTatBenhAn', 'Tóm tắt diễn biến bệnh', 4],
  ['KetLuan', 'Kết luận', 3],
];
const REQUIRED = { ThoiGianHoiChan: 'Ngày giờ hội chẩn', YeuCau: 'Nội dung yêu cầu', ChanDoanTuyenDuoi: 'Chẩn đoán', HuongDieuTri: 'Phương pháp điều trị', ThuKy: 'Thư ký' };
const DT_RE = /^\d{1,2}:\d{2} \d{1,2}\/\d{1,2}\/\d{4}$/;

export function missingFields(f = {}) {
  const out = Object.entries(REQUIRED).filter(([k]) => !String(f[k] || '').trim()).map(([, label]) => label);
  if (String(f.ThoiGianHoiChan || '').trim() && !DT_RE.test(String(f.ThoiGianHoiChan).trim())) out.push('Giờ hội chẩn sai định dạng (HH:mm dd/mm/yyyy)');
  if (/^Chuyển viện\s*$/.test(String(f.YeuCau || '').trim())) out.push('Tên bệnh viện chuyển đến');
  return out;
}

const STATUS_COLOR = { done: C.green, exists: C.green, draft: C.text, error: C.red, session: C.amber };

function DraftEditor({ draft, fields, onChange, disabled }) {
  const missing = missingFields(fields);
  return (
    <details open={missing.length > 0} style={{ border: `1px solid ${C.border2}`, borderRadius: 6, padding: '6px 10px', background: C.surface }}>
      <summary style={{ cursor: 'pointer', fontSize: FS.sm, fontWeight: 600 }}>
        {draft.label}
        <span style={{ marginLeft: 8, fontWeight: 500, color: missing.length ? C.red : C.green }}>
          {missing.length ? `Còn thiếu: ${missing.join(', ')}` : 'Đủ thông tin'}
        </span>
      </summary>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 8, marginTop: 8 }}>
        {FIELDS.map(([key, label, rows]) => (
          <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: FS.xs, color: C.text2, fontWeight: 600 }}>
            {label}
            {rows === 1 ? (
              <input value={fields[key] || ''} disabled={disabled} onChange={e => onChange(key, e.target.value)}
                style={{ height: 30, padding: '0 8px', border: `1px solid ${REQUIRED[key] && !String(fields[key] || '').trim() ? C.red : C.border}`, borderRadius: 5, fontFamily: 'inherit', fontSize: FS.sm, color: C.text, background: C.surface }} />
            ) : (
              <textarea value={fields[key] || ''} rows={rows} disabled={disabled} onChange={e => onChange(key, e.target.value)}
                style={{ padding: 6, border: `1px solid ${REQUIRED[key] && !String(fields[key] || '').trim() ? C.red : C.border}`, borderRadius: 5, fontFamily: 'inherit', fontSize: FS.sm, color: C.text, background: C.surface, resize: 'vertical' }} />
            )}
          </label>
        ))}
      </div>
    </details>
  );
}

export default function ClinicBbhc({ monitor, toast, onChanged }) {
  const running = Boolean(monitor?.running);
  const busyEmr = Boolean(monitor?.action_running);
  const rows = useMemo(() => (monitor?.rows || []).filter(r => r.bbhc?.length), [monitor?.rows]);
  const [edits, setEdits] = useState({}); // `${khambenhid}:${key}` -> fields
  const [busy, setBusy] = useState('');

  // Nháp mới từ máy chủ thay nháp cũ chưa sửa.
  const serverDrafts = useMemo(() => {
    const out = {};
    for (const r of rows) for (const d of r.bbhc_state?.drafts || []) out[`${r.khambenhid}:${d.key}`] = d;
    return out;
  }, [rows]);
  useEffect(() => {
    setEdits(prev => Object.fromEntries(Object.entries(prev).filter(([k]) => serverDrafts[k])));
  }, [serverDrafts]);

  const fieldsOf = (id, d) => edits[`${id}:${d.key}`] || d.fields;
  const setField = (id, d, key, value) => setEdits(prev => ({ ...prev, [`${id}:${d.key}`]: { ...fieldsOf(id, d), [key]: value } }));

  const ready = rows.filter(r => r.bbhc_state?.status === 'draft' && r.bbhc_state.drafts?.length
    && r.bbhc_state.drafts.every(d => !missingFields(fieldsOf(r.khambenhid, d)).length));
  const formCount = ready.reduce((n, r) => n + r.bbhc_state.drafts.length, 0);

  const prepare = async () => {
    setBusy('prepare');
    try {
      const r = await api.prepareClinicBbhc();
      toast?.(r.message, 'info');
      onChanged?.();
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setBusy('');
    }
  };

  const run = async () => {
    if (!window.confirm(`Lập ${formCount} Sổ biên bản hội chẩn cho ${ready.length} người bệnh trên EMR?\n\nMỗi biên bản được thêm vào Giấy tờ kèm theo, điền đúng nội dung đang hiển thị rồi bấm Hoàn tất. Người đã có đủ SBBHC trên EMR sẽ được bỏ qua.`)) return;
    setBusy('run');
    try {
      const drafts = Object.fromEntries(ready.map(r => [r.khambenhid, r.bbhc_state.drafts.map(d => ({ key: d.key, label: d.label, fields: fieldsOf(r.khambenhid, d) }))]));
      const r = await api.runClinicBbhc(drafts);
      toast?.(r.message, 'info');
      onChanged?.();
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setBusy('');
    }
  };

  const download = async () => {
    try {
      const { blob, filename } = await api.downloadClinicBbhcPdf();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    }
  };

  if (!rows.length && !monitor?.bbhc_pdf) return null;

  return (
    <section style={{ border: `1px solid ${C.border2}`, borderRadius: 8, background: C.surface, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 280px' }}>
          <div style={{ fontSize: FS.md, fontWeight: 700 }}>Sổ biên bản hội chẩn · {rows.length} người bệnh</div>
          <div style={{ fontSize: FS.sm, color: C.text2 }}>Ca chuyển viện hoặc có chụp CT / MRI (BHYT). Mỗi chỉ định chụp và việc chuyển viện là 1 biên bản.</div>
        </div>
        <Btn icon={IconPencil} loading={busy === 'prepare'} disabled={!running || !rows.length || busyEmr || Boolean(busy)} onClick={prepare}>Soạn nháp SBBHC</Btn>
        <Btn variant="primary" icon={IconFileText} loading={busy === 'run'} disabled={!running || !formCount || busyEmr || Boolean(busy)} onClick={run}>
          {`Lập ${formCount} SBBHC`}
        </Btn>
        {monitor?.bbhc_pdf && (
          <Btn icon={IconDownload} onClick={download}>{`Tải file in gộp (${monitor.bbhc_pdf.count})`}</Btn>
        )}
      </div>
      {rows.map(r => {
        const st = r.bbhc_state;
        return (
          <div key={r.khambenhid} style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 8, borderTop: `1px solid ${C.border2}` }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline', fontSize: FS.sm }}>
              <b>{r.ho_ten}</b>
              <span style={{ color: C.text2 }}>{r.ma_bn}</span>
              <span style={{ color: C.amber, fontWeight: 600 }}>{r.bbhc.join(', ')}</span>
              <span style={{ color: STATUS_COLOR[st?.status] || C.text3 }}>{st ? st.message : 'Chưa soạn nháp'}</span>
            </div>
            {(st?.drafts || []).map(d => (
              <DraftEditor key={d.key} draft={d} fields={fieldsOf(r.khambenhid, d)} disabled={busy === 'run' || busyEmr}
                onChange={(key, value) => setField(r.khambenhid, d, key, value)} />
            ))}
          </div>
        );
      })}
    </section>
  );
}
