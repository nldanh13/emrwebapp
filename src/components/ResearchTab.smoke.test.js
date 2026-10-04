// Test khói cho màn hình Kho nghiên cứu: dựng component với API giả, chuyển qua 3 mục
// của kho gốc và phần Tạo nghiên cứu mới và kiểm tra các phần chính hiện ra, không lỗi render. Giữ an toàn khi
// tách ResearchTab.jsx thành nhiều file (không có testing-library nên dùng react-dom trực tiếp).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

const ARCHIVE = {
  id: 'du_lieu_goc',
  label: 'Kho dữ liệu gốc',
  latest_run: { id: '20260529_162615', outputs: { initial_list: 3127, patients: 2900, encounters: 3100 } },
  runs: [{ id: '20260529_162615', outputs: { initial_list: 3127 } }],
  datasets: {},
};
const variable = (table, tableLabel, name, extra = {}) => ({
  id: `${table}.${name}`, table, table_label: tableLabel, name, label: name, type: 'text',
  rows: 3100, nonempty: 3100, fill_rate: 100, distinct_count: 2, sample_values: [{ value: 'Nam', count: 1500 }], operators: ['='], ...extra,
});
const CATALOG = {
  run_id: '20260529_162615',
  groups: [
    { key: 'analysis_ready', label: 'Bảng tổng quát', rows: 3100, variables: [variable('analysis_ready', 'Bảng tổng quát', 'sex'), variable('analysis_ready', 'Bảng tổng quát', 'age', { type: 'number' })] },
    { key: 'patients', label: 'Người bệnh', rows: 2900, variables: [variable('patients', 'Người bệnh', 'sex'), variable('patients', 'Người bệnh', 'encounter_count', { type: 'number' })] },
    { key: 'lab_results', label: 'Xét nghiệm', rows: 90000, variables: [variable('lab_results', 'Xét nghiệm', 'days_from_admission', { type: 'number' })] },
  ],
};
const PROGRESS = {
  exists: true, run_id: '20260529_162615', total: 3, ready: 1, missingCount: 2, manualReview: 0, unmatched_progress: 2,
  modules: [], missingRows: [], rows: [{ key: 'NC0001', sample: 'NC0001', state: 'done', parts: {} }],
  counts: { running: 0, error: 1, missing: 1, waiting: 0, done: 1 }, recentUpdates: [], active_task: null, current_case: null,
};

// Nghiên cứu mới tạo: có danh sách mẫu nhưng chưa có đợt chạy (chưa lấy dữ liệu lần nào).
const NEW_STUDY = { id: 'gay_co_xuong_dui', name: 'Gãy cổ xương đùi (giả lập)', has_cohort: true, cohort_count: 12, latest_run: null };
// Nghiên cứu đã lấy dữ liệu: màn hình chỉ có thống kê và nút xuất, không có bảng dữ liệu.
const DONE_STUDY = { id: 'thoat_vi_dia_dem', name: 'Thoát vị đĩa đệm (giả lập)', has_cohort: true, cohort_count: 30, latest_run: { id: 'r1', outputs: { analysis_selected: 30, analysis_ready: 30 } } };
const STATS_SUMMARY = {
  total: 30, complete: 20, partial: 8, empty: 2, review: 0,
  cohort: { encounters: 30, patients: 28, age: { kind: 'number', n: 30, n_numeric: 30, mean: 61.2, sd: 12.4, median: 63, q1: 52, q3: 71, min: 25, max: 90 }, sex: { kind: 'category', n: 30, top: [{ value: 'Nam', count: 16, pct: 53.3 }, { value: 'Nữ', count: 14, pct: 46.7 }] }, hospital_stay_days: { kind: 'number', n: 30, n_numeric: 30, median: 6, q1: 4, q3: 9 } },
  variables: [{ id: 'analysis_ready.age', survey_label: 'Tuổi', output_column: 'var_age', filled: 30, missing: 0, fill_rate: 100, stats: { kind: 'number', n: 30, n_numeric: 30, mean: 61.2, sd: 12.4, median: 63, q1: 52, q3: 71, min: 25, max: 90 } }],
};

