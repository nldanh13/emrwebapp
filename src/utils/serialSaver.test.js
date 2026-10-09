import { describe, expect, it, vi } from 'vitest';
import { createSerialSaver } from './serialSaver.js';

describe('createSerialSaver', () => {
  it('gộp các thay đổi liên tiếp, chỉ lưu bản mới nhất', async () => {
    vi.useFakeTimers();
    const saved = [];
    const saver = createSerialSaver(async v => { saved.push(v); }, { delay: 100 });
    saver.schedule(1); saver.schedule(2); saver.schedule(3);
    await vi.advanceTimersByTimeAsync(150);
    await saver.idle();
    expect(saved).toEqual([3]);
    vi.useRealTimers();
  });

  it('không gửi hai lần lưu chồng nhau', async () => {
    vi.useFakeTimers();
    let active = 0; let maxActive = 0; const saved = [];
    let release;
    const saver = createSerialSaver(async v => {
      active += 1; maxActive = Math.max(maxActive, active);
      if (v === 'a') await new Promise(r => { release = r; });
      saved.push(v); active -= 1;
    }, { delay: 10 });
    saver.schedule('a');
    await vi.advanceTimersByTimeAsync(20);
    saver.schedule('b');
    await vi.advanceTimersByTimeAsync(20);
    expect(saved).toEqual([]);
    release();
    await saver.idle();
    expect(saved).toEqual(['a', 'b']);
    expect(maxActive).toBe(1);
    vi.useRealTimers();
  });

  it('cancel bỏ bản đang chờ; lỗi được báo và lần lưu sau vẫn chạy', async () => {
    vi.useFakeTimers();
    const saved = []; const errors = [];
    const saver = createSerialSaver(async v => { if (v === 'x') throw new Error('409'); saved.push(v); }, { delay: 10, onError: e => errors.push(e.message) });
    saver.schedule('bỏ'); saver.cancel();
    await vi.advanceTimersByTimeAsync(20);
    saver.schedule('x'); await saver.flush();
    saver.schedule('y'); await saver.flush();
    expect(saved).toEqual(['y']);
    expect(errors).toEqual(['409']);
    vi.useRealTimers();
  });
});
