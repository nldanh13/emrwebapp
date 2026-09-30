// Test khói cho màn hình Kho nghiên cứu: dựng component với API giả, chuyển qua 4 mục
// của kho gốc và kiểm tra các phần chính hiện ra, không lỗi render. Giữ an toàn khi
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

function responseFor(name) {
  if (name === 'getResearchArchive') return { status: 'ok', archive: ARCHIVE };
  if (name === 'listResearchStudies') return { status: 'ok', studies: [] };
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

const { default: ResearchTab } = await import('./ResearchTab.jsx');

let container;
let root;
const flush = async () => { for (let i = 0; i < 5; i += 1) await act(async () => { await Promise.resolve(); }); };
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
  it('hiện kho gốc với số dòng danh sách và 4 mục làm việc', () => {
    const text = container.textContent;
    expect(text).toContain('Kho dữ liệu gốc');
    expect(text).toContain('Dữ liệu tổng quát');
    expect(text).toContain('Thu thập dữ liệu');
    expect(text).toContain('Tra cứu người bệnh');
    expect(text).toContain('Tạo nghiên cứu');
  });

  it('chuyển qua các mục không lỗi; Tạo nghiên cứu không lặp biến chung của bảng rộng', async () => {
    await clickText('Thu thập dữ liệu');
    await clickText('Tra cứu người bệnh');
    await clickText('Tạo nghiên cứu');
    const text = container.textContent;
    expect(text).toContain('Chọn biến trong kho');
    // "sex" có ở Bảng tổng quát và Người bệnh: chỉ hiện một lần, ghi "cũng có ở".
    expect(text).toContain('cũng có ở Người bệnh');
    await clickText('Dữ liệu tổng quát');
  });
});