const PIPELINE = {
  exists: true, run_id: '20260529_162615',
  scan: { at: '2026-05-29T09:26:15Z', from_date: '2026-01-01', to_date: '2026-05-29', rows: 3127, file: 'du_lieu_ban_dau.csv' },
  collect: { at: '2026-05-30T01:00:00Z', cancelled: false, fetched_encounters: 120, skipped_unchanged: 2980, parts_backfilled: 14, selenium_errors_open: 3, unmatched_encounters: 2 },
  collect_runs: 4, versions_written: 260, reused_from_patient_db: { cases: 0, provisional: 0, replaced_by_goc: 0 },
  normalize: { status: 'complete', at: '2026-05-30T01:05:00Z', duration_ms: 4200, schema_version: 15, qa: { status: 'ok', blocking: 0, warning: 1, review: 0 }, unmatched: [], history: [] },
  storage: {
    run_dir: 'research/research_store/du_lieu_goc/runs/20260529_162615',
    tables: [{ key: 'encounters', label: 'Đợt điều trị', file: 'encounters.csv', rows: 3100, exists: true, size_bytes: 2048000, updated_at: '2026-05-30T01:05:00Z' }],
    sqlite: { file: 'research/research_store/du_lieu_goc/research.sqlite3', status: 'ok', size_bytes: 9000000, updated_at: '2026-05-30T01:05:00Z', table_count: 14 },
    patient_link: { file: 'research/research_store/du_lieu_goc/patient_link.csv', exists: true, updated_at: '2026-05-30T01:05:00Z' },
  },
};

const CRF = {
  form: {
    timepoints: [{ id: 'T24', label: '24 giờ', offset_hours: 24 }],
    fields: [
      { id: 'so_dien_thoai', label: 'Số điện thoại', type: 'text', section: 'Nhân khẩu', timepoint: '', identifier: true },
      { id: 'chieu_cao', label: 'Chiều cao', type: 'number', section: 'Nhân khẩu', timepoint: '', unit: 'cm' },
      { id: 'nhiet_do_max', label: 'Nhiệt độ max', type: 'number', section: 'Theo dõi', timepoint: 'T24' },
    ],
    updated_at: '2026-03-01T00:00:00Z',
  },
  samples: [
    // Mốc 3 ngày trước → lần gọi 24 giờ đã quá hạn.
    { research_code: 'NC0001', anchor_at: '', anchor_auto: new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 16), values: { chieu_cao: '155' }, identifiers_saved: ['so_dien_thoai'], timepoints: {}, updated_at: '2026-03-02T00:00:00Z' },
    { research_code: 'NC0002', anchor_at: '', anchor_auto: '', values: {}, identifiers_saved: [], timepoints: {}, updated_at: '' },
  ],
  identifiers_visible: false,
};

const SUGGESTIONS = {
  total_encounters: 3100, min_encounters: 20, sampled: false,
  suggestions: [{
    id: 's1', design: 'before_after', design_label: 'Trước – sau', cohort_kind: 'drug', cohort_label: 'Zoledronic acid',
    title: 'Thay đổi tuổi trước và sau dùng Zoledronic acid', outcome: 'Chênh lệch xét nghiệm sau – trước dùng thuốc',
    stats: { encounters: 120, patients: 110, with_labs: 90, with_imaging: 40, with_surgery: 10, with_meds: 100, common_labs: [] },
    anchor: { kind: 'drug', drug: 'Zoledronic acid' },
    variables: [
      { id: 'analysis_ready.sex', survey_label: 'Giới', role: 'descriptive' },
      { id: 'lab_results.days_from_admission', survey_label: 'Ngày XN trước', aggregation: 'closest_before_anchor', window_from_days: -14, window_to_days: 0, role: 'primary_outcome' },
      { id: 'lab_results.days_from_admission', survey_label: 'Ngày XN sau', aggregation: 'closest_after_anchor', window_from_days: 1, window_to_days: 14, role: 'primary_outcome' },
    ],
    sample_size_design: 'paired_means',
    conditions: [{ variable_id: 'analysis_ready.age', operator: '>=', value: '50' }],
    reasons: [],
  }],
};

let RUNNING = [];

