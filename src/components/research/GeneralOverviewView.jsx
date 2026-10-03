// Dữ liệu tổng quát của kho gốc: số lượng, độ đầy đủ và danh sách người bệnh.
import { C, FS } from '../../tokens.js';
import { compactNumber } from './researchFormat.js';
import { inp, EmptyState, StatBadge } from './researchUi.jsx';
import { Btn, Spinner } from '../shared.jsx';

export function GeneralOverviewView({
  filters, generalOverview, generalOverviewLoading, generalOverviewMissingOnly,
  generalOverviewQuery, loadPatientHistory, overviewRows, setArchiveMode, setFilters,
  setGeneralOverviewMissingOnly, setGeneralOverviewQuery, setPatientQuery,
}) {
  const ov = generalOverview;
  const summary = ov?.statusSummary || { total: 0, ready: 0, missingCount: 0, manualReview: 0, modules: [] };
  const counts = ov?.counts || {};
  const showIdentity = !filters.hideSensitive;
  // Gợi ý việc nên làm tiếp, để người mới không phải đoán bắt đầu từ đâu.
  const anyCollected = (summary.modules || []).some(part => Number(part.done || 0) > 0);
  const nextStep = !ov && !generalOverviewLoading
    ? { title: 'Kho chưa có dữ liệu', hint: 'Bắt đầu bằng việc quét danh sách người bệnh trên EMR.', action: 'Đi tới Thu thập dữ liệu', mode: 'update' }
    : ov && Number(summary.total || 0) > 0 && !anyCollected
      ? { title: 'Mới có danh sách, chưa có dữ liệu chi tiết', hint: `Đã có ${compactNumber(summary.total)} lượt điều trị nhưng chưa lấy xét nghiệm, CĐHA, hồ sơ... Hãy chạy Thu thập tự động.`, action: 'Đi tới Thu thập dữ liệu', mode: 'update' }
      : null;
  const overviewCard = (label, value, sub = '') => (
    <div style={{ padding: '5px 14px 6px 0', minWidth: 120, borderRight: `1px solid ${C.border2}` }}>
      <div style={{ fontSize: FS.xs, color: C.text3, fontWeight: 700 }}>{label}</div>
      <div style={{ marginTop: 1, fontSize: FS.stat, lineHeight: 1.1, color: C.text, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{compactNumber(value || 0)}</div>
      {sub && <div style={{ marginTop: 2, fontSize: FS.xs, color: C.text3 }}>{sub}</div>}
    </div>
  );
  const miniStatus = (label, done, total) => {
    const pct = total ? Math.round(Number(done || 0) * 100 / Number(total || 1)) : 0;
    return (
      <div key={label} style={{ background: 'transparent', padding: '6px 0 7px', minWidth: 145 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontSize: FS.xs, color: C.text, fontWeight: 700 }}>{label}</span>
          <span style={{ fontSize: FS.xs, color: pct >= 95 ? C.green : pct >= 70 ? C.blue : C.amber, fontWeight: 700 }}>{pct}%</span>
        </div>
        <div style={{ height: 4, marginTop: 7, background: C.surface2, borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${Math.max(0, Math.min(100, pct))}%`, background: pct >= 95 ? C.green : pct >= 70 ? C.blue : C.amber }} />
        </div>
        <div style={{ marginTop: 5, fontSize: FS.xs, color: C.text3 }}>{compactNumber(done)}/{compactNumber(total)} lượt đã đủ</div>
      </div>
    );
  };

  return (
    <div style={{ padding: '8px 12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ background: C.surface, padding: '4px 0 10px', borderBottom: `1px solid ${C.border2}` }}>
        <div style={{ fontSize: FS.xs, color: C.text3 }}>
          Đọc từ dữ liệu đã thu thập, không mở EMR.
          {ov?.date_from || ov?.date_to ? ` Khoảng dữ liệu: ${ov?.date_from || '—'} → ${ov?.date_to || '—'}.` : ''}
        </div>

        {nextStep && (
          <div style={{ marginTop: 10, padding: '9px 12px', borderRadius: 7, border: `1px solid ${C.blueBorder}`, background: C.blueBg, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 260px' }}>
              <div style={{ fontSize: FS.sm, fontWeight: 700, color: C.text }}>{nextStep.title}</div>
              <div style={{ marginTop: 2, fontSize: FS.xs, color: C.text2 }}>{nextStep.hint}</div>
            </div>
            <Btn variant="solidPrimary" onClick={() => setArchiveMode(nextStep.mode)} style={{ height: 30 }}>{nextStep.action}</Btn>
          </div>
        )}

        {!ov && generalOverviewLoading && (
          <div style={{ padding: '22px 0 8px', color: C.text2 }}><Spinner size={12} /> Đang tổng hợp dữ liệu...</div>
        )}
        {!ov && !generalOverviewLoading && (
          <EmptyState title="Chưa có dữ liệu tổng quát" hint="Sau khi quét danh sách và thu thập dữ liệu, số liệu sẽ hiện ở đây." />
        )}

        {ov && (
          <>
            <div style={{ display: 'flex', alignItems: 'stretch', gap: 14, flexWrap: 'wrap', marginTop: 10 }}>
              {overviewCard('Người bệnh', counts.patients, 'BN trong kho')}
              {overviewCard('Đợt điều trị', counts.encounters, 'lượt nhập viện')}
              {overviewCard('Xét nghiệm', counts.labs, 'kết quả')}
              {overviewCard('CĐHA', counts.imaging, 'kết quả')}
              {overviewCard('Dataset phân tích', counts.final_rows, 'dòng sẵn sàng')}
            </div>

            <div style={{ marginTop: 10 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap', marginBottom: 6 }}>
                <div style={{ fontSize: FS.sm, fontWeight: 700, color: C.text }}>Mức độ đầy đủ</div>
                <div style={{ fontSize: FS.xs, color: C.text3 }}>
                  trên {compactNumber(summary.total || 0)} lượt điều trị{generalOverview?.run_id ? ` · đợt ${generalOverview.run_id}` : ''}
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', columnGap: 18, rowGap: 2 }}>
                {(summary.modules || []).map(part => miniStatus(part.label, part.done, summary.total))}
              </div>
            </div>

            <div style={{ marginTop: 9, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <StatBadge label="Đủ dữ liệu" value={summary.counts?.done || summary.ready || 0} tone="ok" />
              <StatBadge label="Còn thiếu" value={summary.missingCount || 0} tone={(summary.missingCount || 0) ? 'warn' : 'neutral'} />
              <StatBadge label="Lỗi" value={summary.counts?.error || 0} tone={(summary.counts?.error || 0) ? 'danger' : 'neutral'} />
              <StatBadge label="Cần xem tay" value={summary.manualReview || 0} tone={(summary.manualReview || 0) ? 'danger' : 'neutral'} />
              {ov.limited && <span style={{ fontSize: FS.xs, color: C.amber }}>Một số bảng lớn chỉ tải phần hiển thị; số tổng lấy từ metadata.</span>}
            </div>
          </>
        )}
      </div>

      {ov && (
        <div style={{ background: C.surface, borderTop: `1px solid ${C.border2}`, overflow: 'hidden' }}>
          <div style={{ padding: '8px 9px', borderBottom: `1px solid ${C.border2}`, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            <div style={{ fontSize: FS.sm, fontWeight: 700, color: C.text, marginRight: 5 }}>
              {ov.row_kind === 'monitor' ? 'Danh sách lượt đang theo dõi' : ov.row_kind === 'encounter' ? 'Danh sách đợt điều trị' : 'Danh sách người bệnh trong kho'}
            </div>
            <input
              value={generalOverviewQuery}
              onChange={e => setGeneralOverviewQuery(e.target.value)}
              placeholder="Tìm mã NC, mã BN, họ tên, chẩn đoán..."
              style={{ ...inp, flex: '1 1 260px' }}
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: FS.xs, color: C.text2, whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={generalOverviewMissingOnly} onChange={e => setGeneralOverviewMissingOnly(e.target.checked)} />
              Chỉ xem còn thiếu/lỗi
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: FS.xs, color: C.text2, whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={filters.hideSensitive}
                onChange={e => setFilters(p => ({ ...p, hideSensitive: e.target.checked }))} />
              Ẩn định danh
            </label>
            <span style={{ fontSize: FS.xs, color: C.text3 }}>{compactNumber(overviewRows.length)}/{compactNumber(ov.rows?.length || 0)} {ov.row_unit || 'lượt'}</span>
          </div>

          <div style={{ maxHeight: 'calc(100vh - 430px)', overflow: 'auto' }}>
            {!overviewRows.length && <EmptyState title="Không có người bệnh phù hợp" hint="Thử bỏ bộ lọc hoặc tắt “Chỉ xem còn thiếu/lỗi”." />}
            {!!overviewRows.length && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: FS.xs, tableLayout: 'fixed' }}>
                <thead style={{ position: 'sticky', top: 0, background: C.surface2, zIndex: 2 }}>
                  <tr>
                    {[
                      ['Mã NC', 90], ...(showIdentity ? [['Mã BN', 90], ['Họ tên', 170]] : []), ['Ngày vào', 85], ['Ngày ra', 85],
                      ['Chẩn đoán', 260], ['XN', 52], ['CĐHA', 52], ['PT/TT', 52], ['Y lệnh', 60], ['Trạng thái', 120],
                    ].map(([label, width]) => (
                      <th key={label} style={{ width, textAlign: 'left', padding: '7px 8px', borderBottom: `1px solid ${C.border}`, color: C.text2, fontSize: FS.xs, fontWeight: 700 }}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {overviewRows.slice(0, 1000).map(row => {
                    const q = row.patient_code || row.research_code || row.patient_name;
                    return (
                      <tr key={row.key}
                        onClick={() => {
                          if (!q) return;
                          setPatientQuery(q);
                          setArchiveMode('patient');
                          loadPatientHistory(q);
                        }}
                        title={q ? 'Bấm để xem toàn bộ quá trình điều trị' : ''}
                        style={{ borderBottom: `1px solid ${C.border2}`, cursor: q ? 'pointer' : 'default' }}
                        onMouseEnter={e => { if (q) e.currentTarget.style.background = C.surface2; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                      >
                        <td style={{ padding: '7px 8px', color: C.blue, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.research_code || '—'}</td>
                        {showIdentity && <td style={{ padding: '7px 8px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.patient_code || '—'}</td>}
                        {showIdentity && <td style={{ padding: '7px 8px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.patient_name || '—'}</td>}
                        <td style={{ padding: '7px 8px' }}>{row.admission_date || '—'}</td>
                        <td style={{ padding: '7px 8px' }}>{row.discharge_date || '—'}</td>
                        <td style={{ padding: '7px 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.diagnosis}>{row.diagnosis || '—'}</td>
                        <td style={{ padding: '7px 8px' }}>{row.lab_count ? compactNumber(row.lab_count) : (row.xn_done ? '✓' : '—')}</td>
                        <td style={{ padding: '7px 8px' }}>{row.imaging_count ? compactNumber(row.imaging_count) : (row.cdha_done ? '✓' : '—')}</td>
                        <td style={{ padding: '7px 8px' }}>{row.surgery_count ? compactNumber(row.surgery_count) : (row.surgery_done ? '✓' : '—')}</td>
                        <td style={{ padding: '7px 8px' }}>{row.medication_count ? compactNumber(row.medication_count) : (row.order_done ? '✓' : '—')}</td>
                        <td style={{ padding: '7px 8px' }}>
                          <span style={{
                            display: 'inline-flex', alignItems: 'center', height: 20, padding: '0 6px', borderRadius: 4,
                            fontSize: FS.xs, fontWeight: 700,
                            color: row.status_tone === 'ok' ? C.green : row.status_tone === 'danger' ? C.red : row.status_tone === 'warn' ? C.amber : C.text3,
                            background: C.surface2, border: `1px solid ${C.border2}`,
                          }}>{row.status_label}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          {overviewRows.length > 1000 && (
            <div style={{ padding: '7px 10px', fontSize: FS.xs, color: C.text3, borderTop: `1px solid ${C.border2}` }}>
              Hiển thị 1.000 người bệnh đầu tiên sau lọc.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
