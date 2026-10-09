// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  chooseWorkspace,
  decideWorkspace,
  getSessionId,
  getWorkspaceChoice,
  isCurrentWorkspaceShared,
  joinSharedWorkspace,
  setKnownSharedWorkspace,
} from './useSession.js';

const SHARED = 'kho-chung-khoa-01';
const PRIVATE = 'rieng-may-02';

describe('kho chung: máy nào vào kho chung, máy nào được hỏi', () => {
  it('không có kho chung → giữ nguyên', () => {
    expect(decideWorkspace({ shared: null, current: { sid: PRIVATE, has_data: false }, choice: '' })).toBe('none');
  });
  it('đang ở kho chung → giữ nguyên', () => {
    expect(decideWorkspace({ shared: { sid: SHARED }, current: { sid: SHARED, is_shared: true, has_data: true }, choice: '' })).toBe('none');
  });
  it('máy mới chưa có dữ liệu → vào thẳng kho chung', () => {
    expect(decideWorkspace({ shared: { sid: SHARED }, current: { sid: PRIVATE, has_data: false }, choice: '' })).toBe('switch');
  });
  it('máy đang có dữ liệu riêng → hỏi, không tự chuyển', () => {
    expect(decideWorkspace({ shared: { sid: SHARED }, current: { sid: PRIVATE, has_data: true }, choice: '' })).toBe('ask');
  });
  it('đã chọn giữ dữ liệu riêng hoặc mở bằng link → không hỏi lại, không tự chuyển', () => {
    for (const choice of ['private', 'link']) {
      expect(decideWorkspace({ shared: { sid: SHARED }, current: { sid: PRIVATE, has_data: false }, choice })).toBe('none');
      expect(decideWorkspace({ shared: { sid: SHARED }, current: { sid: PRIVATE, has_data: true }, choice })).toBe('none');
    }
  });
});

describe('kho chung: ghi nhớ lựa chọn trên máy', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState({}, '', '/');
    setKnownSharedWorkspace(SHARED);
  });

  it('vào kho chung: đổi workspace, nhớ lựa chọn, bỏ link workspace cũ trên thanh địa chỉ', () => {
    window.history.replaceState({}, '', `/?workspace=${PRIVATE}`);
    expect(getSessionId()).toBe(PRIVATE);
    expect(getWorkspaceChoice()).toBe('link');
    expect(joinSharedWorkspace(SHARED)).toBe(true);
    expect(new URL(window.location.href).searchParams.has('workspace')).toBe(false);
    expect(getSessionId()).toBe(SHARED);
    expect(getWorkspaceChoice()).toBe('shared');
    expect(isCurrentWorkspaceShared()).toBe(true);
    expect(joinSharedWorkspace(SHARED)).toBe(false);
  });

  it('mở bằng link chính kho chung không bị tính là dữ liệu riêng', () => {
    window.history.replaceState({}, '', `/?workspace=${SHARED}`);
    expect(getSessionId()).toBe(SHARED);
    expect(getWorkspaceChoice()).toBe('');
  });

  it('tự chọn bộ dữ liệu ở Đổi dữ liệu: nhớ là riêng hay kho chung', () => {
    chooseWorkspace(PRIVATE);
    expect(getWorkspaceChoice()).toBe('private');
    expect(isCurrentWorkspaceShared()).toBe(false);
    chooseWorkspace(SHARED);
    expect(getWorkspaceChoice()).toBe('shared');
    expect(isCurrentWorkspaceShared()).toBe(true);
  });
});
