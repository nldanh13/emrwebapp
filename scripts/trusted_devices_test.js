#!/usr/bin/env node
'use strict';
// Thiết bị tin cậy: trình duyệt giữ khóa riêng (WebCrypto, không chép ra được), ký từng yêu cầu;
// máy chủ chỉ coi là tin cậy khi chữ ký đúng, còn hạn thời gian, thiết bị đã duyệt, đúng người.
// Thiết bị đầu tiên duyệt bằng mã 8 số dùng một lần (lấy trên máy chủ).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trusted-dev-'));
process.env.EMR_TRUSTED_DEVICES_FILE = path.join(dir, 'trusted_devices.json');
const td = require('../server/services/trusted_devices');

async function makeKey() {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  const sign = async (msg) => Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(msg))).toString('base64');
  return { jwk, sign };
}

(async () => {
  let failed = 0;
  const test = async (name, fn) => { try { await fn(); console.log(`  ok - ${name}`); } catch (e) { failed += 1; console.error(`  FAIL - ${name}\n`, e); } };
  console.log('trusted_devices_test');

  const phone = await makeKey();
  const stranger = await makeKey();
  let phoneId;
  const now = Date.now();
  const signed = async (key, id, method, url, ts = now) => ({
    deviceId: id, ts: String(ts), sig: await key.sign(td.signingMessage({ ts: String(ts), method, url })), method, url, now,
  });

  await test('đăng ký → chờ duyệt, chưa tin cậy', async () => {
    const d = td.registerDevice({ userId: 'quantri', name: 'Điện thoại Danh', publicKeyJwk: phone.jwk });
    phoneId = d.id;
    assert.strictEqual(d.status, 'pending');
    const v = td.verifyRequest({ ...(await signed(phone, phoneId, 'GET', '/api/data')), userId: 'quantri' });
    assert.strictEqual(v, null);
  });

  await test('mã 8 số dùng một lần duyệt được thiết bị đầu tiên; dùng lại thì không được', async () => {
    const code = td.createSetupCode({ now });
    assert.match(code, /^\d{8}$/);
    assert.strictEqual(td.approveWithSetupCode(phoneId, { code, userId: 'quantri', now }).status, 'trusted');
    assert.throws(() => td.approveWithSetupCode(phoneId, { code, userId: 'quantri', now }), /Mã xác nhận không đúng hoặc đã hết hạn/);
  });

  await test('mã hết hạn sau 10 phút', async () => {
    const code = td.createSetupCode({ now });
    const other = td.registerDevice({ userId: 'quantri', name: 'Máy nhà', publicKeyJwk: (await makeKey()).jwk });
    assert.throws(() => td.approveWithSetupCode(other.id, { code, userId: 'quantri', now: now + 11 * 60 * 1000 }), /hết hạn/);
  });

  await test('đã duyệt + chữ ký đúng → tin cậy', async () => {
    const v = td.verifyRequest({ ...(await signed(phone, phoneId, 'GET', '/api/data?x=1')), userId: 'quantri' });
    assert.strictEqual(v.id, phoneId);
  });

  await test('chữ ký của máy khác, sai đường dẫn, quá hạn thời gian, sai người → không tin cậy', async () => {
    assert.strictEqual(td.verifyRequest({ ...(await signed(stranger, phoneId, 'GET', '/api/data')), userId: 'quantri' }), null);
    const s = await signed(phone, phoneId, 'GET', '/api/data');
    assert.strictEqual(td.verifyRequest({ ...s, url: '/api/khac', userId: 'quantri' }), null);
    assert.strictEqual(td.verifyRequest({ ...(await signed(phone, phoneId, 'GET', '/api/data', now - 5 * 60 * 1000)), userId: 'quantri' }), null);
    assert.strictEqual(td.verifyRequest({ ...s, userId: 'nguoi_khac' }), null);
  });

  await test('thu hồi → hết tin cậy ngay', async () => {
    td.revokeDevice(phoneId, { by: 'quantri' });
    assert.strictEqual(td.verifyRequest({ ...(await signed(phone, phoneId, 'GET', '/api/data')), userId: 'quantri' }), null);
  });

  await test('khóa công khai sai dạng bị từ chối, bằng tiếng Việt', async () => {
    assert.throws(() => td.registerDevice({ userId: 'u', name: 'x', publicKeyJwk: { kty: 'RSA' } }), /Khóa thiết bị không hợp lệ/);
  });

  await test('file chỉ lưu khóa CÔNG KHAI và bản băm của mã xác nhận', async () => {
    const raw = fs.readFileSync(process.env.EMR_TRUSTED_DEVICES_FILE, 'utf8');
    assert.ok(!/"d"\s*:/.test(raw), 'không được có khóa riêng');
    assert.ok(!/"code"\s*:\s*"\d{8}"/.test(raw), 'không lưu mã rõ');
  });

  fs.rmSync(dir, { recursive: true, force: true });
  if (failed) process.exit(1);
  console.log('8 test(s) passed.');
})();
