// src/components/records/DischargeSignTab.jsx
// Chèn ảnh chữ ký đã cấu hình sẵn (tab Lịch điều dưỡng) vào bộ phiếu
// "IN RA VIỆN" đã in sẵn (nút In ở PatientDetail/ShiftTab) — không cần tải
// file lên tay. Chỉ chèn cho người đã có ảnh chữ ký; người khác giữ nguyên.
// Luôn tạo file mới (hậu tố _DA_KY.pdf), không đụng file gốc.

import { useState, useEffect, useCallback } from 'react';
import { C } from '../../tokens.js';
import { Btn, Spinner } from '../shared.jsx';
import * as api from '../../api.js';

function fmtBytes(n) {
  const num = Number(n) || 0;
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  return `${(num / 1024 / 1024).toFixed(2)} MB`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('vi-VN');
  } catch {
    return iso;
  }
}

function triggerBlobDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function DischargeSignTab({ toast }) {
  const [bundles, setBundles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [signing, setSigning] = useState('');
  const [downloading, setDownloading] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.listDischargeBundles();
      setBundles(Array.isArray(r.bundles) ? r.bundles : []);
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const handleSign = async (fileName) => {
    setSigning(fileName);
    try {
      const r = await api.signDischargeBundle(fileName);
      if (r.status !== 'ok') {
        toast?.(r.message || 'Không chèn được chữ ký.', 'error');
        return;
      }
      toast?.(r.message || `Đã chèn ${r.stamped_count} chữ ký.`, r.stamped_count > 0 ? 'ok' : 'warn');
      await load();
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setSigning('');
    }
  };

  const handleDownload = async (fileName) => {
    setDownloading(fileName);
    try {
      const blob = await api.downloadWard_DischargeBundle(fileName);
      triggerBlobDownload(blob, fileName);
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setDownloading('');
    }
  };

  return (
    <div style={{ padding: 12, maxWidth: 1080, margin: '0 auto' }}>
      <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>Chữ ký ra viện</div>
          <div style={{ fontSize: 12, color: C.text2, marginTop: 4 }}>
            Chèn ảnh chữ ký đã cấu hình (tab Lịch điều dưỡng) vào bộ phiếu "IN RA VIỆN" đã in sẵn — chỉ chèn cho người
            đã có ảnh chữ ký, người khác giữ nguyên. Luôn tạo file mới, không đụng file gốc chưa ký.
          </div>
        </div>
        <Btn variant="secondary" onClick={load} disabled={loading}>
          {loading ? <Spinner size={12} /> : '↻ Làm mới'}
        </Btn>
      </div>

      {loading ? (
        <div style={{ color: C.text2, display: 'flex', gap: 8, alignItems: 'center' }}>
          <Spinner /> Đang tải...
        </div>
      ) : !bundles.length ? (
        <div style={{ color: C.text3, padding: 20, textAlign: 'center' }}>
          Chưa có bộ phiếu "IN RA VIỆN" nào được in. Vào tab Xếp phòng/Nhập bệnh phòng, mở hồ sơ người bệnh
          đã ra viện và bấm "In ra viện" trước.
        </div>
      ) : (
        <div style={{ background: C.surface, borderTop: `1px solid ${C.border2}`, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: C.surface2 }}>
                {['Mã BN', 'Họ tên', 'Kích thước', 'Đã in lúc', 'Trạng thái', 'Tác vụ'].map(h => (
                  <th key={h} style={{
                    padding: '8px 12px', textAlign: 'left', fontSize: 11,
                    fontWeight: 700, color: C.text2, borderBottom: `1px solid ${C.border}`,
                    letterSpacing: 0.15, whiteSpace: 'nowrap',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bundles.map((b, i) => (
                <tr key={b.file_name} style={{ borderBottom: i < bundles.length - 1 ? `1px solid ${C.border2}` : 'none' }}>
                  <td style={{ padding: '10px 12px', fontSize: 13, color: C.text, fontWeight: 500 }}>{b.ma_bn || '—'}</td>
                  <td style={{ padding: '10px 12px', fontSize: 13, color: C.text }}>{b.ho_ten || '—'}</td>
                  <td style={{ padding: '10px 12px', fontSize: 12, color: C.text2 }}>{fmtBytes(b.size_bytes)}</td>
                  <td style={{ padding: '10px 12px', fontSize: 12, color: C.text2 }}>{fmtDate(b.created_at)}</td>
                  <td style={{ padding: '10px 12px', fontSize: 12 }}>
                    {b.signed
                      ? <span style={{ color: C.green, fontWeight: 600 }}>✓ Đã ký</span>
                      : <span style={{ color: C.text3 }}>Chưa ký</span>}
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <Btn
                        variant="default"
                        disabled={downloading === b.file_name}
                        onClick={() => handleDownload(b.file_name)}
                        style={{ fontSize: 11, padding: '2px 10px' }}
                      >
                        {downloading === b.file_name ? <Spinner size={10} /> : 'Tải file gốc'}
                      </Btn>
                      <Btn
                        variant="primary"
                        disabled={signing === b.file_name}
                        onClick={() => handleSign(b.file_name)}
                        style={{ fontSize: 11, padding: '2px 10px' }}
                      >
                        {signing === b.file_name ? <Spinner size={10} /> : (b.signed ? 'Ký lại' : 'Thêm chữ ký')}
                      </Btn>
                      {b.signed && b.signed_file_name && (
                        <Btn
                          variant="success"
                          disabled={downloading === b.signed_file_name}
                          onClick={() => handleDownload(b.signed_file_name)}
                          style={{ fontSize: 11, padding: '2px 10px' }}
                        >
                          {downloading === b.signed_file_name ? <Spinner size={10} /> : 'Tải bản đã ký'}
                        </Btn>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
