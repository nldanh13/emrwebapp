#!/usr/bin/env node
'use strict';
// Bật EMR_REQUIRE_TRUSTED_DEVICE=1 (trên VPS): máy lạ đăng nhập đúng vẫn KHÔNG nhận dữ liệu nào,
// chỉ được xem trạng thái và đăng ký thiết bị. Thiết bị tin cậy dùng bình thường.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqtrust-'));
process.env.EMR_RUNTIME_ROOT = path.join(dir, 'runtime');
process.env.EMR_TRUSTED_DEVICES_FILE = path.join(dir, 'trusted_devices.json');
process.env.EMR_USERS_FILE = path.join(dir, 'users.json');
process.env.EMR_REQUIRE_TRUSTED_DEVICE = '1';
const TOKEN = 'u'.repeat(32);
fs.writeFileSync(process.env.EMR_USERS_FILE, JSON.stringify([{ id: 'dd', name: 'ĐD', role: 'operator', token: TOKEN }]));

const express = require('express');
const authz = require('../server/services/authz');
const td = require('../server/services/trusted_devices');

(async () => {
  const app = express();
  app.use('/api', authz.authenticateRequest, authz.attachDeviceTrust, authz.requireTrustedDevice, express.json());
  app.use('/api', authz.authorizeRequest, require('../server/routes/devices'));
  app.use('/api', authz.authorizeRequest, require('../server/routes/emr_bridge'));
  app.get('/api/data', (_req, res) => res.json({ status: 'ok', patients: ['NGUYỄN VĂN A'] }));
  app.get('/api/auth/me', (req, res) => res.json({ status: 'ok', user: req.auth }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  let deviceId = '';
  async function call(method, url, { body, sign = false } = {}) {
    const h = { 'x-app-token': TOKEN, 'content-type': 'application/json' };
    if (sign && deviceId) {
      const ts = String(Date.now());
      const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(td.signingMessage({ ts, method, url })));
      Object.assign(h, { 'x-device-id': deviceId, 'x-device-ts': ts, 'x-device-sig': Buffer.from(sig).toString('base64') });
    }
    const r = await fetch(base + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  }

  let failed = 0;
  const test = async (name, fn) => { try { await fn(); console.log(`  ok - ${name}`); } catch (e) { failed += 1; console.error(`  FAIL - ${name}\n`, e); } };
  console.log('require_trusted_device_test');

  await test('máy lạ: dữ liệu bị chặn (403, câu tiếng Việt, không lộ dữ liệu)', async () => {
    const r = await call('GET', '/api/data');
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.json.code, 'DEVICE_NOT_TRUSTED');
    assert.match(r.json.message, /chưa được tin cậy/);
    assert.ok(!JSON.stringify(r.json).includes('NGUYỄN'));
  });

  await test('máy bệnh viện (chưa tin cậy) vẫn mở được cầu nối EMR — chỉ chuyển trang lên, không đọc kho', async () => {
    const r = await call('GET', '/api/emr-bridge/status');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(typeof r.json.bridge.connected, 'boolean');
  });

  await test('máy lạ vẫn xem được trạng thái và đăng ký thiết bị', async () => {
    assert.strictEqual((await call('GET', '/api/auth/me')).status, 200);
    const me = await call('GET', '/api/devices/me');
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.json.require_trusted, true);
    const reg = await call('POST', '/api/devices/register', { body: { name: 'ĐT', public_key: jwk } });
    assert.strictEqual(reg.status, 200);
    deviceId = reg.json.device.id;
  });

  await test('sau khi được tin cậy, yêu cầu có chữ ký nhận dữ liệu bình thường', async () => {
    const code = td.createSetupCode();
    await call('POST', `/api/devices/${deviceId}/approve`, { body: { setup_code: code } });
    const r = await call('GET', '/api/data', { sign: true });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await call('GET', '/api/data')).status, 403, 'không ký thì vẫn bị chặn');
  });

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (failed) process.exit(1);
  console.log('4 test(s) passed.');
})();
