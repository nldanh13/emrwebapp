// Chữ ký trình duyệt phải được MÁY CHỦ chấp nhận (cùng chuỗi ký, cùng định dạng chữ ký), và lớp
// bọc fetch chỉ ký yêu cầu /api cùng nguồn.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import { deviceSignatureHeaders, installDeviceSigningFetch, __resetDeviceTrust } from './deviceTrust.js';

const require = createRequire(import.meta.url);
const nodeCrypto = require('crypto');
const server = require('../../server/services/trusted_devices.js');

async function makeRecord() {
  const keyPair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  return { keyPair, deviceId: 'dev1', jwk: await webcrypto.subtle.exportKey('jwk', keyPair.publicKey) };
}

afterEach(() => { __resetDeviceTrust(null); vi.restoreAllMocks(); });

describe('deviceTrust', () => {
  it('chữ ký của trình duyệt được máy chủ xác minh', async () => {
    const rec = await makeRecord();
    __resetDeviceTrust({ keyPair: rec.keyPair, deviceId: rec.deviceId });
    const h = await deviceSignatureHeaders('get', '/api/data?x=1');
    expect(h['x-device-id']).toBe('dev1');
    const ok = nodeCrypto.verify('sha256',
      Buffer.from(server.signingMessage({ ts: h['x-device-ts'], method: 'GET', url: '/api/data?x=1' })),
      { key: nodeCrypto.createPublicKey({ key: rec.jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
      Buffer.from(h['x-device-sig'], 'base64'));
    expect(ok).toBe(true);
  });

  it('chưa đăng ký thiết bị thì không ký gì', async () => {
    __resetDeviceTrust(null);
    expect(await deviceSignatureHeaders('GET', '/api/data')).toEqual({});
  });

  it('chỉ ký yêu cầu /api cùng nguồn', async () => {
    const rec = await makeRecord();
    const seen = [];
    window.fetch = vi.fn(async (input, init) => { seen.push({ input, headers: new Headers(init?.headers || {}) }); return new Response('{}'); });
    __resetDeviceTrust({ keyPair: rec.keyPair, deviceId: rec.deviceId });
    installDeviceSigningFetch();
    await window.fetch('/api/data', { headers: { 'x-app-token': 't' } });
    await window.fetch('https://khac.vn/api/data');
    await window.fetch('/assets/app.js');
    expect(seen[0].headers.get('x-device-sig')).toBeTruthy();
    expect(seen[0].headers.get('x-app-token')).toBe('t');
    expect(seen[1].headers.get('x-device-sig')).toBeNull();
    expect(seen[2].headers.get('x-device-sig')).toBeNull();
  });
});
