const root = document.getElementById('root');
const startedAt = Date.now();

function safeMessage(error) {
  const raw = error?.stack || error?.message || String(error || 'Không rõ lỗi khởi tạo.');
  return raw.replace(/[<>]/g, '').slice(0, 3000);
}

function showBootstrapFailure(error) {
  if (window.__EMR_APP_MOUNTED__ || !root) return;
  const elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  root.innerHTML = `
    <main class="emr-bootstrap-error" role="alert">
      <section>
        <div class="emr-bootstrap-error__eyebrow">Lỗi khởi tạo giao diện</div>
        <h1>Không tải được web app</h1>
        <p>Ứng dụng gặp lỗi trước khi React khởi động. Hãy tải lại trang; nếu lỗi còn lặp lại, sao chép nội dung bên dưới để kiểm tra.</p>
        <div class="emr-bootstrap-error__actions">
          <button type="button" data-emr-reload>Tải lại</button>
          <button type="button" data-emr-clear-state>Xóa trạng thái giao diện</button>
        </div>
        <pre>${safeMessage(error)}\nThời gian chờ: ${elapsed}s</pre>
      </section>
    </main>`;

  root.querySelector('[data-emr-reload]')?.addEventListener('click', () => window.location.reload());
  root.querySelector('[data-emr-clear-state]')?.addEventListener('click', () => {
    try {
      localStorage.removeItem('emr_active_tab_v1');
      localStorage.removeItem('emr_active_tab_v2');
      localStorage.removeItem('emr_work_date_range_v1');
    } catch {}
    window.location.reload();
  });
}

window.addEventListener('error', event => {
  showBootstrapFailure(event.error || event.message || 'Lỗi tải module giao diện.');
});
window.addEventListener('unhandledrejection', event => {
  showBootstrapFailure(event.reason || 'Promise bị từ chối khi khởi tạo giao diện.');
});

window.__EMR_BOOTSTRAP_TIMER__ = window.setTimeout(() => {
  showBootstrapFailure('Giao diện không khởi động trong thời gian cho phép.');
}, 15000);
