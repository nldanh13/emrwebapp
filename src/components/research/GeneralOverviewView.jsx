// Tổng quan kho dữ liệu gốc: các số liệu chính và những vấn đề cần xử lý.
import { C, FS } from '../../tokens.js';
import { compactNumber } from './researchFormat.js';
import { EmptyState, StatBadge } from './researchUi.jsx';
import { Btn } from '../shared.jsx';
import { SkeletonBlock, SkeletonLines } from '../Skeleton.jsx';
import { normalizeSchemaOutdated } from './normalizePresentation.js';

const card = { border: `1px solid ${C.border2}`, borderRadius: 8, background: C.surface, padding: '12px 14px' };

function Stat({ label, value, sub }) {
  return (
    <div style={{ padding: '4px 16px 6px 0', minWidth: 120, borderRight: `1px solid ${C.border2}` }}>
      <div style={{ fontSize: FS.xs, color: C.text3, fontWeight: 600 }}>{label}</div>
      <div style={{ marginTop: 1, fontSize: FS.stat, lineHeight: 1.15, color: C.text, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{compactNumber(value || 0)}</div>
      {sub && <div style={{ marginTop: 2, fontSize: FS.xs, color: C.text3 }}>{sub}</div>}
    </div>
  );
}

function QualityNotice({ pipeline, onNormalize, normalizeBusy = false, setArchiveMode }) {
  const normalize = pipeline?.normalize || {};
  const qa = normalize.qa || {};
  const blocking = Number(qa.blocking || 0);
  const warning = Number(qa.warning || 0);
  const review = Number(qa.review || 0);
  const blockingItems = Array.isArray(qa.blocking_items) ? qa.blocking_items.slice(0, 4) : [];
  const matchQuality = qa.matching_quality || null;
  const schemaOutdated = Boolean(
    normalize.schema_outdated
    || normalizeSchemaOutdated(normalize.schema_version, normalize.expected_schema_version)
  );
  if (!blocking && !schemaOutdated) return null;

  return (
    <section role="status" style={{
      ...card, borderColor: blocking ? C.redBorder : C.amberBorder,
      background: blocking ? C.redBg : C.amberBg, display: 'flex', alignItems: 'center',
      gap: 10, flexWrap: 'wrap',
    }}>
      <div style={{ flex: '1 1 260px', minWidth: 0 }}>
        <div style={{ fontSize: FS.sm, fontWeight: 700, color: blocking ? C.red : C.text }}>
          {blocking ? 'Dữ liệu đang có lỗi cần xử lý' : 'Cần cập nhật cấu trúc dữ liệu'}
        </div>
        <div style={{ marginTop: 3, fontSize: FS.xs, color: C.text2 }}>
          {blocking ? `${compactNumber(blocking)} lỗi đang chặn dữ liệu phân tích.` : 'Cấu trúc chuẩn hóa đã thay đổi; cần chạy chuẩn hóa lại.'}
          {warning ? ` Có ${compactNumber(warning)} cảnh báo.` : ''}
          {review ? ` Có ${compactNumber(review)} mục cần xem lại.` : ''}
        </div>
        {blockingItems.length > 0 && (
          <div style={{ marginTop: 7, fontSize: FS.xs, color: C.text2 }}>
            <b style={{ color: C.text }}>Lỗi chặn phải xử lý trước khi tạo dataset</b>
            <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
              {blockingItems.map((item, index) => (
                <li key={item.code || index}>
                  {item.code && <code>{item.code}</code>}{item.code && item.message ? ' · ' : ''}{item.message || ''}
                  {item.count != null ? ` · ${compactNumber(item.count)} dòng` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}
        {matchQuality && (
          <div style={{ marginTop: 5, fontSize: FS.xs, color: C.text2 }}>
            <b style={{ color: C.text }}>Vì sao chưa ghép được:</b>{' '}
            {compactNumber(matchQuality.identity_conflict || 0)} xung đột định danh, {compactNumber(matchQuality.missing || 0)} dòng chưa khớp.
          </div>
        )}
      </div>
      <Btn onClick={() => setArchiveMode('update')} style={{ height: 30 }}>Đi tới đánh giá dữ liệu</Btn>
      {schemaOutdated && <Btn variant="solidPrimary" onClick={onNormalize} disabled={normalizeBusy} loading={normalizeBusy} style={{ height: 30 }}>Chạy lại chuẩn hóa</Btn>}
    </section>
  );
}

export function GeneralOverviewView({ generalOverview, generalOverviewLoading, pipeline, collectionScreen = null, setArchiveMode, onNormalize, normalizeBusy = false }) {
  const ov = generalOverview;
  const legacySummary = ov?.statusSummary || { total: 0, ready: 0, missingCount: 0, manualReview: 0, modules: [] };
  const collectionCounts = collectionScreen?.counts || null;
  const collectionUserCounts = collectionScreen?.user_counts || null;
  const summary = collectionScreen ? {
    total: Number(collectionScreen.total || 0),
    ready: Number(collectionUserCounts?.ready ?? collectionCounts?.done ?? 0),
    missingCount: Number(collectionUserCounts?.automatic ?? ((collectionCounts?.missing || 0) + (collectionCounts?.error || 0))),
    counts: collectionCounts,
    user_counts: collectionUserCounts || {
      ready: Number(collectionCounts?.done || 0),
      automatic: Number(collectionCounts?.missing || 0) + Number(collectionCounts?.error || 0),
      manual: Number(collectionCounts?.waiting || 0) + Number(collectionCounts?.unmatched || 0),
    },
    modules: (collectionScreen.parts || []).map(part => ({ ...part, total: Number(part.total || 0), done: Number(part.done || 0) })),
  } : legacySummary;
  const counts = ov?.counts || {};
  const rawSummaryCounts = summary.counts || {};
  const userCounts = summary.user_counts || {
    ready: Number(rawSummaryCounts.done ?? summary.ready ?? 0),
    automatic: Number(rawSummaryCounts.missing || 0) + Number(rawSummaryCounts.error || 0) || Number(summary.missingCount || 0),
    manual: Number(rawSummaryCounts.waiting || 0) + Number(rawSummaryCounts.unmatched || 0),
  };
  const anyCollected = (summary.modules || []).some(part => Number(part.done || 0) > 0);
  const nextStep = !ov && !generalOverviewLoading
    ? { title: 'Kho chưa có dữ liệu', hint: 'Bắt đầu bằng việc quét danh sách người bệnh trên EMR.' }
    : ov && Number(summary.total || 0) > 0 && !anyCollected
      ? { title: 'Mới có danh sách, chưa có dữ liệu chi tiết', hint: `Đã có ${compactNumber(summary.total)} lượt điều trị nhưng chưa lấy xét nghiệm, CĐHA, hồ sơ. Hãy bắt đầu thu thập dữ liệu.` }
      : null;

  return (
    <div style={{ padding: '10px 12px 16px', display: 'grid', gap: 12 }}>
      {nextStep && (
        <section style={{ ...card, borderColor: C.blueBorder, background: C.blueBg, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 260px' }}>
            <div style={{ fontSize: FS.sm, fontWeight: 700, color: C.text }}>{nextStep.title}</div>
            <div style={{ marginTop: 2, fontSize: FS.xs, color: C.text2 }}>{nextStep.hint}</div>
          </div>
          <Btn variant="solidPrimary" onClick={() => setArchiveMode('update')} style={{ height: 30 }}>Đi tới Thu thập dữ liệu</Btn>
        </section>
      )}

      {!ov && generalOverviewLoading && (
        <div style={{ ...card, display: 'grid', gap: 10 }} aria-busy="true" aria-label="Đang tổng hợp số liệu">
          <SkeletonBlock width={180} height={16} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
            {[0, 1, 2, 3].map(i => <SkeletonBlock key={i} height={54} />)}
          </div>
          <SkeletonLines lines={4} />
        </div>
      )}
      {!ov && !generalOverviewLoading && !nextStep && <div style={card}><EmptyState title="Chưa có số liệu" hint="Sau khi quét danh sách và thu thập dữ liệu, số liệu sẽ hiện ở đây." /></div>}

      {ov && (
        <section style={card}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <span style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>Số liệu kho</span>
            <span style={{ fontSize: FS.xs, color: C.text3 }}>
              Dữ liệu đã lưu{ov.date_from || ov.date_to ? ` · ${ov.date_from || '—'} → ${ov.date_to || '—'}` : ''}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <Stat label="Người bệnh" value={counts.patients} sub="BN trong kho" />
            <Stat label="Đợt điều trị" value={counts.encounters} sub="lượt nhập viện" />
            <Stat label="Xét nghiệm" value={counts.labs} sub="kết quả" />
            <Stat label="CĐHA" value={counts.imaging} sub="kết quả" />
            <Stat label="Dataset phân tích" value={counts.final_rows} sub="dòng sẵn sàng" />
          </div>
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: FS.xs, fontWeight: 700, color: C.text }}>Theo lượt điều trị:</span>
            <StatBadge label="Sẵn sàng" value={userCounts.ready} tone="ok" />
            <StatBadge label="Đang xử lý" value={userCounts.automatic} tone={Number(userCounts.automatic || 0) ? 'info' : 'neutral'} />
            <StatBadge label="Cần kiểm tra" value={userCounts.manual} tone={Number(userCounts.manual || 0) ? 'danger' : 'neutral'} />
            {ov.limited && <span style={{ fontSize: FS.xs, color: C.amber }}>Một số số đếm lấy từ tổng hợp.</span>}
          </div>
          {collectionScreen && Number(counts.encounters || 0) !== Number(collectionScreen.total || 0) && (
            <div style={{ marginTop: 5, fontSize: FS.xs, color: C.text3 }}>
              Bảng chuẩn có {compactNumber(counts.encounters || 0)} lượt; sổ thu thập theo dõi {compactNumber(collectionScreen.total || 0)} lượt. Chênh lệch được giữ riêng để tránh gộp lượt chưa ghép hoặc chưa đồng bộ.
            </div>
          )}
        </section>
      )}

      <QualityNotice pipeline={pipeline} setArchiveMode={setArchiveMode} onNormalize={onNormalize} normalizeBusy={normalizeBusy} />
    </div>
  );
}
