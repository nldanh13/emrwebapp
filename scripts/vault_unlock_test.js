#!/usr/bin/env node
'use strict';
// Trang Mở kho (VPS khởi động lại, kho mã hóa chưa mở): chỉ thiết bị tin cậy gửi được mật khẩu kho;
// sai mật khẩu → báo tiếng Việt, sai 5 lần khóa tạm; đúng → mở kho rồi khởi động ứng dụng.
// Lệnh mở kho thật (gocryptfs) được thay bằng lệnh giả để test.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
process.env.EMR_TRUSTED_DEVICES_FILE = path.join(dir, 'trusted_devices.json');
const fakeMount = path.join(dir, 'fake_mount.js');
fs.writeFileSync(fakeMount, "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.exit(s.trim()==='dung-mat-khau'?0:1));");
const td = require('../server/services/trusted_devices');
const { createUnlockApp } = require('../server/vault_unlock_server');

(async () => {
  let started = 0;
  const app = createUnlockApp({
    mountCommand: [process.execPath, fakeMount],
    afterUnlock: async () => { started += 1; },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const dev = td.registerDevice({ userId: 'quantri', name: 'ĐT', publicKeyJwk: await webcrypto.subtle.exportKey('jwk', pair.publicKey) });
  const unlock = async (passphrase, { sign = true, ip = '9.9.9.9' } = {}) => {
    const url = '/api/vault/unlock';
    const h = { 'content-type': 'application/json', 'x-forwarded-for': ip };
    if (sign) {
      const ts = String(Date.now());
      const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(td.signingMessage({ ts, method: 'POST', url })));
      Object.assign(h, { 'x-device-id': dev.id, 'x-device-ts': ts, 'x-device-sig': Buffer.from(sig).toString('base64') });
    }
    const r = await fetch(base + url, { method: 'POST', headers: h, body: JSON.stringify({ passphrase }) });
    return { status: r.status, json: await r.json() };
  };

  let failed = 0;
  const test = async (name, fn) => { try { await fn(); console.log(`  ok - ${name}`); } catch (e) { failed += 1; console.error(`  FAIL - ${name}\n`, e); } };
  console.log('vault_unlock_test');

  await test('trang trạng thái báo kho đang khóa; trang Mở kho phục vụ ở mọi đường dẫn', async () => {
    assert.deepStrictEqual(await (await fetch(`${base}/api/vault/status`)).json(), { status: 'ok', locked: true });
    const html = await (await fetch(`${base}/bat-ky`)).text();
    assert.match(html, /Mở kho dữ liệu/);
    // Mã JS trong trang phải hợp lệ (trang chạy độc lập, không qua vite build).
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    new (require('vm').Script)(script);
    // Chuỗi ký phải giống hệt phía máy chủ.
    assert.match(script, /ts \+ '\\n' \+ method\.toUpperCase\(\) \+ '\\n' \+ url/);
    assert.match(script, /'emr-device-trust'/);
  });

  await test('thiết bị chưa tin cậy (hoặc không ký) → không gửi được mật khẩu', async () => {
    const r = await unlock('dung-mat-khau', { sign: false });
    assert.strictEqual(r.status, 403);
    assert.match(r.json.message, /thiết bị tin cậy/);
    td.approveDevice(dev.id, { by: 'test' });
  });

  await test('sai mật khẩu kho → 401 tiếng Việt, không khởi động ứng dụng', async () => {
    const r = await unlock('sai');
    assert.strictEqual(r.status, 401);
    assert.match(r.json.message, /Mật khẩu kho không đúng/);
    assert.strictEqual(started, 0);
  });

  await test('sai 5 lần → khóa tạm 15 phút (IP đó)', async () => {
    for (let i = 0; i < 5; i += 1) await unlock('sai', { ip: '8.8.8.8' });
    const r = await unlock('dung-mat-khau', { ip: '8.8.8.8' });
    assert.strictEqual(r.status, 429);
  });

  await test('đúng mật khẩu từ thiết bị tin cậy → mở kho, khởi động ứng dụng', async () => {
    const r = await unlock('dung-mat-khau');
    assert.strictEqual(r.status, 200);
    await new Promise(res => setTimeout(res, 50));
    assert.strictEqual(started, 1);
  });

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (failed) process.exit(1);
  console.log('5 test(s) passed.');
})();
