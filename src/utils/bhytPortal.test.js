// Nhập Cổng BHYT qua tab cổng người dùng đã đăng nhập: nút dấu trang chỉ nhận lệnh từ đúng cửa sổ
// Data Hub, điền đúng control của cổng, điền thử không bấm Lưu; nhập thật bấm Lưu và báo kết quả.
import { describe, it, expect, vi } from 'vitest';
import {
  DOC_BHXH, DOC_GRV, PORTAL_ORIGIN, buildFillPlan, buildPortalRecords, cardParts, createPortalLink,
  mapInpatientRow, mapOutpatientRow, portalBookmarkletSource, portalBookmarkletUrl,
} from './bhytPortal.js';

const HUB = 'https://datahub.benhvien.vn';
const flush = (ms = 0) => new Promise(r => setTimeout(r, ms));

const OUT_ROW = {
  key: 'bhxh-ngt::nguyen van a::01/01/1980::02/09/2026::05/09/2026',
  ma_chung_tu: 'CT1', so_seri: 'S1', ma_so_bh: '7912345678', ma_the: 'HS4 79 1234567890',
  ho_ten: 'Nguyễn Văn A', ngay_sinh: '01/01/1980', gioi_tinh: 'Nam', don_vi: 'Công ty X',
  chan_doan: 'Gãy xương', dieu_tri_tu_ngay: '02/09/2026', dieu_tri_den_ngay: '05/09/2026',
  thu_truong: 'Giám đốc', nguoi_hanh_nghe: 'BS. Nguyễn Lê Hoan', ngay_chung_tu: '05/09/2026',
};
const IN_ROW = {
  key: 'bhxh-nt::tran thi b::02/02/1970::01/09/2026::06/09/2026',
  so_luu_tru: 'LT1', ma_y_te: 'YT1', ma_so_bh: '7900000001', ma_the: '', ho_ten: 'Trần Thị B',
  ngay_sinh: '02/02/1970', gioi_tinh: 'Nữ', nghe_nghiep: 'Hưu trí', khoa: 'Ngoại CTCH', dan_toc: 'Kinh',
  dia_chi: 'Cần Thơ', ngay_vao_vien: '01/09/2026', ngay_ra_vien: '06/09/2026', chan_doan: 'Gãy cổ xương đùi',
  phuong_phap_dieu_tri: 'Phẫu thuật', truong_khoa: 'Phạm Việt Tân', ngay_chung_tu: '06/09/2026',
};

describe('kế hoạch điền form cổng', () => {
  it('mẫu 07: đúng tên control, ngày dùng SetText, mã thẻ tách 4 ô, chọn giới tính và bác sĩ', () => {
    const plan = buildFillPlan(DOC_BHXH, { ...mapOutpatientRow(OUT_ROW), so_kcb: 'K123' });
    expect(plan).toMatchObject({ path: '/PhuLuc07/CreateNew', form: 'frmCreatenew07', save: 'SavePhuLuc7' });
    expect(plan.ops).toContainEqual({ op: 'value', name: 'ma_sobhxh', value: '7912345678' });
    expect(plan.ops).toContainEqual({ op: 'value', name: 'so_kcb', value: 'K123' });
    expect(plan.ops).toContainEqual({ op: 'text', name: 'tu_ngay', value: '02/09/2026' });
    expect(plan.ops.filter(o => o.name.startsWith('ma_theSub')).map(o => o.value)).toEqual(['HS', '4', '79', '1234567890']);
    expect(plan.ops).toContainEqual({ op: 'combo', name: 'bs_id', value: 'BS. Nguyễn Lê Hoan' });
  });

  it('mẫu 03: chọn khoa, dân tộc, loại giấy tờ mặc định; không có mã thẻ thì không điền ô thẻ', () => {
    const plan = buildFillPlan(DOC_GRV, mapInpatientRow(IN_ROW));
    expect(plan.save).toBe('SavePhuLuc3');
    expect(plan.ops).toContainEqual({ op: 'combo', name: 'loai_giay_to', value: 'Không có giấy tờ' });
    expect(plan.ops).toContainEqual({ op: 'combo', name: 'ma_khoa', value: 'Ngoại CTCH' });
    expect(plan.ops).toContainEqual({ op: 'value', name: 'pp_dieutri', value: 'Phẫu thuật' });
    expect(plan.ops.some(o => o.name.startsWith('ma_theSub'))).toBe(false);
    expect(plan.ops).toContainEqual({ op: 'check', name: 'dc_thainghen', value: false });
  });

  it('mã thẻ sai độ dài thì báo rõ, không điền', () => {
    expect(() => cardParts('HS123')).toThrow(/15 hoặc 17 ký tự/);
    expect(cardParts('')).toBeNull();
  });
});

