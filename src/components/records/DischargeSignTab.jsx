// src/components/records/DischargeSignTab.jsx
// Chèn ảnh chữ ký đã cấu hình sẵn (tab Lịch điều dưỡng) vào bộ phiếu
// "IN RA VIỆN" đã in sẵn (nút In ở PatientDetail/ShiftTab) — không cần tải
// file lên tay. Chỉ chèn cho người đã có ảnh chữ ký; người khác giữ nguyên.
// Luôn tạo file mới (hậu tố _DA_KY.pdf), không đụng file gốc.

import { useState, useEffect, useCallback, useRef } from 'react';
import { IconCheck, IconRefresh, IconUpload } from '@tabler/icons-react';
import { C, FS } from '../../tokens.js';
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

const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Không đọc được file.'));
    reader.readAsDataURL(file);
  });
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
  const [uploading, setUploading] = useState(false);
  const uploadInputRef = useRef(null);

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

  const signFile = async (fileName) => {
    const r = await api.signDischargeBundle(fileName);
    if (r.status !== 'ok') {
      toast?.(r.message || 'Không chèn được chữ ký.', 'error');
      return null;
    }
    toast?.(r.message || `Đã chèn ${r.stamped_count} chữ ký.`, r.stamped_count > 0 ? 'ok' : 'warn');
    return r;
  };

  const handleSign = async (fileName) => {
    setSigning(fileName);
    try {
      await signFile(fileName);
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

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!/\.pdf$/i.test(file.name)) { toast?.('Chỉ nhận file PDF (.pdf).', 'error'); return; }
    if (file.size > MAX_UPLOAD_BYTES) { toast?.('File PDF quá lớn (tối đa 30MB).', 'error'); return; }
    setUploading(true);
    try {
      const up = await api.uploadDischargePdf(file.name, await readFileAsDataUrl(file));
      if (up.status !== 'ok') { toast?.(up.message || 'Không tải được file lên.', 'error'); return; }
      const signed = await signFile(up.file_name);
      await load();
      if (signed?.stamped_count > 0) await handleDownload(signed.signed_file_name);
    } catch (err) {
      toast?.(String(err.message || err), 'error');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div style={{ padding: 12, maxWidth: 1080, margin: '0 auto' }}>
      <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <p style={{ margin: 0, flex: '1 1 320px', fontSize: FS.sm, color: C.text2, lineHeight: 1.5 }}>
          Chèn ảnh chữ ký đã cấu hình (ở Lịch điều dưỡng) vào bộ phiếu "In ra viện" đã in sẵn, hoặc vào file PDF
          anh/chị tự tải lên. Chỉ chèn cho người đã có ảnh chữ ký, người khác giữ nguyên. Luôn tạo file mới, không
          đụng file gốc chưa ký.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Btn variant="primary" icon={IconUpload} loading={uploading} disabled={uploading} onClick={() => uploadInputRef.current?.click()}>
            {uploading ? 'Đang tải lên và ký…' : 'Tải PDF lên để ký'}
          </Btn>
          <Btn icon={IconRefresh} loading={loading} onClick={load} disabled={loading}>Làm mới</Btn>
        </div>
        <input ref={uploadInputRef} type="file" accept="application/pdf,.pdf" onChange={handleUpload} hidden />
      </div>

      {loading ? (
        <div style={{ color: C.text2, display: 'flex', gap: 8, alignItems: 'center' }}>
          <Spinner /> Đang tải...
        </div>
      ) : !bundles.length ? (
        <div style={{ color: C.text2, fontSize: FS.md, padding: 24, textAlign: 'center', background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 7 }}>
          Chưa có bộ phiếu "In ra viện" nào. Bấm "Tải PDF lên để ký" để ký file có sẵn, hoặc vào tab Xếp
          phòng/Nhập bệnh phòng, mở hồ sơ người bệnh đã ra viện và bấm "In ra viện" trước.
        </div>
      ) : (
        <div style={{ background: C.surface, borderTop: `1px solid ${C.border2}`, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: C.surface2 }}>
                {['Mã BN', 'Họ tên / tên file', 'Kích thước', 'Thời gian', 'Trạng thái', 'Tác vụ'].map(h => (
                  <th key={h} style={{
                    padding: '8px 12px', textAlign: 'left', fontSize: FS.xs,
                    fontWeight: 700, color: C.text2, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bundles.map((b, i) => (
                <tr key={b.file_name} style={{ borderBottom: i < bundles.length - 1 ? `1px solid ${C.border2}` : 'none' }}>
                  <td style={{ padding: '10px 12px', fontSize: FS.md, color: C.text, fontWeight: 500 }}>{b.uploaded ? <span style={{ fontSize: FS.xs, color: C.text2, fontWeight: 600 }}>Tải lên</span> : (b.ma_bn || '—')}</td>
                  <td style={{ padding: '10px 12px', fontSize: FS.md, color: C.text }}>{b.ho_ten || '—'}</td>
                  <td style={{ padding: '10px 12px', fontSize: FS.sm, color: C.text2 }}>{fmtBytes(b.size_bytes)}</td>
                  <td style={{ padding: '10px 12px', fontSize: FS.sm, color: C.text2 }}>{fmtDate(b.created_at)}</td>
                  <td style={{ padding: '10px 12px', fontSize: FS.sm }}>
                    {b.signed
                      ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: C.green, fontWeight: 600 }}><IconCheck size={15} stroke={2.2} aria-hidden="true" />Đã ký</span>
                      : <span style={{ color: C.text3 }}>Chưa ký</span>}
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <Btn
                        variant="default"
                        disabled={downloading === b.file_name}
                        onClick={() => handleDownload(b.file_name)}
                        style={{ fontSize: FS.xs, padding: '2px 10px' }}
                      >
                        {downloading === b.file_name ? <Spinner size={10} /> : 'Tải file gốc'}
                      </Btn>
                      <Btn
                        variant="primary"
                        disabled={signing === b.file_name}
                        onClick={() => handleSign(b.file_name)}
                        style={{ fontSize: FS.xs, padding: '2px 10px' }}
                      >
                        {signing === b.file_name ? <Spinner size={10} /> : (b.signed ? 'Ký lại' : 'Thêm chữ ký')}
                      </Btn>
                      {b.signed && b.signed_file_name && (
                        <Btn
                          variant="success"
                          disabled={downloading === b.signed_file_name}
                          onClick={() => handleDownload(b.signed_file_name)}
                          style={{ fontSize: FS.xs, padding: '2px 10px' }}
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
