#!/usr/bin/env node
'use strict';
// Cầu nối tab EMR: máy chủ chuyển yêu cầu trang EMR của worker sang trang cầu nối (máy bệnh viện)
// và trả kết quả về; chặn địa chỉ khác nguồn EMR; worker Python (EmrHttpSession) đi qua cầu nối.
const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');

process.env.EMR_BRIDGE_MODE = '1';
const bridge = require('../server/services/emr_bridge');
const routes = require('../server/routes/emr_bridge');

const ORIGIN = 'http://192.168.2.26:2026';
let failed = 0;
const test = async (name, fn) => {
  bridge.__resetEmrBridge();
  try { await fn(); console.log(`  ok - ${name}`); } catch (e) { failed += 1; console.error(`  FAIL - ${name}\n`, e); }
};

// Trang cầu nối giả: hỏi việc rồi trả lời bằng hàm handler.
async function fakeBridgeOnce(id, handler) {
  const reqs = await bridge.poll(id, { waitMs: 2000 });
  for (const r of reqs) bridge.submitResult(id, { id: r.id, ...(await handler(r)) });
  return reqs;
}

(async () => {
  console.log('emr_bridge_test');

  await test('chưa nối tab EMR → báo tiếng Việt, không treo', async () => {
    await assert.rejects(bridge.request({ url: '/home.aspx' }), e => e.code === 'BRIDGE_OFFLINE' && /Chưa nối tab EMR/.test(e.message));
    assert.match(bridge.collectionBlocker(), /Chưa nối tab EMR/);
  });

  await test('một vòng: worker xin trang → trang cầu nối nhận đường dẫn cùng nguồn → trả nội dung', async () => {
    bridge.hello({ bridgeId: 'b1', userId: 'quantri', emrOrigin: ORIGIN, emrUrl: `${ORIGIN}/home.aspx?usid=1&st=2` });
    assert.strictEqual(bridge.status().connected, true);
    assert.strictEqual(bridge.collectionBlocker(), '');
    const p = bridge.request({ url: `${ORIGIN}/home.aspx?wpid=x`, headers: { 'X-AjaxPro-Method': 'M', Cookie: 'bo', 'User-Agent': 'bo' } });
    const seen = await fakeBridgeOnce('b1', async (r) => {
      assert.strictEqual(r.path, '/home.aspx?wpid=x');
      assert.deepStrictEqual(r.headers, { 'X-AjaxPro-Method': 'M' });
      return { ok: true, status: 200, url: `${ORIGIN}/home.aspx?wpid=x`, text: '<html>ok</html>' };
    });
    assert.strictEqual(seen.length, 1);
    const r = await p;
    assert.strictEqual(r.text, '<html>ok</html>');
    assert.strictEqual(r.status, 200);
  });

  await test('địa chỉ khác nguồn EMR bị từ chối (không dùng cầu nối gọi máy khác trong bệnh viện)', async () => {
    bridge.hello({ bridgeId: 'b1', emrOrigin: ORIGIN });
    await assert.rejects(bridge.request({ url: 'http://192.168.2.1/admin' }), /Chỉ lấy được trang thuộc EMR/);
    await assert.rejects(bridge.request({ url: '//evil.example/x' }), /Chỉ lấy được trang thuộc EMR/);
    assert.strictEqual(bridge.toEmrPath('ylenh.aspx?a=1', ORIGIN), '/ylenh.aspx?a=1');
  });

  await test('tab EMR báo lỗi / EMR đăng xuất → lỗi rõ ràng', async () => {
    bridge.hello({ bridgeId: 'b1', emrOrigin: ORIGIN });
    const p = bridge.request({ url: '/a' });
    await fakeBridgeOnce('b1', async () => ({ ok: false, error: 'Failed to fetch' }));
    await assert.rejects(p, /Tab EMR không lấy được trang: Failed to fetch/);
    bridge.hello({ bridgeId: 'b1', emrOrigin: ORIGIN, emrLoggedIn: false });
    await assert.rejects(bridge.request({ url: '/a' }), e => e.code === 'BRIDGE_EMR_LOGGED_OUT');
    assert.match(bridge.collectionBlocker(), /đã đăng xuất/);
  });

  await test('mở cầu nối ở tab khác thay cầu nối cũ: yêu cầu đang chờ ở cầu cũ báo lỗi', async () => {
    bridge.hello({ bridgeId: 'b1', emrOrigin: ORIGIN });
    const p = bridge.request({ url: '/a' });
    bridge.hello({ bridgeId: 'b2', emrOrigin: ORIGIN });
    await assert.rejects(p, /vừa được mở ở tab\/máy khác/);
    await assert.rejects(bridge.poll('b1', { waitMs: 10 }), e => e.code === 'BRIDGE_UNKNOWN');
  });

  await test('cổng nội bộ cho worker: sai mã → 403; worker Python (EmrHttpSession) đi qua cầu nối', async () => {
    const app = express();
    app.use('/api/emr-bridge/internal', routes.internalRouter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}/api/emr-bridge/internal`;
    try {
      const bad = await fetch(`${base}/fetch`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-token': 'sai' }, body: '{}' });
      assert.strictEqual(bad.status, 403);

      bridge.hello({ bridgeId: 'b1', emrOrigin: ORIGIN, emrUrl: `${ORIGIN}/home.aspx?usid=9&st=7&wpid=khac` });
      let stop = false;
      const served = [];
      const loop = (async () => {
        while (!stop) {
          await fakeBridgeOnce('b1', async (r) => {
            served.push(r);
            if (r.method === 'POST') return { ok: true, status: 200, url: ORIGIN + r.path, text: `POST:${r.body}|${r.content_type}|${r.headers['X-AjaxPro-Method'] || ''}` };
            return { ok: true, status: 200, url: ORIGIN + r.path, text: `<html>danh sach ${r.path}</html>` };
          }).catch(() => {});
        }
      })();
      const py = `
import json
from emr_http_reader import EmrHttpSession, bridge_mode, bridge_info
s = EmrHttpSession.from_config_dict({"url_login": "${ORIGIN}/login.aspx", "url_inpatient_list": "${ORIGIN}/home.aspx?wpid=ds"})
info = bridge_info()
html, url = s.get_html("${ORIGIN}/home.aspx?wpid=ds")
post, _ = s.post_html("/ajax.aspx", {"a": "1 2"})
raw, _ = s._request_html("POST", "/ajaxpro/x.ashx", data='{"q":1}', headers={"Content-Type": "text/plain; charset=utf-8", "X-AjaxPro-Method": "Draw", "User-Agent": "x"})
print(json.dumps({"bridge": bridge_mode(), "info_url": info.get("emr_url"), "html": html, "url": url, "post": post, "raw": raw, "cookies": s.load_cookies()}))
`;
      const out = await new Promise((resolve, reject) => {
        const child = spawn(process.env.PYTHON_BIN || 'python3', ['-c', py], {
          cwd: path.join(__dirname, '..', 'worker'),
          env: { ...process.env, PYTHONPATH: path.join(__dirname, '..', 'worker'), EMR_BRIDGE_URL: `${base}/fetch`, EMR_BRIDGE_TOKEN: bridge.internalToken() },
        });
        let so = ''; let se = '';
        child.stdout.on('data', d => { so += d; });
        child.stderr.on('data', d => { se += d; });
        child.on('close', code => (code === 0 ? resolve(so) : reject(new Error(`python exit ${code}: ${se}`))));
      });
      stop = true;
      await loop;
      const r = JSON.parse(out.trim().split('\n').pop());
      assert.strictEqual(r.bridge, true);
      assert.strictEqual(r.info_url, `${ORIGIN}/home.aspx?usid=9&st=7&wpid=khac`);
      assert.strictEqual(r.html, '<html>danh sach /home.aspx?wpid=ds</html>');
      assert.strictEqual(r.url, `${ORIGIN}/home.aspx?wpid=ds`);
      assert.strictEqual(r.post, 'POST:a=1+2|application/x-www-form-urlencoded; charset=UTF-8|');
      assert.strictEqual(r.raw, 'POST:{"q":1}|text/plain; charset=utf-8|Draw');
      assert.strictEqual(r.cookies, false);
      assert.ok(served.every(x => x.path.startsWith('/')), 'chỉ gửi đường dẫn tương đối');
    } finally {
      server.close();
    }
  });

  await test('kết nối hỏi việc bị ngắt giữa chừng: việc được trả lại hàng đợi, không mất', async () => {
    bridge.hello({ bridgeId: 'b1', emrOrigin: ORIGIN });
    const signal = {};
    const first = bridge.poll('b1', { waitMs: 2000, signal });
    const p = bridge.request({ url: '/mat-giua-chung' });
    const taken = await first;
    assert.strictEqual(taken.length, 1);
    bridge.requeue('b1', taken); // route thấy kết nối đã đóng
    const seen = await fakeBridgeOnce('b1', async () => ({ ok: true, status: 200, url: ORIGIN, text: 'lan 2' }));
    assert.strictEqual(seen[0].path, '/mat-giua-chung');
    assert.strictEqual((await p).text, 'lan 2');
    // Hủy lượt chờ: lượt đó trả rỗng, việc mới đến lượt sau.
    const sig2 = {};
    const waiting = bridge.poll('b1', { waitMs: 2000, signal: sig2 });
    sig2.cancel();
    assert.deepStrictEqual(await waiting, []);
  });

  await test('worker được cấp biến môi trường cầu nối chỉ khi bật EMR_BRIDGE_MODE', async () => {
    assert.match(bridge.workerEnv().EMR_BRIDGE_URL, /^http:\/\/127\.0\.0\.1:\d+\/api\/emr-bridge\/internal\/fetch$/);
    process.env.EMR_BRIDGE_MODE = '';
    assert.deepStrictEqual(bridge.workerEnv(), {});
    assert.strictEqual(bridge.collectionBlocker(), '');
    process.env.EMR_BRIDGE_MODE = '1';
  });

  bridge.__resetEmrBridge();
  if (failed) process.exit(1);
  console.log('8 test(s) passed.');
})();