describe('danh sách hồ sơ chờ nhập', () => {
  const doctors = ['Nguyễn Lê Hoan', 'Phạm Việt Tân'];
  it('bỏ ca đã nộp, ca cần sửa, bác sĩ ngoài khoa; Số KCB bổ sung lấy từ trạng thái đã lưu', () => {
    const other = { ...OUT_ROW, key: 'k-other', nguoi_hanh_nghe: 'BS Người Khác' };
    const flagged = { ...IN_ROW, key: 'k-flag', so_loi_ra_soat: 1 };
    const submitted = { ...IN_ROW, key: 'k-done' };
    const { records, stats } = buildPortalRecords({
      outpatient: [OUT_ROW, other],
      inpatient: [IN_ROW, flagged, submitted],
      entries: { [OUT_ROW.key]: { bhyt_fields: { so_kcb: 'K9' } }, 'k-done': { submitted: true } },
      doctors,
      hasIssue: r => Number(r.so_loi_ra_soat || 0) > 0,
    });
    expect(records.map(r => r.key)).toEqual([OUT_ROW.key, IN_ROW.key]);
    expect(stats).toEqual({ flagged: 1, submitted: 1, other_doctor: 1 });
    expect(records[0].fields.so_kcb).toBe('K9');
    expect(records[0].missing).toEqual([]);
    expect(records[0].editable).toEqual(['so_kcb']);
  });

  it('chưa bổ sung Số KCB thì mẫu 07 chưa sẵn sàng', () => {
    const { records } = buildPortalRecords({ outpatient: [OUT_ROW], doctors });
    expect(records[0].missing).toEqual(['so_kcb']);
  });
});

// ── Nút dấu trang chạy trong tab cổng, với một form giả có control kiểu DevExpress ────────────────
function fakeForm({ saveMessage = '' } = {}) {
  const calls = [];
  const control = (name) => ({
    SetValue: (v) => calls.push(['SetValue', name, v]),
    SetText: (v) => calls.push(['SetText', name, v]),
    SetChecked: (v) => calls.push(['SetChecked', name, v]),
    RaiseValueChangedEvent: () => {},
  });
  const combo = (name, items) => ({
    GetItemCount: () => items.length,
    GetItem: (i) => ({ text: items[i] }),
    SetSelectedIndex: (i) => calls.push(['Select', name, items[i]]),
  });
  const message = { innerText: saveMessage };
  const w = {
    location: { href: `${PORTAL_ORIGIN}/PhuLuc07/CreateNew`, pathname: '/PhuLuc07/CreateNew' },
    document: {
      readyState: 'complete', body: {},
      getElementById: (id) => (id === 'frmCreatenew07' ? {} : id === 'MessAlert' && saveMessage ? message : null),
      querySelector: () => ({}), // có link Đăng xuất = đã đăng nhập
      querySelectorAll: () => [],
    },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    gioi_tinh: combo('gioi_tinh', ['Nam', 'Nữ']),
    bs_id: combo('bs_id', ['BS. Phạm Việt Tân', 'ThS.BS Nguyễn Lê Hoan']),
    SavePhuLuc7: vi.fn(() => { if (!saveMessage) w.location.href = `${PORTAL_ORIGIN}/PhuLuc07/Index`; }),
  };
  for (const n of ['ma_ct', 'so_seri', 'so_kcb', 'mau_so', 'ma_sobhxh', 'ho_ten', 'ngay_sinh', 'ten_dv', 'chan_doan', 'nguoi_dai_dien', 'tu_ngay', 'den_ngay', 'ngay_ct', 'ma_theSub1', 'ma_theSub2', 'ma_theSub3', 'ma_theSub4']) w[n] = control(n);
  return { w, calls };
}

