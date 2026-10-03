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

function responseFor(name) {
  if (name === 'getResearchArchive') return { status: 'ok', archive: ARCHIVE };
  if (name === 'listResearchStudies') return { status: 'ok', studies: [NEW_STUDY, DONE_STUDY] };
  if (name === 'previewResearchArchiveVariables' || name === 'getResearchStudyVariableStats') return { status: 'ok', summary: STATS_SUMMARY, rows: [] };
  if (name === 'getResearchArchiveVariableCatalog') return { status: 'ok', run_id: CATALOG.run_id, catalog: CATALOG };
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
    mocked[name] = typeof value === 'function' ? vi.fn(async () => responseFor(name)) : value;
  }
  return mocked;
});

const api = await import('../api.js');
const { default: ResearchTab } = await import('./ResearchTab.jsx');

let container;
let root;
const flush = async () => { for (let i = 0; i < 5; i += 1) await act(async () => { await Promise.resolve(); }); };
const setInput = async (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
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
    expect(container.textContent).toContain('Thông tin nghiên cứu');
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
    expect(container.textContent).toContain('Không đặt điều kiện thì lấy toàn bộ lượt trong kho');
    await clickText('Tiếp tục');
    const text = container.textContent;
    expect(text).toContain('Đo lường từng biến');
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
});
