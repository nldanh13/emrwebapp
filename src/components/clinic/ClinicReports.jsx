// src/components/clinic/ClinicReports.jsx — In tường trình thủ thuật / phẫu thuật của người bệnh BHYT trong ngày
// đang xem: hệ thống mở từng phiếu trên EMR (chỉ đọc), lấy file PDF và gộp thành 1 file để tải về in.
import { useMemo, useState } from 'react';
import { IconDownload, IconPrinter } from '@tabler/icons-react';
import { C, FS } from '../../tokens.js';
import { Btn } from '../shared.jsx';
import * as api from '../../api.js';
import { reportPatients } from './clinicBoard.js';

export default function ClinicReports({ monitor, rows, toast, onChanged }) {
  const [busy, setBusy] = useState('');
  const patients = useMemo(() => reportPatients(rows), [rows]);
  const info = monitor?.tuongtrinh_pdf;
  const running = Boolean(monitor?.running);
  const actionRunning = Boolean(monitor?.action_running);
  if (!patients.length && !info) return null;

  const run = async () => {
    if (!window.confirm(`Lấy phiếu tường trình thủ thuật, phẫu thuật của ${patients.length} người bệnh BHYT trên EMR?\n\nHệ thống mở từng phiếu đã hoàn tất, bấm In và lấy file PDF, không sửa gì trên EMR. Phiếu đã lấy lần trước thì dùng lại. Xong sẽ có nút tải file gộp.`)) return;
    setBusy('run');
    try {
      const r = await api.printClinicReports();
      if (r.status !== 'ok') throw new Error(r.message);
      toast?.(r.message, 'info');
      await onChanged?.();
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setBusy('');
    }
  };

  const download = async () => {
    try {
      const { blob, filename } = await api.downloadClinicReportsPdf();
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

  return (
    <section style={{ border: `1px solid ${C.border2}`, borderRadius: 8, background: C.surface, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px' }}>
          <div style={{ fontSize: FS.md, fontWeight: 700 }}>In tường trình BHYT · {patients.length} người bệnh</div>
          <div style={{ fontSize: FS.sm, color: C.text2 }}>Phiếu kết quả thủ thuật và phiếu phẫu thuật đã hoàn tất, gộp thành 1 file PDF.</div>
        </div>
        <Btn variant="primary" icon={IconPrinter} loading={busy === 'run'} disabled={!running || !patients.length || actionRunning || Boolean(busy)} onClick={run}>
          {actionRunning ? 'Đang thao tác trên EMR…' : 'In tường trình BHYT'}
        </Btn>
        {info?.file && <Btn icon={IconDownload} onClick={download}>{`Tải file in gộp (${info.count} phiếu)`}</Btn>}
      </div>
      {info?.message && <div style={{ fontSize: FS.sm, color: C.text2 }}>{info.message}</div>}
      {(info?.problems || []).map(p => (
        <div key={p.ma_bn} style={{ fontSize: FS.sm, borderTop: `1px solid ${C.border2}`, paddingTop: 6 }}>
          <b>{p.ho_ten}</b> <span style={{ color: C.text2 }}>{p.ma_bn}</span>
          <div style={{ color: C.amber }}>{p.message}</div>
        </div>
      ))}
    </section>
  );
}
