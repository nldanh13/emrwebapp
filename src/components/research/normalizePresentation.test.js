import { describe, expect, it } from 'vitest';
import {
  normalizeStagePresentation,
  normalizeSchemaOutdated,
} from './normalizePresentation.js';

describe('normalize presentation', () => {
  it('does not call an integrity-failed run "chưa chạy"', () => {
    const p = normalizeStagePresentation({
      normalize: {
        status: 'failed',
        integrity_status: 'failed_integrity',
        at: '2026-10-07T10:30:00Z',
      },
      qa: {
        blocking: 1,
        blocking_items: [{
          code: 'input_changed_during_normalize',
          message: 'Nguồn thay đổi trong lúc Chuẩn hóa.',
          files: ['hchanh_surgery.csv'],
        }],
      },
    });
    expect(p.state).toBe('nguồn vừa thay đổi');
    expect(p.transientInputChange).toBe(true);
    expect(p.hasRun).toBe(true);
  });

  it('keeps real integrity blockers distinct from transient input changes', () => {
    const p = normalizeStagePresentation({
      normalize: {
        status: 'failed',
        integrity_status: 'failed_integrity',
        at: '2026-10-07T10:30:00Z',
      },
      qa: {
        blocking: 2,
        blocking_items: [
          { code: 'input_changed_during_normalize' },
          { code: 'event_outside_encounter' },
        ],
      },
    });
    expect(p.state).toBe('2 lỗi chặn');
    expect(p.transientInputChange).toBe(false);
  });

  it('shows a previous failed run as needing rerun, not as never run', () => {
    const p = normalizeStagePresentation({
      normalize: { status: 'failed', at: '2026-10-07T10:30:00Z' },
      qa: {},
    });
    expect(p.state).toBe('cần chạy lại');
    expect(p.hasRun).toBe(true);
  });

  it('detects an old normalized snapshot against the running server schema', () => {
    expect(normalizeSchemaOutdated(35, 36)).toBe(true);
    expect(normalizeSchemaOutdated(36, 36)).toBe(false);
    expect(normalizeSchemaOutdated(null, 36)).toBe(false);
  });
});
