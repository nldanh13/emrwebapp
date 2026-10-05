import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { isProtectedAction, PROTECTED_ACTIONS } = require('./dangerous_action_dedupe.js');

function req(path, method = 'POST') {
  return { path, method };
}

describe('dangerous action dedupe routing', () => {
  it('protects high-risk EMR write actions', () => {
    expect(isProtectedAction(req('/run-input-care'))).toBe(true);
    expect(isProtectedAction(req('/clinic/input-care'))).toBe(true);
    expect(isProtectedAction(req('/hchanh/sign-discharge-bundle'))).toBe(true);
    expect(PROTECTED_ACTIONS.size).toBeGreaterThan(5);
  });

  it('does not dedupe reads, previews, or ordinary POSTs', () => {
    expect(isProtectedAction(req('/run-input-care', 'GET'))).toBe(false);
    expect(isProtectedAction(req('/clinic/care-preview'))).toBe(false);
    expect(isProtectedAction(req('/research/archive/normalize'))).toBe(false);
  });
});
