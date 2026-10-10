// Tài khoản EMR theo người (điều dưỡng, bác sĩ phòng khám): một kiểu bảng có tìm, Thêm (một hoặc nhiều người,
// tên đăng nhập tự gợi ý) và Xoá. Thêm/xoá điều dưỡng đi kèm Lịch điều dưỡng.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';

let accounts;
const api = {
  getNurseSettings: vi.fn(async () => ({ roster: ['Lê Ngọc Diệu', 'Trần Văn Bình'] })),
  getNurseEmrAccounts: vi.fn(async () => ({ accounts })),
  updateNurseEmrAccount: vi.fn(async (name, body) => {
    accounts = [...accounts.filter(a => a.name !== name), { name, ...body }];
    return { status: 'ok', accounts };
  }),
  removeNurseEmrAccount: vi.fn(async (name) => { accounts = accounts.filter(a => a.name !== name); return { status: 'ok', accounts }; }),
  saveNurseSettings: vi.fn(async () => ({ status: 'ok' })),
};
vi.mock('../../api.js', () => api);

const { default: EmrPeoplePanel, splitNames, buildNurseAccountRows, matchesSearch } = await import('./EmrPeoplePanel.jsx');
const { suggestEmrUsername, uniqueEmrUsernames } = await import('../../utils/emrUsername.js');
const { clinicLoginPayload, hasClinicLogin } = await import('../ClinicAccountPicker.jsx');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root;
beforeEach(() => {
  accounts = [
    { name: 'Lê Ngọc Diệu', emr_username: 'lndieu', emr_password: 'x' },
    { name: 'Hồ Điền', kind: 'doctor', emr_username: 'hdien', emr_password: 'x' },
    { name: 'Hoàng Minh Tú', kind: 'doctor', emr_username: 'hmtu', emr_password: 'x' },
  ];
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  Object.values(api).forEach(f => f.mockClear());
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const type = (el, value) => act(() => {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const button = (text) => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === text);
const names = () => [...host.querySelectorAll('tbody tr td:first-child')].map(td => td.firstChild?.textContent);

describe('gợi ý tên đăng nhập', () => {
  it('giống máy chủ, không trùng tài khoản đã có', () => {
    expect(suggestEmrUsername('Hoàng Minh Tú')).toBe('hmtu');
    expect(suggestEmrUsername('Trần Quốc Toản')).toBe('tqtoan');
    expect(suggestEmrUsername('Đỗ Đức')).toBe('dduc');
    expect(uniqueEmrUsernames(['Hoàng Minh Tú', 'Hà Minh Tú'], ['HMTU'])).toEqual(['hmtu2', 'hmtu3']);
    expect(splitNames('Hồ Điền,  Hoàng Minh Tú\nHồ Điền; Phạm Việt Tân')).toEqual(['Hồ Điền', 'Hoàng Minh Tú', 'Phạm Việt Tân']);
  });

  it('tìm theo tên không dấu hoặc tài khoản', () => {
    expect(matchesSearch({ name: 'Hoàng Minh Tú', emr_username: 'hmtu' }, 'hoang')).toBe(true);
    expect(matchesSearch({ name: 'Hoàng Minh Tú', emr_username: 'hmtu' }, 'HMT')).toBe(true);
    expect(matchesSearch({ name: 'Hồ Điền', emr_username: 'hdien' }, 'tu')).toBe(false);
  });
});

describe('EmrPeoplePanel', () => {
  it('bác sĩ: chỉ hiện bác sĩ, xếp theo tên; điều dưỡng không lẫn bác sĩ', async () => {
    act(() => root.render(createElement(EmrPeoplePanel, { kind: 'doctor' })));
    await flush();
    expect(names()).toEqual(['Hoàng Minh Tú', 'Hồ Điền']);
    expect(buildNurseAccountRows([], accounts).map(r => r.name)).toEqual(['Lê Ngọc Diệu']);
  });

  it('thêm một bác sĩ: tên đăng nhập tự gợi ý, sửa được', async () => {
    act(() => root.render(createElement(EmrPeoplePanel, { kind: 'doctor' })));
    await flush();
    await act(async () => { button('Thêm bác sĩ').click(); });
    type(host.querySelector('textarea[aria-label="Họ tên bác sĩ cần thêm"]'), 'Phạm Việt Tân');
    const user = host.querySelector('input[aria-label="Tên đăng nhập EMR của người cần thêm"]');
    expect(user.value).toBe('pvtan');
    type(user, 'tan.pv');
    type(host.querySelector('input[aria-label="Mật khẩu EMR của người cần thêm"]'), 'p');
    await act(async () => { host.querySelector('form[aria-label="Thêm bác sĩ"]').requestSubmit(); });
    await flush();
    expect(api.updateNurseEmrAccount).toHaveBeenCalledWith('Phạm Việt Tân', { emr_username: 'tan.pv', emr_password: 'p', kind: 'doctor' });
    expect(api.saveNurseSettings).not.toHaveBeenCalled();
    expect(names()).toContain('Phạm Việt Tân');
  });

  it('thêm nhiều điều dưỡng: bỏ người đã có, thêm luôn vào Lịch điều dưỡng', async () => {
    act(() => root.render(createElement(EmrPeoplePanel, { kind: 'nurse' })));
    await flush();
    await act(async () => { button('Thêm điều dưỡng').click(); });
    type(host.querySelector('textarea[aria-label="Họ tên điều dưỡng cần thêm"]'), 'Lê Ngọc Diệu, Nguyễn Kim Ngân, Ngô Kim Ngân');
    expect(host.textContent).toContain('Đã có trong danh sách, bỏ qua: Lê Ngọc Diệu');
    expect(host.textContent).toContain('Nguyễn Kim Ngân → nkngan');
    expect(host.textContent).toContain('Ngô Kim Ngân → nkngan2');
    await act(async () => { button('Thêm 2 điều dưỡng').click(); });
    await flush();
    expect(api.updateNurseEmrAccount).toHaveBeenCalledTimes(2);
    expect(api.saveNurseSettings).toHaveBeenCalledWith({ roster: ['Lê Ngọc Diệu', 'Ngô Kim Ngân', 'Nguyễn Kim Ngân', 'Trần Văn Bình'] });
  });

  it('xoá điều dưỡng: bỏ tài khoản và tên trong Lịch điều dưỡng, hỏi lại trước', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    act(() => root.render(createElement(EmrPeoplePanel, { kind: 'nurse' })));
    await flush();
    await act(async () => { host.querySelector('button[aria-label="Xoá điều dưỡng Lê Ngọc Diệu"]').click(); });
    await flush();
    expect(confirm.mock.calls[0][0]).toContain('Lịch điều dưỡng');
    expect(api.removeNurseEmrAccount).toHaveBeenCalledWith('Lê Ngọc Diệu');
    expect(api.saveNurseSettings).toHaveBeenCalledWith({ roster: ['Trần Văn Bình'] });
  });

  it('xoá: bấm Huỷ thì không đụng gì', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    act(() => root.render(createElement(EmrPeoplePanel, { kind: 'doctor' })));
    await flush();
    await act(async () => { host.querySelector('button[aria-label="Xoá bác sĩ Hồ Điền"]').click(); });
    expect(api.removeNurseEmrAccount).not.toHaveBeenCalled();
  });
});

describe('Đăng nhập phòng khám', () => {
  it('chọn bác sĩ thì chỉ gửi tên; gõ tay thì cần đủ tài khoản và mật khẩu', () => {
    expect(clinicLoginPayload({ accountName: 'Hồ Điền', username: 'cu', password: 'cu' })).toEqual({ account_name: 'Hồ Điền', username: '', password: '' });
    expect(clinicLoginPayload({ username: ' a ', password: 'b' })).toEqual({ username: 'a', password: 'b' });
    expect(hasClinicLogin({ accountName: 'Hồ Điền' })).toBe(true);
    expect(hasClinicLogin({ username: 'a' })).toBe(false);
  });
});
