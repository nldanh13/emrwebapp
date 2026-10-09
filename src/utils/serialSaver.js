// Tự lưu "lần lượt, bản mới nhất": chờ người dùng ngừng sửa một chút rồi lưu, và không bao giờ gửi
// hai lần lưu chồng nhau. Cần cho dữ liệu có kiểm tra phiên bản (If-Match): lần lưu thứ hai gửi đi
// trước khi lần đầu trả về sẽ mang phiên bản cũ và bị máy chủ chặn như thể máy khác đã sửa.
export function createSerialSaver(save, { delay = 800, onError = () => {} } = {}) {
  let timer = null;
  let pending = null;
  let hasPending = false;
  let running = Promise.resolve();

  const run = () => {
    timer = null;
    if (!hasPending) return running;
    const value = pending;
    hasPending = false;
    pending = null;
    running = running.then(() => save(value)).catch(err => { onError(err); });
    return running;
  };

  return {
    schedule(value) {
      pending = value;
      hasPending = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, delay);
    },
    /** Lưu ngay bản đang chờ (vd. rời màn hình); trả về khi mọi lần lưu đã xong. */
    flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      return run();
    },
    /** Bỏ bản đang chờ (vd. vừa nạp bản mới của người khác từ máy chủ). */
    cancel() {
      if (timer) { clearTimeout(timer); timer = null; }
      hasPending = false;
      pending = null;
    },
    idle() { return running; },
    /** Còn thay đổi chưa gửi đi. */
    hasPending() { return hasPending; },
  };
}