function responseFor(name, args = []) {
  if (name === 'getResearchRunning') return { status: 'ok', running: RUNNING, server_time: new Date().toISOString() };
  if (name === 'getResearchStudySuggestions') return { status: 'ok', ...SUGGESTIONS };
  if (name === 'exportResearchArchiveVariables') return { filename: 'apr.csv', blob: new Blob(['a']) };
  if (name === 'getResearchStudyCrf') return { status: 'ok', ...CRF };
  if (name === 'saveResearchStudyCrfEntry') return { status: 'ok', message: 'Đã lưu phiếu NC0001.' };
  if (name === 'getResearchArchivePipeline') return { status: 'ok', pipeline: PIPELINE };
  if (name === 'getResearchArchive') return { status: 'ok', archive: ARCHIVE };
  if (name === 'listResearchStudies') return { status: 'ok', studies: [NEW_STUDY, DONE_STUDY] };
  if (name === 'previewResearchArchiveVariables' || name === 'getResearchStudyVariableStats') return { status: 'ok', summary: STATS_SUMMARY, rows: [] };
  if (name === 'getResearchArchiveVariableCatalog') return { status: 'ok', run_id: CATALOG.run_id, catalog: CATALOG };
  if (name === 'getResearchStudyProgress' && args[0] === NEW_STUDY.id) {
    // Nghiên cứu chưa có đợt chạy: server trả exists:false, mọi mẫu đều "thiếu".
    return { status: 'ok', run_id: '', progress: { ...PROGRESS, exists: false, run_id: '', total: 12, ready: 0, missingCount: 12, rows: [], counts: { running: 0, error: 0, missing: 12, waiting: 12, done: 0 } } };
  }
  if (name === 'getResearchArchiveProgress' || name === 'getResearchStudyProgress') return { status: 'ok', run_id: '20260529_162615', progress: PROGRESS };
  if (name === 'getResearchArchiveCoverage' || name === 'getResearchStudyCoverage') return { status: 'ok', coverage: { exists: true, counts: { patients: 2900, encounters: 3100 }, extract: { total: 3100, ready: 1000 }, blockers: [] } };
  if (name === 'getResearchIdentifiedAccess') return { status: 'ok', allowed: false, env_enabled: false, role_ok: false };
  if (name === 'getAnalysisPresets') return { status: 'ok', presets: [] };
  if (name === 'getResearchCollectionStatus') return { status: 'ok', summary: {}, next_plan: {}, exceptions: [], exceptions_total: 0 };
  if (name === 'getResearchEncounterReviews') return { status: 'ok', items: [], rows: [] };
  if (name === 'getResearchArchiveData' || name === 'getResearchData') return { status: 'ok', columns: ['research_code'], rows: [{ research_code: 'NC0001' }], count: 1 };
  return { status: 'ok' };
}

vi.mock('../api.js', async (importOriginal) => {
  const actual = await importOriginal();
  const mocked = {};
  for (const [name, value] of Object.entries(actual)) {
    mocked[name] = typeof value === 'function' ? vi.fn(async (...args) => responseFor(name, args)) : value;
  }
  return mocked;
});

const api = await import('../api.js');
const { default: ResearchTab } = await import('./ResearchTab.jsx');

let container;
let root;
const flush = async () => { for (let i = 0; i < 5; i += 1) await act(async () => { await Promise.resolve(); }); };
const setInput = async (el, value) => {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  await act(async () => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
  await flush();
};
const setSelect = async (el, value) => {
  expect(el, `có ô chọn cho "${value}"`).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  await act(async () => { setter.call(el, value); el.dispatchEvent(new Event('change', { bubbles: true })); });
  await flush();
};
const clickText = async (text) => {
  const el = [...container.querySelectorAll('button')].find(b => b.textContent.includes(text));
  expect(el, `có nút "${text}"`).toBeTruthy();
  await act(async () => { el.click(); });
  await flush();
};

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(createElement(ResearchTab, { toast: () => {} })); });
  await flush();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  RUNNING = [];
  vi.useRealTimers();
});

