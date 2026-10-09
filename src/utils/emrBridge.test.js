// Nút dấu trang "Data Hub" (chạy trong tab EMR) và trang cầu nối: chỉ nói chuyện với đúng cửa sổ
// Data Hub, chỉ lấy trang cùng nguồn EMR, chuyển đủ nội dung về máy chủ; phát hiện EMR đăng xuất.
import { describe, it, expect, vi } from 'vitest';
import { bridgeBookmarkletSource, bridgeBookmarkletUrl, looksLikeEmrLogin } from './emrBridgeBookmarklet.js';
import { createBridgeClient } from './emrBridgeClient.js';

const HUB = 'https://emr.ten-mien.vn';
const EMR = 'http://192.168.2.26:2026';
const flush = () => new Promise(r => setTimeout(r, 0));

function runBookmarklet({ origin = EMR, fetchImpl, helper = false } = {}) {
  const hub = { closed: false, postMessage: vi.fn(), focus: vi.fn() };
  let onMessage = null;
  const win = {
    open: vi.fn(() => hub),
    addEventListener: (type, fn) => { if (type === 'message') onMessage = fn; },
  };
  const location = { origin, href: `${origin}/home.aspx?usid=1&st=2` };
  const alert = vi.fn();
  const fetch = fetchImpl || vi.fn(async (url) => ({ status: 200, url, text: async () => '<html>trang</html>' }));
  // eslint-disable-next-line no-new-func
  new Function('location', 'window', 'alert', 'fetch', 'setInterval', 'setTimeout', 'URL', bridgeBookmarkletSource(HUB, { helper }))(
    location, win, alert, fetch, () => 0, () => 0, URL,
  );
  return { hub, win, alert, fetch, send: (e) => onMessage(e) };
}

describe('nút dấu trang Data Hub', () => {
  it('mã không có ký tự % (trình duyệt giải mã %XX trong javascript:) và là JS hợp lệ', () => {
    const url = bridgeBookmarkletUrl(HUB);
    expect(url.startsWith('javascript:(function(){')).toBe(true);
    expect(url).not.toMatch(/%/);
    expect(url).not.toMatch(/\n/);
    // eslint-disable-next-line no-new-func
    expect(() => new Function(url.slice('javascript:'.length))).not.toThrow();
  });

  it('mở trang cầu nối, chào bằng địa chỉ EMR hiện tại', () => {
    const { hub, win } = runBookmarklet();
    expect(win.open).toHaveBeenCalledWith(`${HUB}/emr-bridge`, 'emr_bridge');
    expect(hub.postMessage).toHaveBeenCalledWith({ type: 'emr-hello', origin: EMR, url: `${EMR}/home.aspx?usid=1&st=2` }, HUB);
  });

  it('nút "Góp sức lấy dữ liệu" mở trang cầu nối ở vai máy góp sức, cửa sổ riêng, vẫn chuyển trang EMR', async () => {
    const url = bridgeBookmarkletUrl(HUB, { helper: true });
    expect(url).not.toMatch(/%/);
    const { hub, win, fetch, send } = runBookmarklet({ helper: true });
    expect(win.open).toHaveBeenCalledWith(`${HUB}/emr-bridge?vai=gop-suc`, 'emr_helper');
    expect(win.__emrHelperWin).toBe(hub);
    expect(win.__emrBridgeWin).toBeUndefined();
    send({ origin: HUB, source: hub, data: { type: 'emr-fetch', id: 'g1', method: 'GET', path: '/home.aspx' } });
    await flush(); await flush(); await flush();
    expect(fetch).toHaveBeenCalled();
    expect(hub.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'emr-result', id: 'g1', ok: true }), HUB);
  });

  it('bấm nhầm trên Data Hub → nhắc, không mở gì', () => {
    const { win, alert } = runBookmarklet({ origin: HUB });
    expect(win.open).not.toHaveBeenCalled();
    expect(alert.mock.calls[0][0]).toMatch(/tab EMR/);
  });

  it('lấy trang cùng nguồn bằng phiên EMR (credentials) và trả đủ nội dung về Data Hub', async () => {
    const { hub, fetch, send } = runBookmarklet();
    send({ origin: HUB, source: hub, data: { type: 'emr-fetch', id: 'r1', method: 'POST', path: '/ajax.ashx?a=1', body: '{"q":1}', content_type: 'text/plain', headers: { 'X-AjaxPro-Method': 'Draw' }, referrer: '/home.aspx' } });
    await flush(); await flush(); await flush();
    const [url, opts] = fetch.mock.calls[0];
    expect(url).toBe(`${EMR}/ajax.ashx?a=1`);
    expect(opts).toMatchObject({ method: 'POST', body: '{"q":1}', credentials: 'include', referrer: `${EMR}/home.aspx` });
    expect(opts.headers).toEqual({ 'X-AjaxPro-Method': 'Draw', 'Content-Type': 'text/plain' });
    expect(hub.postMessage).toHaveBeenLastCalledWith({ type: 'emr-result', id: 'r1', status: 200, url: `${EMR}/ajax.ashx?a=1`, ok: true, text: '<html>trang</html>' }, HUB);
  });

  it('bỏ qua tin từ nguồn/cửa sổ lạ; chặn địa chỉ khác nguồn EMR', async () => {
    const { hub, fetch, send } = runBookmarklet();
    send({ origin: 'https://ke-gian.vn', source: hub, data: { type: 'emr-fetch', id: 'x', path: '/a' } });
    send({ origin: HUB, source: {}, data: { type: 'emr-fetch', id: 'y', path: '/a' } });
    send({ origin: HUB, source: hub, data: { type: 'emr-fetch', id: 'z', path: 'http://192.168.2.1/admin' } });
    await flush(); await flush(); await flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(hub.postMessage).toHaveBeenLastCalledWith({ type: 'emr-result', id: 'z', ok: false, error: 'Khác nguồn EMR' }, HUB);
  });

  it('nhận ra trang đăng nhập EMR', () => {
    expect(looksLikeEmrLogin('<input type="password" name="txtPassword">')).toBe(true);
    expect(looksLikeEmrLogin('<table id="tblNoiTru"></table>')).toBe(false);
  });
});

