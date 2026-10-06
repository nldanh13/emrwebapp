'use strict';

const { describe, it, expect, vi } = require('vitest');
const { isProtectedPath, requestFingerprint, effectiveKey } = require('./idempotency');

function req({ method = 'POST', path = '/run-details', originalUrl = path, body = {}, key = '' } = {}) {
  return {
    method,
    path,
    originalUrl,
    body,
    get(name) { return String(name).toLowerCase() === 'idempotency-key' ? key : ''; },
  };
}

describe('idempotency middleware helpers', () => {
  it('protects high-risk mutations but excludes cancel/client-log', () => {
    expect(isProtectedPath(req({ path: '/run-details' }))).toBe(true);
    expect(isProtectedPath(req({ path: '/research/archive/collect-auto' }))).toBe(true);
    expect(isProtectedPath(req({ path: '/hchanh/fetch' }))).toBe(true);
    expect(isProtectedPath(req({ path: '/cancel' }))).toBe(false);
    expect(isProtectedPath(req({ path: '/client-log' }))).toBe(false);
  });

  it('fingerprints method, URL and body deterministically', () => {
    const a = requestFingerprint(req({ body: { patient: 1 }, originalUrl: '/run-details?partial=1' }));
    const b = requestFingerprint(req({ body: { patient: 1 }, originalUrl: '/run-details?partial=1' }));
    const c = requestFingerprint(req({ body: { patient: 2 }, originalUrl: '/run-details?partial=1' }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('uses explicit idempotency key when supplied', () => {
    const r = req({ key: 'device-action-12345' });
    const fp = requestFingerprint(r);
    expect(effectiveKey(r, fp)).toEqual({ value: 'device-action-12345', explicit: true });
  });

  it('auto-generates the same key for identical requests in the same short time bucket', () => {
    vi.spyOn(Date, 'now').mockReturnValue(12_345_678);
    const r = req({ body: { patient: 1 } });
    const fp = requestFingerprint(r);
    const a = effectiveKey(r, fp);
    const b = effectiveKey(r, fp);
    expect(a.explicit).toBe(false);
    expect(a.value).toBe(b.value);
    vi.restoreAllMocks();
  });
});
