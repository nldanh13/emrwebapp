// src/components/EmrStructureScanTab.jsx
// Bấm nút dò cấu trúc EMR hiện tại, so với danh mục trang/selector code đang dùng
// (config/hchanh/emr_structure_manifest.json). Chỉ đọc (GET qua EmrHttpSession),
// không tự sửa code — chỉ báo cáo để người dùng/người phát triển biết chỗ nào cần
// xem lại khi EMR đổi cấu trúc.

import { useState, useCallback } from 'react';
import { C } from '../tokens.js';
import { Btn, Spinner } from './shared.jsx';
import * as api from '../api.js';

function StatusDot({ status }) {
  const map = {
    ok:                   { color: C.green,  label: '✓ OK' },
    changed:              { color: C.red,    label: '✕ Đổi cấu trúc' },
    fetch_error:          { color: C.red,    label: '✕ Lỗi tải trang' },
    no_url:               { color: C.amber,  label: '! Không dựng được URL' },
    skipped_not_configured: { color: C.text3, label: '— Chưa cấu hình' },
    skipped_no_sample_patient: { color: C.amber, label: '! Không có BN mẫu' },
  };
  const info = map[status] || { color: C.text3, label: status || '—' };
  return <span style={{ color: info.color, fontWeight: 700, fontSize: 12 }}>{info.label}</span>;
}

