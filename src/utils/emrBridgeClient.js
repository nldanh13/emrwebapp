// Trang cầu nối EMR (chạy trên máy bệnh viện, mở bằng nút dấu trang "Data Hub" trên tab EMR).
//
// Vòng làm việc: hỏi máy chủ có trang EMR nào cần lấy (long-poll) → gửi yêu cầu sang tab EMR
// (postMessage, chỉ tới đúng nguồn EMR đã chào) → nhận nội dung → trả máy chủ. Không lưu nội dung
// trang EMR ở trình duyệt.
//
// Tách khỏi giao diện để test được (truyền api/opener giả).

import { looksLikeEmrLogin } from './emrBridgeBookmarklet.js';

const randomId = () => {
  const a = new Uint8Array(12);
  (globalThis.crypto || window.crypto).getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
};

export function createBridgeClient({
  api,
  getOpener,
  onState = () => {},
  keepaliveMs = 10 * 60 * 1000,
  helloEveryMs = 20 * 1000,
  requestTimeoutMs = 75 * 1000,
  staleHelloMs = 150 * 1000,
  maxParallel = 3,
  now = () => Date.now(),
  sleep = ms => new Promise(r => setTimeout(r, ms)),
} = {}) {
  const bridgeId = randomId();
  const state = {
    phase: 'waiting', // waiting | connected | emr_logged_out | emr_lost | stopped
    emrOrigin: '',
    emrUrl: '',
    emrLoggedIn: true,
    lastHelloAt: 0,
    lastServerHelloAt: 0,
    lastActivityAt: 0,
    served: 0,
    failed: 0,
    lastError: '',
  };
  const waiters = new Map();
  const queue = [];
  let active = 0;
  let running = false;
  let generation = 0;

  const emit = () => onState({ ...state });

  function setPhase() {
    if (state.phase === 'stopped') return;
    const t = now();
    if (!state.emrOrigin) state.phase = 'waiting';
    else if (t - state.lastHelloAt > staleHelloMs) state.phase = 'emr_lost';
    else if (!state.emrLoggedIn) state.phase = 'emr_logged_out';
    else state.phase = 'connected';
  }

  async function sendHello() {
    if (!state.emrOrigin) return;
    try {
      await api.emrBridgeHello({
        bridge_id: bridgeId, emr_origin: state.emrOrigin, emr_url: state.emrUrl,
        emr_logged_in: state.emrLoggedIn,
      });
      state.lastServerHelloAt = now();
      state.lastError = '';
    } catch (err) {
      state.lastError = String(err?.message || err);
    }
    setPhase();
    emit();
  }

  function onMessage(event) {
    const opener = getOpener();
    if (!opener || event.source !== opener) return;
    const m = event.data || {};
    if (m.type === 'emr-hello') {
      if (m.origin !== event.origin) return;
      const first = !state.emrOrigin || state.emrOrigin !== event.origin;
      state.emrOrigin = event.origin;
      state.emrUrl = String(m.url || '');
      const wasLost = state.phase === 'emr_lost';
      state.lastHelloAt = now();
      setPhase();
      emit();
      if (first || wasLost) sendHello();
      return;
    }
    if (m.type === 'emr-result' && event.origin === state.emrOrigin) {
      const w = waiters.get(String(m.id || ''));
      if (w) w(m);
    }
  }

  function fetchViaEmr(req) {
    const opener = getOpener();
    if (!opener || !state.emrOrigin) return Promise.resolve({ ok: false, error: 'Chưa nối được tab EMR.' });
    return new Promise((resolve) => {
      const id = String(req.id);
      const timer = setTimeout(() => {
        waiters.delete(id);
        resolve({ ok: false, error: 'Tab EMR không trả lời (tab EMR đã đóng, tải lại hoặc chuyển trang?). Bấm lại nút Data Hub trên tab EMR.' });
      }, requestTimeoutMs);
      waiters.set(id, (m) => {
        clearTimeout(timer);
        waiters.delete(id);
        resolve(m);
      });
      try {
        opener.postMessage({ ...req, type: 'emr-fetch' }, state.emrOrigin);
      } catch (err) {
        clearTimeout(timer);
        waiters.delete(id);
        resolve({ ok: false, error: String(err?.message || err) });
      }
    });
  }

  function noteLogin(result) {
    if (!result?.ok) return;
    const loggedIn = !looksLikeEmrLogin(result.text);
    if (loggedIn !== state.emrLoggedIn) {
      state.emrLoggedIn = loggedIn;
      setPhase();
      emit();
      sendHello();
    }
  }

  async function serve(req) {
    const result = await fetchViaEmr(req);
    noteLogin(result);
    state.lastActivityAt = now();
    if (result.ok) state.served += 1; else state.failed += 1;
    emit();
    try {
      await api.emrBridgeResult({
        bridge_id: bridgeId, id: req.id, ok: Boolean(result.ok), status: result.status || 0,
        url: result.url || '', text: result.ok ? String(result.text ?? '') : '',
        error: result.ok ? '' : String(result.error || 'lỗi không rõ'), emr_logged_in: state.emrLoggedIn,
      });
    } catch (err) {
      state.lastError = String(err?.message || err);
      emit();
    }
  }

  function pump() {
    while (active < maxParallel && queue.length) {
      const req = queue.shift();
      active += 1;
      serve(req).finally(() => { active -= 1; pump(); });
    }
  }

  async function pollLoop(gen) {
    while (running && gen === generation) {
      if (!state.emrOrigin || state.phase === 'emr_lost') { await sleep(1000); continue; }
      try {
        const r = await api.emrBridgePoll(bridgeId);
        state.lastError = '';
        for (const req of r?.requests || []) queue.push(req);
        pump();
      } catch (err) {
        state.lastError = String(err?.message || err);
        emit();
        if (err?.code === 'BRIDGE_UNKNOWN') await sendHello();
        await sleep(3000);
      }
    }
  }

  // Gọi định kỳ (~10 giây): chào máy chủ, phát hiện mất tab EMR, giữ phiên EMR khi rảnh.
  async function tick() {
    const before = state.phase;
    setPhase();
    if (state.phase !== before) emit();
    if (!state.emrOrigin || state.phase === 'emr_lost') {
      // Mất tab EMR: báo máy chủ ngắt ngay (Data Hub hiện "Chưa nối"), tự nối lại khi tab EMR chào lại.
      if (before !== 'emr_lost' && state.phase === 'emr_lost') api.emrBridgeDisconnect(bridgeId).catch(() => {});
      return;
    }
    if (now() - state.lastServerHelloAt >= helloEveryMs) sendHello();
    if (state.emrUrl && now() - state.lastActivityAt >= keepaliveMs) {
      state.lastActivityAt = now();
      let path = '';
      try { const u = new URL(state.emrUrl); path = u.pathname + u.search; } catch (_) { path = ''; }
      if (path) noteLogin(await fetchViaEmr({ id: `giu-phien-${randomId()}`, method: 'GET', path }));
    }
  }

  function start() {
    if (running) return;
    running = true;
    generation += 1;
    if (state.phase === 'stopped') { state.phase = 'waiting'; setPhase(); emit(); }
    if (state.emrOrigin) sendHello();
    pollLoop(generation);
  }

  function stop() {
    running = false;
    state.phase = 'stopped';
    emit();
    return api.emrBridgeDisconnect(bridgeId).catch(() => {});
  }

  return { bridgeId, onMessage, tick, start, stop, getState: () => ({ ...state }), __serve: serve };
}