describe('ResearchTab (khói)', () => {
  it('hiện kho gốc, 3 mục làm việc và nút Tạo nghiên cứu mới ở danh sách nghiên cứu', () => {
    const text = container.textContent;
    expect(text).toContain('Kho dữ liệu gốc');
    expect(text).toContain('Dữ liệu tổng quát');
    expect(text).toContain('Thu thập dữ liệu');
    expect(text).toContain('Tra cứu người bệnh');
    expect(text).toContain('Tạo nghiên cứu mới');
  });

  it('Tổng quát chỉ hiện số liệu và quy trình quét → thu thập → chuẩn hóa → lưu, không có danh sách từng lượt', () => {
    const text = container.textContent;
    expect(text).toContain('Số liệu kho');
    expect(text).toContain('Quy trình dữ liệu');
    for (const stage of ['Quét danh sách từ EMR', 'Thu thập dữ liệu chi tiết', 'Chuẩn hóa và kiểm tra chất lượng', 'Lưu trữ']) expect(text).toContain(stage);
    expect(text).toContain('research.sqlite3');
    expect(text).toContain('3 phần lỗi còn tồn');
    expect(text).not.toContain('NC0001');
    expect(container.querySelector('input[placeholder^="Tìm mã NC"]')).toBeNull();
  });

  it('Thu thập dữ liệu xếp theo bước: quét danh sách rồi thu thập chi tiết, thao tác phụ gom lại', async () => {
    await clickText('Thu thập dữ liệu');
    const text = container.textContent;
    expect(text).toContain('Quét danh sách người bệnh');
    expect(text).toContain('Thu thập dữ liệu chi tiết');
    expect(text).toContain('Thao tác khác');
    expect(text.indexOf('Quét danh sách người bệnh')).toBeLessThan(text.indexOf('Thu thập dữ liệu chi tiết'));
  });

  it('Tạo nghiên cứu đi theo 4 bước; bước kiểm tra chỉ hiện thống kê, không hiện dữ liệu từng lượt', async () => {
    await clickText('Tạo nghiên cứu mới');
    expect(container.textContent).toContain('Thông tin & phiếu');
    const next = () => [...container.querySelectorAll('button')].find(b => b.textContent.includes('Tiếp tục'));
    expect(next().disabled, 'chưa có tên thì chưa sang bước 2').toBe(true);
    await setInput(container.querySelector('#study-name'), 'Đề tài thử');
    await clickText('Tiếp tục');
    // Bước 2: "sex" có ở Bảng tổng quát và Người bệnh nhưng chỉ hiện một lần.
    const items = [...container.querySelectorAll('[role="listitem"]')];
    expect(items.filter(el => el.textContent.includes('Giới tính')).length).toBe(1);
    expect(next().disabled, 'chưa chọn biến thì chưa sang bước 3').toBe(true);
    await act(async () => { items[0].querySelector('input[type="checkbox"]').click(); });
    await flush();
    await clickText('Tiếp tục');
    expect(container.textContent).toContain('Không đặt gì thì lấy toàn bộ kho.');
    expect(container.textContent).toContain('Tiêu chuẩn chọn vào');
    expect(container.textContent).toContain('Tiêu chuẩn loại trừ');
    await clickText('Tiếp tục');
    const text = container.textContent;
    expect(text).toContain('Đo lường từng biến');
    // Danh sách "Còn thiếu gì?" nhắc chọn kết cục chính, tiêu chuẩn chọn vào và cỡ mẫu.
    expect(text).toContain('Còn thiếu gì?');
    expect(text).toContain('Chưa có biến kết cục chính');
    expect(text).toContain('Chưa có tiêu chuẩn chọn vào');
    expect(text).toContain('Chưa tính cỡ mẫu');
    expect(text).toContain('61,2 ± 12,4');
    expect(container.querySelector('[role="listitem"]')).toBeNull();
    expect(api.previewResearchArchiveVariables).toHaveBeenCalled();
    await clickText('Toàn bộ kho');
    expect(container.textContent).toContain('Dữ liệu tổng quát');
  });

  it('nghiên cứu đã lấy dữ liệu: chỉ thống kê và nút Xuất CSV, không có bảng dữ liệu', async () => {
    await clickText(DONE_STUDY.name);
    const text = container.textContent;
    expect(text).toContain('Đo lường từng biến');
    expect(text).toContain('Xuất dữ liệu để xử lý số liệu');
    expect(api.getResearchStudyVariableStats).toHaveBeenCalledWith(DONE_STUDY.id);
    expect(text).not.toContain('NC0001');
  });

  it('nghiên cứu chưa lấy dữ liệu: mở thẳng Thu thập, mời lấy lần đầu, không gọi Thu thập tự động', async () => {
    api.getResearchCollectionStatus.mockClear();
    await clickText(NEW_STUDY.name);
    const text = container.textContent;
    expect(text).toContain('Chưa lấy dữ liệu lần nào');
    expect(text).toContain('Lấy dữ liệu lần đầu');
    // Thu thập tự động cần đợt chạy sẵn có; gọi khi chưa có sẽ bật lỗi đỏ.
    expect(api.getResearchCollectionStatus).not.toHaveBeenCalledWith(NEW_STUDY.id);
  });

  it('bấm "Lấy dữ liệu lần đầu" ở nghiên cứu chưa có đợt chạy: lấy toàn bộ, không gọi "chỉ lấy phần còn thiếu"', async () => {
    api.refetchMissingResearch.mockClear();
    api.runResearchStudy.mockClear();
    await clickText(NEW_STUDY.name);
    await clickText('Lấy dữ liệu lần đầu');
    for (let i = 0; i < 5; i += 1) await flush();
    expect(api.refetchMissingResearch).not.toHaveBeenCalled();
    expect(api.runResearchStudy).toHaveBeenCalledWith(NEW_STUDY.id, expect.objectContaining({ resume: true }));
  });

  it('Tạo nghiên cứu: đặt mốc "lần đầu dùng thuốc" và cửa sổ ngày, gửi kèm khi tính thống kê', async () => {
    await clickText('Tạo nghiên cứu mới');
    await setInput(container.querySelector('#study-name'), 'APR Zoledronic');
    const drugRadio = [...container.querySelectorAll('input[name="study-anchor"]')].find(el => el.parentElement.textContent.includes('Lần đầu dùng một thuốc'));
    await act(async () => { drugRadio.click(); });
    await flush();
    const next = () => [...container.querySelectorAll('button')].find(b => b.textContent.includes('Tiếp tục'));
    expect(next().disabled, 'chưa có tên thuốc').toBe(true);
    await setInput(container.querySelector('input[aria-label="Tên thuốc làm mốc"]'), 'Zoledronic');
    await clickText('Tiếp tục');
    const item = [...container.querySelectorAll('[role="listitem"]')].find(el => el.textContent.includes('Days From Admission') || el.textContent.length);
    await act(async () => { item.querySelector('input[type="checkbox"]').click(); });
    await flush();
    await clickText('Tiếp tục');
    await clickText('Tiếp tục');
    const spec = api.previewResearchArchiveVariables.mock.calls.at(-1)[0].variable_selection;
    expect(spec.anchor).toMatchObject({ kind: 'drug', drug: 'Zoledronic' });
  });

  it('Phiếu nhập tay: lịch gọi báo quá hạn, mở đúng mẫu, lưu không gửi số điện thoại đang ẩn', async () => {
    await clickText(DONE_STUDY.name);
    await clickText('Phiếu nhập tay & theo dõi');
    let text = container.textContent;
    expect(text).toContain('Quá hạn');
    expect(text).toContain('NC0001');
    expect(text).toContain('đang ẩn');
    expect(text).not.toContain('NC0002', 'mẫu chưa có mốc chỉ hiện khi bật xem tất cả');
    await clickText('Nhập kết quả');
    text = container.textContent;
    expect(text).toContain('Theo dõi 24 giờ');
    expect(container.querySelector('input[aria-label="Số điện thoại"]').placeholder).toBe('Đã lưu (đang ẩn)');
    await setInput(container.querySelector('input[aria-label="Nhiệt độ max"]'), '38.4');
    await clickText('Lưu phiếu NC0001');
    const [studyId, code, body] = api.saveResearchStudyCrfEntry.mock.calls.at(-1);
    expect([studyId, code]).toEqual([DONE_STUDY.id, 'NC0001']);
    expect(body.timepoints.T24.values.nhiet_do_max).toBe('38.4');
    expect('so_dien_thoai' in body.values).toBe(false);
  });

  it('Dán phiếu: tự ghép dòng với biến trong kho, đặt tên cột theo phiếu, báo dòng không có, xuất CSV ngay', async () => {
    globalThis.URL.createObjectURL = globalThis.URL.createObjectURL || (() => 'blob:x');
    globalThis.URL.revokeObjectURL = globalThis.URL.revokeObjectURL || (() => {});
    await clickText('Tạo nghiên cứu mới');
    await setInput(container.querySelector('#study-name'), 'APR Zoledronic');
    await setInput(container.querySelector('#study-survey'), '2. Giới tính: ☐ 0. Nam ☐1. Nữ\n5. Chiều cao: ....... (cm)');
    await clickText('Tiếp tục');
    let text = container.textContent;
    expect(text).toContain('Ghép phiếu với dữ liệu trong kho');
    expect(text).toContain('1/2 dòng của phiếu có biến tương ứng');
    expect(text).toContain('1 dòng không có trong kho');
    await clickText('Chọn 1 biến đã ghép');
    await clickText('Tiếp tục');
    await clickText('Tiếp tục');
    text = container.textContent;
    expect(text).toContain('Kiểm tra & xuất dữ liệu');
    await clickText('Xuất dữ liệu (CSV)');
    const payload = api.exportResearchArchiveVariables.mock.calls.at(-1)[0];
    expect(payload.name).toBe('APR_Zoledronic');
    expect(payload.variable_selection.selected_variables.map(v => v.survey_label)).toEqual(['Giới tính']);
  });

  it('Gợi ý đề tài: dùng gợi ý điền sẵn tên, mốc, biến lấy 2 lần (trước/sau), điều kiện và mở bước kiểm tra', async () => {
    await clickText('Tạo nghiên cứu mới');
    await clickText('Xem gợi ý đề tài');
    expect(container.textContent).toContain('Thay đổi tuổi trước và sau dùng Zoledronic acid');
    expect(container.textContent).toContain('120 lượt');
    await clickText('Dùng gợi ý này');
    expect(container.textContent).toContain('Kiểm tra & xuất dữ liệu');
    const spec = api.previewResearchArchiveVariables.mock.calls.at(-1)[0].variable_selection;
    expect(spec.anchor).toMatchObject({ kind: 'drug', drug: 'Zoledronic acid' });
    expect(spec.selected_variables.map(v => [v.id, v.aggregation, v.survey_label])).toEqual([
      ['analysis_ready.sex', 'list', 'Giới'],
      ['lab_results.days_from_admission', 'closest_before_anchor', 'Ngày XN trước'],
      ['lab_results.days_from_admission', 'closest_after_anchor', 'Ngày XN sau'],
    ]);
    expect(spec.selected_variables[1]).toMatchObject({ window_from_days: -14, window_to_days: 0 });
    expect(spec.conditions).toEqual([expect.objectContaining({ variable_id: 'analysis_ready.age', operator: '>=', value: '50' })]);
    expect(spec.selected_variables.map(v => v.role)).toEqual(['descriptive', 'primary_outcome', 'primary_outcome']);
    expect(spec.sample_size).toEqual({ design: 'paired_means' });
    expect(container.textContent).toContain('So sánh trước – sau (cặp)');
  });

  it('Đề cương: vai trò biến, thời gian, tiêu chuẩn loại trừ, một lượt/người và cỡ mẫu được gửi kèm; báo đủ/thiếu cỡ mẫu', async () => {
    await clickText('Tạo nghiên cứu mới');
    await setInput(container.querySelector('#study-name'), 'APR Zoledronic');
    await clickText('Tiếp tục');
    const item = [...container.querySelectorAll('[role="listitem"]')][0];
    await act(async () => { item.querySelector('input[type="checkbox"]').click(); });
    await flush();
    await setSelect(container.querySelector('select[aria-label^="Vai trò của"]'), 'primary_outcome');
    await clickText('Tiếp tục');
    await setInput(container.querySelector('input[aria-label="Từ ngày"]'), '2026-01-01');
    await setSelect(container.querySelector('select[aria-label="Thêm tiêu chuẩn loại trừ"]'), 'analysis_ready.age');
    await setInput(container.querySelector('input[aria-label="Giá trị"]'), '90');
    await act(async () => { container.querySelector('input[type="checkbox"]').click(); });
    await flush();
    await clickText('Tiếp tục');
    const spec = api.previewResearchArchiveVariables.mock.calls.at(-1)[0].variable_selection;
    expect(spec.selected_variables[0].role).toBe('primary_outcome');
    expect(spec.period).toEqual({ from: '2026-01-01', to: '' });
    expect(spec.one_per_patient).toBe(true);
    expect(spec.conditions[0]).toMatchObject({ variable_id: 'analysis_ready.age', exclude: true, value: '90' });
    // Kết cục chính "Tuổi" có SD 12,4 trong kho: tính cỡ mẫu ước lượng trung bình với sai số ±2.
    await setSelect(container.querySelector('select[aria-label="Thiết kế tính cỡ mẫu"]'), 'mean_one');
    await clickText('Lấy từ kho: 12,4');
    await setInput(container.querySelector('input[aria-label="Sai số tuyệt đối (cùng đơn vị)"]'), '2');
    let text = container.textContent;
    // n = 1,96² × 12,4² / 2² = 147,7 → 148, +10% hao hụt → 165; kho có 30 → thiếu 135.
    expect(text).toContain('Thiếu 135 lượt');
    expect(text).toContain('Chưa đủ cỡ mẫu: cần 165, hiện có 30');
    await setInput(container.querySelector('input[aria-label="Sai số tuyệt đối (cùng đơn vị)"]'), '10');
    text = container.textContent;
    expect(text).toContain('Đủ cỡ mẫu');
  });

  it('tác vụ đang chạy: dải trạng thái luôn hiện, báo lên menu, nút bị khóa; xong thì báo đã kết thúc', async () => {
    await act(async () => { root.unmount(); });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    RUNNING = [{ scope_key: 'archive', kind: 'archive', study_id: '', label: 'Lấy dữ liệu', since: new Date(Date.now() - 125000).toISOString(),
      task: { message: 'Đang lấy 12/40 lượt', heartbeat_at: new Date().toISOString() } }];
    // Snapshot tiến độ cũ (chưa có khóa): còn ghi "đã dừng" và ca của lần trước.
    Object.assign(PROGRESS, { stopped: { hint: 'dừng' }, current_case: { ho_ten: 'TRẦN VĂN TỰ', ma_bn: '26033731' } });
    const onRunningChange = vi.fn();
    root = createRoot(container);
    await act(async () => { root.render(createElement(ResearchTab, { toast: () => {}, onRunningChange })); });
    await flush();
    let text = container.textContent;
    expect(text).toContain('Đang chạy: Lấy dữ liệu');
    expect(text).toContain('Kho dữ liệu gốc');
    expect(text).toContain('đã chạy 2 phút');
    expect(text).toContain('Đang lấy 12/40 lượt');
    expect(text).toContain('Máy chủ xác nhận vẫn đang chạy');
    expect(onRunningChange).toHaveBeenLastCalledWith({ title: 'Đang chạy: Lấy dữ liệu · Kho dữ liệu gốc' });
    await clickText('Xem tiến độ');
    const scan = [...container.querySelectorAll('button')].find(b => /^Quét (lại )?danh sách$/.test(b.textContent.trim()));
    expect(scan?.disabled, 'đang chạy thì không bấm chạy thêm được').toBe(true);
    // Khung thu thập và tiến độ cùng báo đang chạy, không báo "đã dừng giữa chừng".
    text = container.textContent;
    expect(text).toContain('Đang chạy: Lấy dữ liệu');
    expect(text).not.toContain('Tác vụ đã dừng giữa chừng');
    expect(text).toContain('Đang quét:');
    Object.assign(PROGRESS, { stopped: undefined, current_case: null });
    RUNNING = [];
    await act(async () => { vi.advanceTimersByTime(3100); });
    await flush();
    text = container.textContent;
    expect(text).not.toContain('Đang chạy: Lấy dữ liệu');
    expect(text).toContain('Đã kết thúc: Lấy dữ liệu');
    expect(onRunningChange).toHaveBeenLastCalledWith(null);
  });

  it('Thu thập tự động bấm mà lỗi: báo lỗi ngay tại khung, kèm thời điểm, không chỉ thông báo thoáng qua', async () => {
    await clickText('Thu thập dữ liệu');
    api.collectResearchAuto.mockRejectedValueOnce(new Error('EMR không phản hồi'));
    const btn = [...container.querySelectorAll('button')].find(b => b.textContent.trim() === 'Thu thập tự động');
    expect(btn, 'có nút Thu thập tự động').toBeTruthy();
    await act(async () => { btn.click(); });
    await flush();
    const text = container.textContent;
    expect(text).toContain('Chưa chạy được');
    expect(text).toContain('EMR không phản hồi');
  });

  it('Tra cứu người bệnh khóa: chỉ đúng bước còn thiếu để bật (vd. lỡ lưu .env.txt)', async () => {
    api.getResearchIdentifiedAccess.mockImplementation(async () => ({ status: 'ok', allowed: false, env_enabled: false, role_ok: true, env_diagnosis: { reason: 'saved_as_txt' } }));
    await clickText('Tra cứu người bệnh');
    const text = container.textContent;
    expect(text).toContain('Chức năng đang khóa');
    expect(text).toContain('Thấy file .env.txt');
    expect(text).toContain('EMR_ALLOW_IDENTIFIED_RESEARCH_EXPORT=1');
    api.getResearchIdentifiedAccess.mockImplementation(async () => responseFor('getResearchIdentifiedAccess'));
  });

  it('Chuẩn hóa: một khung duy nhất; đang chuẩn hóa hiện bước + thời gian và KHÔNG khóa Thu thập; xong báo đã chuẩn hóa', async () => {
    await act(async () => { root.unmount(); });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    PIPELINE.fetch = { last_at: '2026-10-04T13:42:00Z', parts: [], pending_normalize: true };
    root = createRoot(container);
    await act(async () => { root.render(createElement(ResearchTab, { toast: () => {} })); });
    await flush();
    const count = (text) => container.textContent.split(text).length - 1;
    expect(count('Có dữ liệu mới chưa được chuẩn hóa'), 'chỉ một chỗ ở Tổng quát').toBe(1);
    await clickText('Thu thập dữ liệu');
    expect(count('Có dữ liệu mới chưa được chuẩn hóa'), 'chỉ một chỗ ở Thu thập').toBe(1);

    let finish;
    api.normalizeResearchArchive.mockImplementationOnce(() => new Promise(r => { finish = r; }));
    RUNNING = [{ scope_key: 'archive:normalize', scope: 'archive', lane: 'normalize', kind: 'archive', study_id: '', label: 'Chuẩn hóa',
      since: new Date(Date.now() - 65000).toISOString(), normalize: { stage: 'Xét nghiệm và CĐHA', stage_index: 3, stage_total: 8 } }];
    await clickText('Chuẩn hóa ngay');
    await act(async () => { vi.advanceTimersByTime(10100); });
    await flush();
    let text = container.textContent;
    expect(text).toContain('Đang chuẩn hóa');
    expect(text).toContain('bước 3/8');
    expect(text).toContain('Xét nghiệm và CĐHA');
    expect(text).toContain('Đã chạy 1 phút');
    expect(text).not.toContain('Đang chạy: Chuẩn hóa', 'không lặp ở dải trên cùng');
    const collect = [...container.querySelectorAll('button')].find(b => b.textContent.trim() === 'Thu thập tự động');
    expect(collect?.disabled, 'đang chuẩn hóa vẫn thu thập được').toBe(false);

    RUNNING = [];
    PIPELINE.fetch = { ...PIPELINE.fetch, pending_normalize: false };
    await act(async () => { finish({ status: 'ok', message: 'Đã chuẩn hóa kho dữ liệu gốc.' }); });
    await flush();
    text = container.textContent;
    expect(text).toContain('Đã chuẩn hóa xong');
    expect(text).not.toContain('Có dữ liệu mới chưa được chuẩn hóa');
    delete PIPELINE.fetch;
  });
});