function runPortalBookmarklet({ hostname = 'gdbhyt.baohiemxahoi.gov.vn', opener, form } = {}) {
  const hub = opener === undefined ? { closed: false, postMessage: vi.fn() } : opener;
  const created = [];
  const document = {
    getElementById: (id) => created.find(el => el.id === id) || null,
    createElement: () => {
      const el = { style: {}, children: [], appendChild(c) { this.children.push(c); } };
      Object.defineProperty(el, 'src', { set(v) { el._src = v; el.contentWindow = form.w; setTimeout(() => el.onload?.(), 0); }, get() { return el._src; } });
      created.push(el);
      return el;
    },
    body: { appendChild: () => {} },
    querySelector: () => ({}),
  };
  let onMessage = null;
  const win = { opener: hub, addEventListener: (t, fn) => { if (t === 'message') onMessage = fn; } };
  const location = { hostname, pathname: '/Home', href: `https://${hostname}/Home` };
  const alert = vi.fn();
  // eslint-disable-next-line no-new-func
  new Function('location', 'window', 'document', 'alert', 'setInterval', 'setTimeout', portalBookmarkletSource(HUB))(
    location, win, document, alert, () => 0, setTimeout,
  );
  return { hub, alert, send: (e) => onMessage(e) };
}

async function resultOf(hub) {
  for (let i = 0; i < 100; i += 1) {
    const r = hub.postMessage.mock.calls.map(c => c[0]).find(m => m.type === 'bhyt-result');
    if (r) return r;
    await flush(20);
  }
  throw new Error('không có kết quả');
}

