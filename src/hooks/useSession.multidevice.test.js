// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { getSessionId, getWorkspaceShareUrl } from './useSession.js';

const WORKSPACE = 'shared-workspace-2026';

describe('multi-device workspace', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('joins the workspace supplied in the URL and persists it locally', () => {
    window.history.replaceState({}, '', `/?workspace=${WORKSPACE}`);
    expect(getSessionId()).toBe(WORKSPACE);
    expect(localStorage.getItem('emr_session_id_v1')).toBe(WORKSPACE);
    expect(sessionStorage.getItem('emr_session_id_v1')).toBe(WORKSPACE);
  });

  it('keeps the shared workspace after the query parameter is removed', () => {
    window.history.replaceState({}, '', `/?workspace=${WORKSPACE}`);
    expect(getSessionId()).toBe(WORKSPACE);
    window.history.replaceState({}, '', '/');
    expect(getSessionId()).toBe(WORKSPACE);
  });

  it('creates a share URL that points to the current workspace', () => {
    window.history.replaceState({}, '', `/?workspace=${WORKSPACE}`);
    const url = new URL(getWorkspaceShareUrl());
    expect(url.searchParams.get('workspace')).toBe(WORKSPACE);
    expect(url.searchParams.has('sid')).toBe(false);
  });
});
