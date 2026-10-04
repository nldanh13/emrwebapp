// Khu Thu thập dữ liệu (kho gốc và nghiên cứu riêng), xếp theo thứ tự làm việc:
//   Bước 1  Quét danh sách người bệnh trên EMR (chỉ kho gốc)
//   Bước 2  Thu thập dữ liệu chi tiết (Thu thập tự động: chỉ lấy phần mới/thiếu/lỗi/đã đổi)
//   Bước 3  Theo dõi tiến độ từng phần
// Lần đầu của nghiên cứu (chưa có đợt chạy) dùng "Lấy dữ liệu lần đầu"; từ đó về sau chỉ một nút
// chính là Thu thập tự động. Thao tác ít dùng (quét lại dữ liệu tạm thời, chạy hiện Chrome, log)
// gom vào "Thao tác khác".
import { C, FS } from '../../tokens.js';
import { Btn, Spinner } from '../shared.jsx';
import { compactNumber } from './researchFormat.js';
import { todayInputDate } from './researchScope.js';
import { inp } from './researchUi.jsx';
import { CollectionAutoPanel } from './CollectionAutoPanel.jsx';
import { ResearchOperationDashboard } from './ResearchMonitor.jsx';

function StepHeader({ number, title, hint, done = false, right = null }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap', marginBottom: 6 }}>
      <span aria-hidden="true" style={{
        width: 22, height: 22, borderRadius: 999, flexShrink: 0, display: 'grid', placeItems: 'center',
        fontSize: FS.xs, fontWeight: 700,
        background: done ? C.green : C.surface, color: done ? '#fff' : C.text2,
        border: `1px solid ${done ? C.green : C.border}`,
      }}>{done ? '✓' : number}</span>
      <span style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>
        <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Bước {number}{done ? ' (đã xong)' : ''}: </span>
        {title}
      </span>
      {hint && <span style={{ fontSize: FS.xs, color: C.text3 }}>{hint}</span>}
      {right && <span style={{ marginLeft: 'auto' }}>{right}</span>}
    </div>
  );
}