describe('nút dấu trang Nhập BHYT', () => {
  it('mã không có ký tự phần trăm, không xuống dòng, là JS hợp lệ', () => {
    const url = portalBookmarkletUrl(HUB);
    expect(url.startsWith('javascript:(function(){')).toBe(true);
    expect(url).not.toMatch(/%/);
    expect(url).not.toMatch(/\n/);
    // eslint-disable-next-line no-new-func
    expect(() => new Function(url.slice('javascript:'.length))).not.toThrow();
  });

  it('bấm trên trang khác cổng hoặc tab không mở từ Data Hub thì nhắc cách làm, không chạy', () => {
    expect(runPortalBookmarklet({ hostname: 'example.com', form: fakeForm() }).alert).toHaveBeenCalled();
    const r = runPortalBookmarklet({ opener: null, form: fakeForm() });
    expect(r.alert.mock.calls[0][0]).toMatch(/Mở cổng BHYT/);
  });

  it('chào Data Hub kèm trạng thái đăng nhập, bỏ qua lệnh từ nguồn khác', async () => {
    const form = fakeForm();
    const { hub, send } = runPortalBookmarklet({ form });
    expect(hub.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'bhyt-hello', logged_in: true }), HUB);
    send({ origin: 'https://ke-xau.vn', source: hub, data: { type: 'bhyt-fill', id: 'x', plan: buildFillPlan(DOC_BHXH, { ...mapOutpatientRow(OUT_ROW), so_kcb: 'K1' }) } });
    await flush(50);
    expect(form.calls).toEqual([]);
  });

  it('điền thử: điền đủ ô, chọn đúng bác sĩ bỏ qua tiền tố, KHÔNG bấm Lưu', async () => {
    const form = fakeForm();
    const { hub, send } = runPortalBookmarklet({ form });
    const plan = buildFillPlan(DOC_BHXH, { ...mapOutpatientRow(OUT_ROW), so_kcb: 'K1' });
    send({ origin: HUB, source: hub, data: { type: 'bhyt-fill', id: 'f1', save: false, plan } });
    const r = await resultOf(hub);
    expect(r).toMatchObject({ id: 'f1', ok: true });
    expect(form.calls).toContainEqual(['SetValue', 'so_kcb', 'K1']);
    expect(form.calls).toContainEqual(['SetText', 'tu_ngay', '02/09/2026']);
    expect(form.calls).toContainEqual(['Select', 'bs_id', 'ThS.BS Nguyễn Lê Hoan']);
    expect(form.w.SavePhuLuc7).not.toHaveBeenCalled();
  });

  it('nhập thật: cùng các bước điền rồi bấm Lưu; cổng báo lỗi thì trả đúng lời cổng', async () => {
    const plan = buildFillPlan(DOC_BHXH, { ...mapOutpatientRow(OUT_ROW), so_kcb: 'K1' });
    const preview = fakeForm();
    const p = runPortalBookmarklet({ form: preview });
    p.send({ origin: HUB, source: p.hub, data: { type: 'bhyt-fill', id: 'a', save: false, plan } });
    await resultOf(p.hub);

    const real = fakeForm();
    const r1 = runPortalBookmarklet({ form: real });
    r1.send({ origin: HUB, source: r1.hub, data: { type: 'bhyt-fill', id: 'b', save: true, plan } });
    expect(await resultOf(r1.hub)).toMatchObject({ ok: true });
    expect(real.w.SavePhuLuc7).toHaveBeenCalledWith(false);
    expect(real.calls).toEqual(preview.calls);

    const bad = fakeForm({ saveMessage: 'Số seri đã tồn tại' });
    const r2 = runPortalBookmarklet({ form: bad });
    r2.send({ origin: HUB, source: r2.hub, data: { type: 'bhyt-fill', id: 'c', save: true, plan } });
    expect(await resultOf(r2.hub)).toMatchObject({ ok: false, message: 'Số seri đã tồn tại' });
  });
});

describe('Data Hub nối tab cổng', () => {
  it('mở cổng, nhận chào, gửi lệnh điền và nhận kết quả; bỏ qua tin từ nguồn khác', async () => {
    const portal = { closed: false, postMessage: vi.fn(), focus: vi.fn() };
    const states = [];
    const link = createPortalLink({ openWindow: vi.fn(() => portal), onState: s => states.push(s.phase) });
    expect(link.open()).toBe(true);
    link.onMessage({ origin: 'https://ke-xau.vn', source: portal, data: { type: 'bhyt-hello', logged_in: true } });
    expect(link.getState().phase).toBe('waiting');
    link.onMessage({ origin: PORTAL_ORIGIN, source: portal, data: { type: 'bhyt-hello', logged_in: true } });
    expect(link.getState().phase).toBe('ready');

    const record = { doc_type: DOC_BHXH, patient_name: 'A', fields: { ...mapOutpatientRow(OUT_ROW), so_kcb: 'K1' } };
    const done = link.fill(record, { save: true });
    const sent = portal.postMessage.mock.calls[0];
    expect(sent[1]).toBe(PORTAL_ORIGIN);
    expect(sent[0]).toMatchObject({ type: 'bhyt-fill', save: true, plan: buildFillPlan(DOC_BHXH, record.fields) });
    link.onMessage({ origin: PORTAL_ORIGIN, source: portal, data: { type: 'bhyt-result', id: sent[0].id, ok: true, message: 'Đã lưu' } });
    await expect(done).resolves.toBe('Đã lưu');
  });

  it('chưa nối tab cổng thì báo việc cần làm, không gửi gì', async () => {
    const link = createPortalLink({ openWindow: () => null });
    expect(link.open()).toBe(false);
    await expect(link.fill({ doc_type: DOC_BHXH, fields: {} })).rejects.toThrow(/Chưa nối tab Cổng BHYT/);
  });
});
