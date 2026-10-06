#!/usr/bin/env node
'use strict';
// /api/devices qua HTTP: đăng ký → chưa tin cậy; xác nhận bằng mã 8 số → yêu cầu có chữ ký là
// tin cậy; quản trị duyệt máy khác chỉ được khi đang dùng thiết bị tin cậy.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devroute-'));
process.env.EMR_RUNTIME_ROOT = path.join(dir, 'runtime');
process.env.EMR_TRUSTED_DEVICES_FILE = path.join(dir, 'trusted_devices.json');
process.env.EMR_USERS_FILE = path.join(dir, 'users.json');
const ADMIN = 'a'.repeat(32);
fs.writeFileSync(process.env.EMR_USERS_FILE, JSON.stringify([{ id: 'quantri', name: 'QT', role: 'admin', token: ADMIN }]));

const express = require('express');
const authz = require('../server/services/authz');
const td = require('../server/services/trusted_devices');

async function deviceKey() {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  return { pair, jwk: await webcrypto.subtle.exportKey('jwk', pair.publicKey) };
}

(async () => {
  const app = express();
  app.use('/api', authz.authenticateRequest, authz.attachDeviceTrust, express.json());
  app.use('/api', authz.authorizeRequest, require('../server/routes/devices'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, url, { body, key, id } = {}) {
    const h = { 'x-app-token': ADMIN, 'content-type': 'application/json' };
    if (key && id) {
      const ts = String(Date.now());
      const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.pair.privateKey, new TextEncoder().encode(td.signingMessage({ ts, method, url })));
      Object.assign(h, { 'x-device-id': id, 'x-device-ts': ts, 'x-device-sig': Buffer.from(sig).toString('base64') });
    }
    const r = await fetch(base + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  }

  let failed = 0;
  const test = async (name, fn) => { try { await fn(); console.log(`  ok - ${name}`); } catch (e) { failed += 1; console.error(`  FAIL - ${name}\n`, e); } };
  console.log('trusted_devices_route_test');
  const phone = await deviceKey();
  const pc = await deviceKey();
  let phoneId; let pcId;

  await test('đăng ký điện thoại → chưa tin cậy', async () => {
    const r = await call('POST', '/api/devices/register', { body: { name: 'Điện thoại', public_key: phone.jwk } });
    phoneId = r.json.device.id;
    const me = await call('GET', '/api/devices/me', { key: phone, id: phoneId });
    assert.strictEqual(me.json.trusted, false);
  });

  await test('quản trị KHÔNG tự duyệt được khi chưa có thiết bị tin cậy (biết mật khẩu chưa đủ)', async () => {
    const r = await call('POST', `/api/devices/${phoneId}/approve`, { key: phone, id: phoneId });
    assert.strictEqual(r.status, 403);
    assert.match(r.json.message, /thiết bị đã tin cậy|mã xác nhận/);
  });

  await test('mã 8 số → điện thoại tin cậy; yêu cầu có chữ ký được nhận là tin cậy', async () => {
    const code = td.createSetupCode();
    const r = await call('POST', `/api/devices/${phoneId}/approve`, { body: { setup_code: code } });
    assert.strictEqual(r.json.device.status, 'trusted');
    assert.strictEqual((await call('GET', '/api/devices/me', { key: phone, id: phoneId })).json.trusted, true);
    assert.strictEqual((await call('GET', '/api/devices/me')).json.trusted, false, 'không chữ ký → không tin cậy');
  });

  await test('máy tính mới: chỉ duyệt được TỪ điện thoại đã tin cậy', async () => {
    pcId = (await call('POST', '/api/devices/register', { body: { name: 'Máy khoa', public_key: pc.jwk } })).json.device.id;
    assert.strictEqual((await call('POST', `/api/devices/${pcId}/approve`, { key: pc, id: pcId })).status, 403);
    const ok = await call('POST', `/api/devices/${pcId}/approve`, { key: phone, id: phoneId });
    assert.strictEqual(ok.json.device.status, 'trusted');
  });

  await test('thu hồi máy tính → máy đó hết tin cậy', async () => {
    await call('POST', `/api/devices/${pcId}/revoke`, { key: phone, id: phoneId });
    assert.strictEqual((await call('GET', '/api/devices/me', { key: pc, id: pcId })).json.trusted, false);
  });

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (failed) process.exit(1);
  console.log('5 test(s) passed.');
})();