function AutomationStatus({ run }) {
  if (!run || run.status === 'idle') return null;
  const tone = run.status === 'error' ? C.red : ['warning', 'cancelled'].includes(run.status) ? C.amber : run.status === 'done' ? C.green : C.blue;
  const bg = run.status === 'error' ? C.redBg : ['warning', 'cancelled'].includes(run.status) ? C.amberBg : run.status === 'done' ? C.greenBg : C.blueBg;
  const border = run.status === 'error' ? C.redBorder : ['warning', 'cancelled'].includes(run.status) ? C.amberBorder : run.status === 'done' ? C.greenBorder : C.blueBorder;
  const title = run.status === 'running' ? run.current
    : run.status === 'done' ? 'Đã hoàn tất'
    : run.status === 'warning' ? 'Hoàn tất, có cảnh báo'
    : run.status === 'cancelled' ? 'Đã dừng theo yêu cầu'
    : 'Đã dừng do lỗi';
  return (
    <div role="status" style={{ border: `1px solid ${border}`, background: bg, borderRadius: 7, padding: '8px 10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: FS.sm, fontWeight: 700, color: tone }}>
        {run.status === 'running' && <Spinner size={9} />}
        {title}
      </div>
      {(run.steps.length > 0 || run.error || run.warning) && (
        <details style={{ marginTop: 5 }}>
          <summary style={{ cursor: 'pointer', fontSize: FS.xs, color: C.text2 }}>Chi tiết quy trình</summary>
          <div style={{ display: 'grid', gap: 4, marginTop: 6 }}>
            {run.steps.map((step, index) => {
              const color = step.status === 'error' ? C.red : ['warning', 'cancelled'].includes(step.status) ? C.amber : step.status === 'done' ? C.green : step.status === 'running' ? C.blue : C.text3;
              const symbol = step.status === 'done' ? '✓' : ['error', 'warning'].includes(step.status) ? '!' : step.status === 'cancelled' ? '■' : step.status === 'running' ? '…' : '·';
              return <div key={`${step.label}_${index}`} style={{ fontSize: FS.xs, color }}>{symbol} {step.label}{step.detail ? ` — ${step.detail}` : ''}</div>;
            })}
            {run.error && <div style={{ fontSize: FS.xs, color: C.red }}>Lỗi: {run.error}</div>}
            {run.warning && <div style={{ fontSize: FS.xs, color: C.amber }}>{run.warning}</div>}
          </div>
        </details>
      )}
    </div>
  );
}

const card = { border: `1px solid ${C.border2}`, borderRadius: 8, background: C.surface, padding: '10px 12px' };

export function CollectionWorkspace({
  isArchive, archive, study, selectedId, uiBusy, automationRun,
  archiveOptions, setArchiveOptions, studyOptions, setStudyOptions,
  runSimpleListScan, runSimpleDataCollection, runRefreshProvisional,
  operationSnapshot, lastUpdateSummary, statusLoading, loadProgressSnapshot, loadSummary,
  openLog, toast, scopeRunning = null,
}) {
  const latestRun = archive?.latest_run || null;
  const listCount = Number(latestRun?.outputs?.initial_list || archive?.source_count || 0);
  const hasList = isArchive ? Boolean(latestRun?.id) : Boolean(study?.has_cohort);
  // Thu thập tự động cần một đợt chạy sẵn có. Kho gốc có đợt ngay sau khi quét danh sách;
  // nghiên cứu mới tạo thì chưa, nên lần đầu phải lấy theo quy trình đầy đủ.
  const hasRun = isArchive ? Boolean(latestRun?.id) : Boolean(study?.latest_run);
  const firstCollect = hasList && !hasRun;
  const headless = isArchive ? archiveOptions.headless : studyOptions.headless;
  const setHeadless = (value) => (isArchive
    ? setArchiveOptions(p => ({ ...p, headless: value }))
    : setStudyOptions(p => ({ ...p, headless: value })));
  const collectOptions = isArchive
    ? archiveOptions
    : { ...studyOptions, fromDate: studyOptions.fromDate || archiveOptions.fromDate, toDate: studyOptions.toDate || archiveOptions.toDate };
  const onCollected = async () => { await loadSummary(); await loadProgressSnapshot(selectedId, { silent: true }); };
  let step = 0;

  return (
    <div style={{ padding: '10px 12px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <AutomationStatus run={automationRun} />

      {isArchive && (
        <section>
          <StepHeader
            number={++step}
            title="Quét danh sách người bệnh"
            hint="Lấy danh sách người bệnh đã hoàn tất hồ sơ trên EMR trong khoảng ngày."
            done={hasList}
          />
          <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: FS.sm, color: C.text2 }}>
              Từ
              <input type="date" value={archiveOptions.fromDate}
                onChange={e => setArchiveOptions(p => ({ ...p, fromDate: e.target.value }))}
                disabled={uiBusy} style={{ ...inp, width: 138 }} />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: FS.sm, color: C.text2 }}>
              đến
              <input type="date" value={archiveOptions.toDate}
                onChange={e => setArchiveOptions(p => ({ ...p, toDate: e.target.value }))}
                disabled={uiBusy} style={{ ...inp, width: 138 }} />
            </label>
            <Btn onClick={() => setArchiveOptions(p => ({ ...p, toDate: todayInputDate() }))} disabled={uiBusy} style={{ height: 30, fontSize: FS.xs }}>Đến hôm nay</Btn>
            <Btn
              variant={hasList ? 'default' : 'solidPrimary'}
              onClick={runSimpleListScan}
              disabled={uiBusy}
              loading={uiBusy && automationRun.kind === 'scan'}
              style={{ height: 32, marginLeft: 'auto' }}
            >
              {hasList ? 'Quét lại danh sách' : 'Quét danh sách'}
            </Btn>
            <div style={{ flexBasis: '100%', fontSize: FS.xs, color: C.text3 }}>
              {hasList
                ? <>Lần quét gần nhất: <b style={{ color: C.text2 }}>{compactNumber(listCount)}</b> lượt (đợt {latestRun.id}). Quét lại chỉ thêm người bệnh mới, không xóa dữ liệu đã lấy.</>
                : 'Chưa quét lần nào. Đây là bước đầu tiên để có dữ liệu.'}
            </div>
          </div>
        </section>
      )}

      <section style={{ opacity: hasList ? 1 : 0.6 }}>
        <StepHeader
          number={++step}
          title="Thu thập dữ liệu chi tiết"
          hint={hasList
            ? 'Xét nghiệm, CĐHA, hồ sơ nền, ra viện, phẫu thuật, y lệnh. Chạy lại bao nhiêu lần cũng được: chỉ lấy phần còn thiếu.'
            : (isArchive ? 'Cần quét danh sách ở bước trên trước.' : 'Nghiên cứu chưa có danh sách mẫu.')}
        />
        {firstCollect && (
          <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 300px', fontSize: FS.sm, color: C.text2 }}>
              <b style={{ color: C.text }}>Chưa lấy dữ liệu lần nào.</b> Lần đầu sẽ lấy toàn bộ cho {compactNumber(study?.cohort_count || 0)} mẫu
              (XN &amp; CĐHA, hồ sơ, y lệnh) rồi chuẩn hóa. Từ lần sau dùng Thu thập tự động để chỉ lấy phần còn thiếu.
            </div>
            <Btn variant="solidPrimary" onClick={runSimpleDataCollection} disabled={uiBusy} loading={uiBusy && automationRun.kind === 'collect'} style={{ height: 32 }}>
              Lấy dữ liệu lần đầu
            </Btn>
          </div>
        )}
        {hasList && hasRun
          ? <CollectionAutoPanel
              studyId={isArchive ? '' : selectedId}
              study={isArchive ? null : study}
              options={collectOptions}
              disabled={uiBusy}
              toast={toast}
              onDone={onCollected}
              serverRunning={scopeRunning}
            />
          : !hasList && <div style={{ ...card, fontSize: FS.xs, color: C.text3 }}>Chưa thể thu thập.</div>}
      </section>

      {hasRun && (
        <section>
          <StepHeader number={++step} title="Theo dõi tiến độ" hint="Tự cập nhật khi đang chạy." />
          <ResearchOperationDashboard
            snapshot={operationSnapshot}
            lastUpdate={lastUpdateSummary}
            loading={statusLoading}
          />
        </section>
      )}

      <details style={{ ...card, padding: '8px 12px' }}>
        <summary style={{ cursor: 'pointer', fontSize: FS.sm, fontWeight: 600, color: C.text2 }}>Thao tác khác</summary>
        <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Btn onClick={runRefreshProvisional} disabled={uiBusy || !hasList} style={{ height: 30 }}>Quét lại dữ liệu tạm thời</Btn>
            <span style={{ fontSize: FS.xs, color: C.text3, flex: '1 1 260px' }}>
              Ca đã dùng tạm dữ liệu từ tab Kiểm HSBA / Trả HSBA sẽ được quét lại trên EMR để có dữ liệu gốc.
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: FS.sm, color: C.text2 }}>
              <input type="checkbox" checked={headless} onChange={e => setHeadless(e.target.checked)} disabled={uiBusy} />
              Chạy ẩn, không mở cửa sổ Chrome
            </label>
            <Btn onClick={openLog} style={{ height: 28, fontSize: FS.xs }}>Xem log chạy</Btn>
          </div>
        </div>
      </details>
    </div>
  );
}