describe('trang cầu nối', () => {
  function setup({ role = '' } = {}) {
    let pollResolve = null;
    const api = {
      emrBridgeHello: vi.fn(async () => ({ status: 'ok' })),
      emrBridgePoll: vi.fn(() => new Promise(r => { pollResolve = r; })),
      emrBridgeResult: vi.fn(async () => ({ status: 'ok' })),
      emrBridgeDisconnect: vi.fn(async () => ({})),
    };
    const opener = { postMessage: vi.fn() };
    const states = [];
    const client = createBridgeClient({ api, getOpener: () => opener, role, onState: s => states.push(s), sleep: () => new Promise(r => setTimeout(r, 5)) });
    return { api, opener, client, states, resolvePoll: (v) => pollResolve && pollResolve(v) };
  }

  it('chào máy chủ khi tab EMR chào; chuyển yêu cầu sang tab EMR và trả kết quả', async () => {
    const { api, opener, client, resolvePoll } = setup();
    client.start();
    client.onMessage({ source: opener, origin: EMR, data: { type: 'emr-hello', origin: EMR, url: `${EMR}/home.aspx` } });
    await flush();
    expect(api.emrBridgeHello).toHaveBeenCalledWith(expect.objectContaining({ emr_origin: EMR, emr_url: `${EMR}/home.aspx`, emr_logged_in: true }));
    await new Promise(r => setTimeout(r, 20));
    resolvePoll({ requests: [{ id: 'q1', method: 'GET', path: '/home.aspx?wpid=ds' }] });
    await flush(); await flush();
    expect(opener.postMessage).toHaveBeenCalledWith({ id: 'q1', method: 'GET', path: '/home.aspx?wpid=ds', type: 'emr-fetch' }, EMR);
    client.onMessage({ source: opener, origin: EMR, data: { type: 'emr-result', id: 'q1', ok: true, status: 200, url: `${EMR}/home.aspx?wpid=ds`, text: '<table id="tblNoiTru"></table>' } });
    await flush(); await flush();
    expect(api.emrBridgeResult).toHaveBeenCalledWith(expect.objectContaining({ id: 'q1', ok: true, text: '<table id="tblNoiTru"></table>', emr_logged_in: true }));
    expect(client.getState()).toMatchObject({ phase: 'connected', served: 1 });
    await client.stop();
  });

  it('máy góp sức chào máy chủ với vai "helper"; cầu nối chính không gửi vai', async () => {
    for (const role of ['helper', '']) {
      const { api, opener, client } = setup({ role });
      client.start();
      client.onMessage({ source: opener, origin: EMR, data: { type: 'emr-hello', origin: EMR, url: `${EMR}/home.aspx` } });
      await flush();
      const body = api.emrBridgeHello.mock.calls[0][0];
      expect(body.role).toBe(role || undefined);
      client.stop();
    }
  });

  it('bỏ qua tin không đến từ tab EMR đã mở trang này', async () => {
    const { api, client } = setup();
    client.onMessage({ source: {}, origin: EMR, data: { type: 'emr-hello', origin: EMR, url: '' } });
    client.onMessage({ source: null, origin: 'https://ke-gian.vn', data: { type: 'emr-hello', origin: 'https://ke-gian.vn' } });
    await flush();
    expect(api.emrBridgeHello).not.toHaveBeenCalled();
    expect(client.getState().phase).toBe('waiting');
  });

  it('trang EMR trả về màn đăng nhập → báo "EMR đã đăng xuất" lên máy chủ', async () => {
    const { api, opener, client } = setup();
    client.onMessage({ source: opener, origin: EMR, data: { type: 'emr-hello', origin: EMR, url: `${EMR}/home.aspx` } });
    await flush();
    const p = client.__serve({ id: 'q2', method: 'GET', path: '/x' });
    client.onMessage({ source: opener, origin: EMR, data: { type: 'emr-result', id: 'q2', ok: true, status: 200, url: `${EMR}/login.aspx`, text: '<input type="password">' } });
    await p;
    expect(client.getState().phase).toBe('emr_logged_out');
    expect(api.emrBridgeHello).toHaveBeenLastCalledWith(expect.objectContaining({ emr_logged_in: false }));
  });
});
