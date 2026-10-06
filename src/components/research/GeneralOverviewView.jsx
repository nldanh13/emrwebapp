// Tổng quát kho gốc: chỉ số liệu thống kê (không có danh sách từng lượt/người bệnh) và
// "Quy trình dữ liệu" — dữ liệu đã được quét, thu thập, chuẩn hóa và lưu như thế nào, lúc nào.
// Số liệu quy trình đọc từ metadata server ghi sau mỗi bước (GET /research/archive/pipeline).
import { C, FS } from '../../tokens.js';
import { compactNumber } from './researchFormat.js';
import { EmptyState, StatBadge } from './researchUi.jsx';
import { Btn } from '../shared.jsx';
import { SkeletonBlock, SkeletonLines } from '../Skeleton.jsx';

function when(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
}
function ymd(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (value || '—');
}
function bytes(n) {
  const v = Number(n || 0);
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} MB`;
  if (v >= 1024) return `${Math.round(v / 1024).toLocaleString('vi-VN')} KB`;
  return `${v} B`;
}

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

function ModuleBar({ label, done, total }) {
  const pct = total ? Math.round(Number(done || 0) * 100 / Number(total || 1)) : 0;
  const color = pct >= 95 ? C.green : pct >= 70 ? C.blue : C.amber;
  return (
    <div style={{ minWidth: 145 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: FS.xs }}>
        <span style={{ color: C.text, fontWeight: 700 }}>{label}</span>
        <span style={{ color, fontWeight: 700 }}>{pct}%</span>
      </div>
      <div style={{ height: 5, marginTop: 5, background: C.surface2, borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} />
      </div>
      <div style={{ marginTop: 4, fontSize: FS.xs, color: C.text3 }}>{compactNumber(done)}/{compactNumber(total)} lượt đã đủ</div>
    </div>
  );
}

// Một bước của quy trình: số thứ tự, tên, trạng thái, mô tả việc làm và kết quả.
function Stage({ n, title, state, tone = 'neutral', what, children }) {
  const colors = { ok: C.green, warn: C.amber, danger: C.red, neutral: C.text3 };
  const done = tone === 'ok';
  return (
    <li style={{ display: 'grid', gridTemplateColumns: '26px minmax(0,1fr)', gap: 10 }}>
      <span aria-hidden="true" style={{
        width: 24, height: 24, borderRadius: 999, display: 'grid', placeItems: 'center', fontSize: FS.xs, fontWeight: 700,
        background: done ? C.green : C.surface, color: done ? '#fff' : C.text2, border: `1px solid ${done ? C.green : C.border}`,
      }}>{done ? '✓' : n}</span>
      <div style={{ paddingBottom: 14, borderBottom: `1px solid ${C.border2}`, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>{title}</span>
          <span style={{ fontSize: FS.xs, fontWeight: 700, color: colors[tone] || C.text3 }}>{state}</span>
        </div>
        <div style={{ marginTop: 2, fontSize: FS.xs, color: C.text3, lineHeight: 1.5 }}>{what}</div>
        <div style={{ marginTop: 7, fontSize: FS.sm, color: C.text2, lineHeight: 1.6 }}>{children}</div>
      </div>
    </li>
  );
}

const B = ({ children }) => <b style={{ color: C.text, fontVariantNumeric: 'tabular-nums' }}>{children}</b>;

function PipelineView({ pipeline, summary }) {
  if (!pipeline?.exists) return null;
  const { scan, collect, normalize, storage, reused_from_patient_db: reused } = pipeline;
  const fetch = pipeline.fetch || {};
  const modules = summary.modules || [];
  const anyCollected = modules.some(m => Number(m.done || 0) > 0);
  const qa = normalize.qa || {};
  const qaTone = qa.blocking ? 'danger' : qa.warning ? 'warn' : qa.status ? 'ok' : 'neutral';
  return (
    <section style={card}>
      <div style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>Quy trình dữ liệu</div>
      <div style={{ marginTop: 2, marginBottom: 12, fontSize: FS.xs, color: C.text3 }}>
        EMR → file CSV thô của từng đợt → chuẩn hóa và kiểm tra → bảng chuẩn + cơ sở dữ liệu SQLite. Mỗi bước ghi lại thời điểm và kết quả bên dưới.
      </div>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 12 }}>
        <Stage n={1} title="Quét danh sách từ EMR" tone={scan.rows ? 'ok' : 'neutral'} state={scan.rows ? 'đã quét' : 'chưa quét'}
          what="Selenium mở EMR, lấy danh sách người bệnh đã hoàn tất hồ sơ trong khoảng ngày, ghi thành file danh sách của đợt.">
          Lúc <B>{when(scan.at)}</B>{scan.first_at && scan.first_at !== scan.at && when(scan.first_at) !== when(scan.at) ? <span style={{ color: C.text3 }}> (đợt tạo lúc {when(scan.first_at)})</span> : null} · khoảng <B>{ymd(scan.from_date)}</B> → <B>{ymd(scan.to_date)}</B> · <B>{compactNumber(scan.rows)}</B> lượt
          {' '}→ ghi vào <code style={{ fontSize: FS.xs }}>{scan.file}</code>
        </Stage>

        <Stage n={2} title="Thu thập dữ liệu chi tiết" tone={collect?.selenium_errors_open ? 'warn' : anyCollected ? 'ok' : 'neutral'}
          state={collect ? (collect.cancelled ? 'đã dừng giữa chừng' : 'đã chạy') : anyCollected ? 'đã có dữ liệu' : 'chưa chạy'}
          what="Với từng lượt: lấy XN, CĐHA, hồ sơ nền, ra viện, phẫu thuật, y lệnh. Chỉ lấy phần mới/thiếu/lỗi; phần không đổi thì giữ, phần đổi thì lưu phiên bản mới.">
          {collect
            ? <>Lần gần nhất <B>{when(collect.at)}</B>: lấy <B>{compactNumber(collect.fetched_encounters)}</B> lượt, bỏ qua <B>{compactNumber(collect.skipped_unchanged)}</B> lượt không đổi, lấy bù <B>{compactNumber(collect.parts_backfilled)}</B> phần
              {collect.selenium_errors_open ? <>, <span style={{ color: C.red }}><B>{compactNumber(collect.selenium_errors_open)}</B> phần lỗi còn tồn</span></> : null}
              {collect.unmatched_encounters ? <>, <span style={{ color: C.amber }}><B>{compactNumber(collect.unmatched_encounters)}</B> lượt chưa ghép chắc</span></> : null}.
              {' '}Đã chạy <B>{compactNumber(pipeline.collect_runs)}</B> lần, lưu <B>{compactNumber(pipeline.versions_written)}</B> phiên bản dữ liệu.</>
            : 'Chưa chạy Thu thập tự động lần nào.'}
          {fetch.last_at && (
            <div>
              Lấy dữ liệu gần nhất lúc <B>{when(fetch.last_at)}</B>
              {fetch.parts?.length ? <span style={{ color: C.text3 }}> ({fetch.parts.map(p => `${p.label}: ${when(p.updated_at)}`).join(' · ')})</span> : null}.
            </div>
          )}
          {!!collect?.diagnostics?.length && (
            <div style={{ marginTop: 8, border: `1px solid ${C.amberBorder}`, background: C.amberBg, borderRadius: 7, padding: '7px 9px' }}>
              <div style={{ fontSize: FS.xs, fontWeight: 700, color: C.text }}>Lỗi đang nằm ở bước nào?</div>
              <div style={{ marginTop: 5, display: 'grid', gap: 4 }}>
                {collect.diagnostics.slice(0, 8).map((d, idx) => (
                  <div key={`${d.stage || 'x'}_${idx}`} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: FS.xs, color: C.text2 }}>
                    <b>{d.stage_label || 'Chưa phân loại'}:</b>
                    <span>{d.message}</span>
                    <span style={{ color: C.text3 }}>· {compactNumber(d.encounters || 0)} lượt / {compactNumber(d.rows || 0)} phần</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {!!reused.cases && <div>Dùng lại từ Kho người bệnh (tab Kiểm/Trả HSBA): <B>{compactNumber(reused.cases)}</B> ca, trong đó <B>{compactNumber(reused.provisional)}</B> ca còn dữ liệu tạm thời, <B>{compactNumber(reused.replaced_by_goc)}</B> ca đã thay bằng dữ liệu gốc.</div>}
          {!!modules.length && (
            <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', columnGap: 18, rowGap: 8 }}>
              {modules.map(part => <ModuleBar key={part.label} label={part.label} done={part.done} total={summary.total} />)}
            </div>
          )}
        </Stage>

        <Stage n={3} title="Chuẩn hóa và kiểm tra chất lượng" tone={normalize.status === 'complete' ? qaTone : 'neutral'}
          state={normalize.status === 'complete' ? (qa.blocking ? `${qa.blocking} lỗi chặn` : qa.warning ? `${qa.warning} cảnh báo` : 'đạt') : 'chưa chạy'}
          what="Ghép file thô thành bảng chuẩn theo lượt điều trị (người bệnh, đợt, XN, CĐHA, PT/TT, y lệnh...), tách Mã BN sang mã giả danh, rồi kiểm tra chất lượng (QA). Chạy tự động sau mỗi lần quét/thu thập.">
          Lúc <B>{when(normalize.at)}</B>{normalize.duration_ms != null ? <> · chạy <B>{(normalize.duration_ms / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}</B> giây</> : null}
          {normalize.schema_version ? <> · cấu trúc bảng phiên bản <B>{normalize.schema_version}</B></> : null}.
          {!!normalize.unmatched.length && (
            <div style={{ color: C.amber }}>Không ghép được vào lượt điều trị: {normalize.unmatched.map(u => `${u.label} ${compactNumber(u.rows)} dòng`).join(' · ')} (giữ riêng, không đưa vào phân tích).</div>
          )}
          {qa.matching_quality && (() => {
            const mq = qa.matching_quality;
            const matched = Number(mq.matched_rows || 0);
            const total = Number(mq.total_rows || 0);
            const pct = total ? Math.round((matched / total) * 1000) / 10 : 0;
            return (
              <div style={{ marginTop: 8, border: `1px solid ${C.border2}`, borderRadius: 7, padding: '8px 9px', background: C.surface2 }}>
                <div style={{ fontSize: FS.xs, fontWeight: 700, color: C.text }}>Chất lượng ghép dữ liệu</div>
                <div style={{ marginTop: 5, display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: FS.xs, color: C.text2 }}>
                  <span><B>{compactNumber(matched)}</B> / {compactNumber(total)} dòng matched ({pct}%)</span>
                  <span>Khóa đợt mạnh: <B>{compactNumber(mq.strong_key || 0)}</B></span>
                  <span>Khớp mốc vào/ra chính xác: <B>{compactNumber(mq.exact_visit_time || 0)}</B></span>
                  <span>Ghép theo khoảng thời gian: <B>{compactNumber(mq.event_time_range || 0)}</B></span>
                  <span style={{ color: Number(mq.missing_event_time || 0) ? C.amber : C.text2 }}>Thiếu thời gian sự kiện: <B>{compactNumber(mq.missing_event_time || 0)}</B></span>
                  <span style={{ color: Number(mq.outside_treatment_time || 0) ? C.red : C.text2 }}>Ngoài thời gian điều trị: <B>{compactNumber(mq.outside_treatment_time || 0)}</B></span>
                  <span style={{ color: Number(mq.strong_key_not_found || 0) ? C.amber : C.text2 }}>Khóa đợt không tìm thấy: <B>{compactNumber(mq.strong_key_not_found || 0)}</B></span>
                  <span style={{ color: Number(mq.strong_key_ambiguous || 0) ? C.amber : C.text2 }}>Khóa đợt mơ hồ: <B>{compactNumber(mq.strong_key_ambiguous || 0)}</B></span>
                  <span style={{ color: Number(mq.identity_conflict || 0) ? C.red : C.text2 }}>Xung đột Mã BN/khóa đợt: <B>{compactNumber(mq.identity_conflict || 0)}</B></span>
                  <span style={{ color: Number(mq.ambiguous || 0) ? C.amber : C.text2 }}>Mơ hồ: <B>{compactNumber(mq.ambiguous || 0)}</B></span>
                  <span style={{ color: Number(mq.missing || 0) ? C.red : C.text2 }}>Không ghép: <B>{compactNumber(mq.missing || 0)}</B></span>
                </div>
                <div style={{ marginTop: 4, fontSize: FS.xs, color: C.text3 }}>
                  Chỉ dòng matched và đúng khoảng điều trị mới được dùng cho bảng phân tích. Mã NC không tham gia quyết định matching.
                </div>
              </div>
            );
          })()}
          {normalize.history.length > 1 && (
            <div style={{ fontSize: FS.xs, color: C.text3 }}>
              Các lần chuẩn hóa gần nhất: {normalize.history.map(h => `${when(h.at)} (${compactNumber(h.encounters)} lượt, ${compactNumber(h.lab_results)} XN)`).join(' · ')}
            </div>
          )}
        </Stage>

        <Stage n={4} title="Lưu trữ" tone={storage.sqlite.status === 'ok' ? 'ok' : 'warn'} state={storage.sqlite.status === 'ok' ? 'đã lưu' : 'chưa có cơ sở dữ liệu'}
          what="Mỗi đợt có thư mục riêng chứa file CSV thô và bảng chuẩn. Bảng chuẩn được nạp vào SQLite để tra cứu nhanh. Bảng liên kết Mã BN ↔ mã giả danh lưu riêng ở thư mục kho, không nằm trong dữ liệu phân tích.">
          <div>Thư mục đợt: <code style={{ fontSize: FS.xs }}>{storage.run_dir}</code></div>
          <div>SQLite: <code style={{ fontSize: FS.xs }}>{storage.sqlite.file}</code> · <B>{bytes(storage.sqlite.size_bytes)}</B> · <B>{storage.sqlite.table_count}</B> bảng · cập nhật <B>{when(storage.sqlite.updated_at)}</B></div>
          <div>Liên kết mã giả danh: <code style={{ fontSize: FS.xs }}>{storage.patient_link.file}</code> {storage.patient_link.exists ? <>· cập nhật <B>{when(storage.patient_link.updated_at)}</B></> : '· chưa tạo'}</div>
          <div style={{ marginTop: 8, overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: FS.xs, minWidth: 520 }}>
              <thead><tr>
                {['Bảng', 'File', 'Số dòng', 'Dung lượng', 'Ghi lúc'].map(h => <th key={h} style={{ textAlign: 'left', padding: '4px 14px 4px 0', color: C.text3, fontWeight: 600, borderBottom: `1px solid ${C.border2}` }}>{h}</th>)}
              </tr></thead>
              <tbody>
                {storage.tables.map(t => (
                  <tr key={t.key} style={{ color: t.exists ? C.text2 : C.text3 }}>
                    <td style={{ padding: '4px 14px 4px 0', fontWeight: 600 }}>{t.label}</td>
                    <td style={{ padding: '4px 14px 4px 0' }}><code>{t.file}</code></td>
                    <td style={{ padding: '4px 14px 4px 0', fontVariantNumeric: 'tabular-nums' }}>{compactNumber(t.rows)}</td>
                    <td style={{ padding: '4px 14px 4px 0' }}>{t.exists ? bytes(t.size_bytes) : 'chưa có'}</td>
                    <td style={{ padding: '4px 14px 4px 0' }}>{t.exists ? when(t.updated_at) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Stage>
      </ol>
    </section>
  );
}

export function GeneralOverviewView({ generalOverview, generalOverviewLoading, pipeline, setArchiveMode }) {
  const ov = generalOverview;
  const summary = ov?.statusSummary || { total: 0, ready: 0, missingCount: 0, manualReview: 0, modules: [] };
  const counts = ov?.counts || {};
  // Gợi ý việc nên làm tiếp, để người mới không phải đoán bắt đầu từ đâu.
  const anyCollected = (summary.modules || []).some(part => Number(part.done || 0) > 0);
  const nextStep = !ov && !generalOverviewLoading
    ? { title: 'Kho chưa có dữ liệu', hint: 'Bắt đầu bằng việc quét danh sách người bệnh trên EMR.' }
    : ov && Number(summary.total || 0) > 0 && !anyCollected
      ? { title: 'Mới có danh sách, chưa có dữ liệu chi tiết', hint: `Đã có ${compactNumber(summary.total)} lượt điều trị nhưng chưa lấy xét nghiệm, CĐHA, hồ sơ... Hãy chạy Thu thập tự động.` }
      : null;

  return (
    <div style={{ padding: '10px 12px 16px', display: 'grid', gap: 12 }}>
      {nextStep && (
        <div style={{ padding: '10px 14px', borderRadius: 8, border: `1px solid ${C.blueBorder}`, background: C.blueBg, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 260px' }}>
            <div style={{ fontSize: FS.sm, fontWeight: 700, color: C.text }}>{nextStep.title}</div>
            <div style={{ marginTop: 2, fontSize: FS.xs, color: C.text2 }}>{nextStep.hint}</div>
          </div>
          <Btn variant="solidPrimary" onClick={() => setArchiveMode('update')} style={{ height: 30 }}>Đi tới Thu thập dữ liệu</Btn>
        </div>
      )}

      {/* Lần đầu: khung xám giữ chỗ cả màn hình, số liệu tính xong mới hiện một lần (UX_RULES mục 9). */}
      {!ov && generalOverviewLoading && (
        <div style={{ ...card, display: 'grid', gap: 10 }} aria-busy="true" aria-label="Đang tổng hợp số liệu">
          <SkeletonBlock width={180} height={16} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
            {[0, 1, 2, 3].map(i => <SkeletonBlock key={i} height={54} />)}
          </div>
          <SkeletonLines lines={5} />
        </div>
      )}
      {!ov && !generalOverviewLoading && !nextStep && <div style={card}><EmptyState title="Chưa có số liệu" hint="Sau khi quét danh sách và thu thập dữ liệu, số liệu sẽ hiện ở đây." /></div>}

      {ov && (
        <section style={card}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <span style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>Số liệu kho</span>
            <span style={{ fontSize: FS.xs, color: C.text3 }}>
              Đọc từ dữ liệu đã lưu, không mở EMR.{ov.date_from || ov.date_to ? ` Khoảng dữ liệu ${ov.date_from || '—'} → ${ov.date_to || '—'}.` : ''}
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
            <StatBadge label="Đủ dữ liệu" value={summary.counts?.done || summary.ready || 0} tone="ok" />
            <StatBadge label="Còn thiếu" value={summary.missingCount || 0} tone={summary.missingCount ? 'warn' : 'neutral'} />
            <StatBadge label="Lỗi" value={summary.counts?.error || 0} tone={summary.counts?.error ? 'danger' : 'neutral'} />
            <StatBadge label="Cần xem tay" value={summary.manualReview || 0} tone={summary.manualReview ? 'danger' : 'neutral'} />
            {ov.limited && <span style={{ fontSize: FS.xs, color: C.amber }}>Kho lớn: một số số đếm lấy từ metadata.</span>}
          </div>
        </section>
      )}

      <PipelineView pipeline={pipeline} summary={summary} />
    </div>
  );
}