function KnownPageRow({ page }) {
  const [open, setOpen] = useState(false);
  const hasDetail = (page.missing_fields?.length || 0) + (page.missing_tables?.length || 0) > 0;
  return (
    <div style={{ borderBottom: `1px solid ${C.border2}`, padding: '8px 12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, color: C.text, fontWeight: 600 }}>{page.label || page.page_key}</div>
          <div style={{ fontSize: 11, color: C.text3, marginTop: 1 }}>
            wpid={page.wpid || '—'} {page.field_ids_found_count != null && `· ${page.field_ids_found_count} field · ${page.tables_found_count} bảng`}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <StatusDot status={page.status} />
          {hasDetail && (
            <button type="button" onClick={() => setOpen(v => !v)} style={{
              background: 'none', border: `1px solid ${C.border}`, borderRadius: 4,
              padding: '2px 7px', cursor: 'pointer', fontSize: 11, color: C.text2, fontFamily: 'inherit',
            }}>{open ? 'Ẩn' : 'Xem chi tiết'}</button>
          )}
        </div>
      </div>
      {open && (
        <div style={{ marginTop: 6, fontSize: 12, color: C.red, background: C.redBg, border: `1px solid ${C.redBorder}`, borderRadius: 4, padding: '6px 10px' }}>
          {page.missing_fields?.length > 0 && <div>Thiếu field: {page.missing_fields.join(', ')}</div>}
          {page.missing_tables?.length > 0 && <div>Thiếu bảng: {page.missing_tables.join(', ')}</div>}
          {page.error && <div>Lỗi: {page.error}</div>}
        </div>
      )}
    </div>
  );
}

function DiscoveredPageRow({ page }) {
  return (
    <div style={{ borderBottom: `1px solid ${C.border2}`, padding: '8px 12px' }}>
      <div style={{ fontSize: 13, color: C.text, fontWeight: 600 }}>
        wpid={page.wpid} {page.status !== 'ok' && <span style={{ color: C.red, fontWeight: 700 }}> — lỗi</span>}
      </div>
      <div style={{ fontSize: 11, color: C.text3, marginTop: 1 }}>
        Link tìm thấy: “{page.link_text || '—'}”
      </div>
      {page.status === 'ok' && (
        <div style={{ fontSize: 11, color: C.text2, marginTop: 3 }}>
          {(page.field_ids || []).length} field · {(page.tables || []).length} bảng có id · {(page.dropdowns || []).length} dropdown
        </div>
      )}
      {page.error && <div style={{ fontSize: 11, color: C.red, marginTop: 3 }}>{page.error}</div>}
    </div>
  );
}

export default function EmrStructureScanTab() {
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');

  const runScan = useCallback(async () => {
    setRunning(true);
    setError('');
    try {
      const r = await api.runEmrStructureScan();
      if (r.status === 'ok') {
        setReport(r.report);
      } else {
        setError(r.message || 'Dò cấu trúc EMR thất bại.');
      }
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setRunning(false);
    }
  }, []);

  const summary = report?.summary;

  return (
    <div style={{ padding: 12, maxWidth: 980, margin: '0 auto' }}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>Kiểm tra cấu trúc EMR</div>
        <div style={{ fontSize: 12, color: C.text2, marginTop: 4 }}>
          Đăng nhập EMR (chỉ đọc), so các trang/field code đang dùng với danh mục đã biết
          (config/hchanh/emr_structure_manifest.json), và dò thêm trang mới qua liên kết.
          Không bấm/gửi form nào — chỉ tải trang để đọc cấu trúc. Không tự sửa code.
        </div>
      </div>

      <Btn variant="primary" onClick={runScan} disabled={running} style={{ marginBottom: 16 }}>
        {running ? <><Spinner size={11} /> Đang dò cấu trúc EMR...</> : '🔍 Dò cấu trúc EMR ngay'}
      </Btn>

      {error && (
        <div style={{ marginBottom: 16, padding: '8px 12px', background: C.redBg, border: `1px solid ${C.redBorder}`, borderRadius: 6, color: C.red, fontSize: 13 }}>
          {error}
        </div>
      )}

      {summary && (
        <>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            {[
              ['Trang đã biết', summary.known_pages_total, C.text2, C.surface2],
              ['Còn đúng', summary.known_pages_ok, C.green, C.greenBg],
              ['Đổi cấu trúc', summary.known_pages_changed, C.red, C.redBg],
              ['Lỗi tải', summary.known_pages_error, C.amber, C.amberBg],
              ['Trang mới tìm thấy', summary.discovered_pages_new, C.blue, C.blueBg],
            ].map(([label, value, color]) => (
              <div key={label} style={{ padding: '4px 16px 5px 0', borderRight: `1px solid ${C.border2}` }}>
                <div style={{ fontSize: 19, fontWeight: 800, color }}>{value ?? 0}</div>
                <div style={{ fontSize: 10, color: C.text3 }}>{label}</div>
              </div>
            ))}
          </div>

          {report.warning && (
            <div style={{ marginBottom: 16, padding: '8px 12px', background: C.amberBg, border: `1px solid ${C.amberBorder}`, borderRadius: 6, color: C.amber, fontSize: 12 }}>
              {report.warning}
              {report.inpatient_scan_diag && (
                <div style={{ marginTop: 4, color: C.text2 }}>
                  Nguồn danh sách: {report.inpatient_scan_diag.source === 'ajaxpro_fallback' ? 'AjaxPro (dự phòng)' : report.inpatient_scan_diag.source === 'none' ? 'không lấy được (kể cả AjaxPro)' : 'bảng HTML'}
                  {' · '}Số dòng đọc được: {report.inpatient_scan_diag.rows_parsed_count} · Số dòng dò được link BN: {report.inpatient_scan_diag.link_map_count}
                  {report.inpatient_scan_diag.sample_row_headers?.length > 0 && (
                    <> · Cột tìm thấy: {report.inpatient_scan_diag.sample_row_headers.join(', ')}</>
                  )}
                </div>
              )}
              {report.inpatient_scan_diag?.ajaxpro_error && (
                <div style={{ marginTop: 4, color: C.red }}>
                  Lỗi AjaxPro: {report.inpatient_scan_diag.ajaxpro_error}
                </div>
              )}
            </div>
          )}

          {!report.warning && report.inpatient_list_source === 'ajaxpro_fallback' && (
            <div style={{ marginBottom: 16, fontSize: 11, color: C.text3 }}>
              Danh sách nội trú lấy qua đường dự phòng AjaxPro (bảng HTML gốc trống/không thấy).
            </div>
          )}

          {report.known_gaps?.length > 0 && (
            <div style={{ marginBottom: 16, fontSize: 12, color: C.text3 }}>
              <b>Chưa kiểm được:</b> {report.known_gaps.join(' ')}
            </div>
          )}

          <div style={{ fontSize: 12, fontWeight: 700, color: C.text2, marginBottom: 6, marginTop: 10 }}>
            CÁC TRANG ĐÃ BIẾT
          </div>
          <div style={{ background: C.surface, borderTop: `1px solid ${C.border2}`, marginBottom: 20 }}>
            {(report.known_pages || []).map(p => <KnownPageRow key={p.page_key} page={p} />)}
          </div>

          {(report.discovered_pages || []).length > 0 && (
            <>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.text2, marginBottom: 6 }}>
                TRANG MỚI TÌM THẤY (chưa có trong danh mục — chỉ để biết, chưa tự dùng)
              </div>
              <div style={{ background: C.surface, borderTop: `1px solid ${C.border2}` }}>
                {report.discovered_pages.map(p => <DiscoveredPageRow key={p.wpid} page={p} />)}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
