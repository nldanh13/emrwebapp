# -*- coding: utf-8 -*-
"""shared/worker_session.py — Quản lý vòng đời Selenium cho mọi worker nhập EMR.

Thay thế boilerplate lặp lại ở input_care, input_infusions, input_procedures,
input_vtyt và hchanh_fetch:

    # TRƯỚC (mỗi file lặp ~15 dòng):
    driver, wait = init_driver(headless=config.get("headless"))
    try:
        login_emr(driver, wait, config)
        # ... logic ...
    finally:
        try: driver.quit()
        except: pass
        result_obj = build_worker_result(patient_results)
        write_worker_result(result_path, result_obj)

    # SAU (dùng WorkerSession):
    with WorkerSession(config, result_path) as ws:
        # ws.driver, ws.wait đã sẵn sàng và đã đăng nhập
        for ma_bn, data in items.items():
            ws.results[ma_bn] = {"success": True, "error": None}
        # result tự ghi khi thoát khối with — dù thành công hay exception

Nếu không có dữ liệu, dùng WorkerSession.skip() để ghi result rỗng và thoát sớm:

    if not data:
        WorkerSession.skip(result_path, "Không có dữ liệu phù hợp.")
        return 0
"""
from __future__ import annotations

import os
import sys
import subprocess
import threading
from typing import Any, Callable, Dict, Optional, Tuple

# Imports từ các module đã có trong worker/
# (WorkerSession được import từ worker/, không phải từ ngoài worker/)
from utils import init_driver, login_emr, load_config
from result_schema import build_worker_result, write_worker_result
from selenium_emr_helpers import (
    goto_inpatient_list      as _goto_inpatient_list_base,
    ensure_inpatient_list    as _ensure_inpatient_list_base,
    search_patient_on_ward_or_raise as _search_patient_on_ward_or_raise_base,
    debug_page               as _debug_page_base,
)


# ── Types ─────────────────────────────────────────────────────────────────────

# patient_results: map key -> {"success": bool, "error": str|None, ...}
ResultMap = Dict[str, Dict[str, Any]]


# ── WorkerSession ─────────────────────────────────────────────────────────────

class WorkerSession:
    """Context manager bọc toàn bộ vòng đời Selenium của một worker.

    Attributes:
        driver: Selenium WebDriver đã đăng nhập, sẵn sàng dùng.
        wait:   WebDriverWait(driver, 30) tương ứng.
        config: dict config đã load.
        results: ResultMap để worker điền vào trong quá trình chạy.

    Khi thoát khối with (dù bình thường hay exception):
      - driver.quit() được gọi an toàn.
      - build_worker_result(self.results) + write_worker_result(result_path) được gọi.
    """

    def __init__(
        self,
        config: Dict[str, Any],
        result_path: str,
        *,
        # Hook tùy chọn: gọi sau login_emr, trước khi trả về context.
        # Ví dụ: ensure_inpatient_list(driver, wait, config)
        post_login: Optional[Callable[["WorkerSession"], None]] = None,
        # Tham số bổ sung cho build_worker_result (mode, extra, warnings, ...)
        result_kwargs: Optional[Dict[str, Any]] = None,
    ) -> None:
        self.config = config
        self.result_path = result_path
        self.results: ResultMap = {}
        self._post_login = post_login
        self._result_kwargs: Dict[str, Any] = result_kwargs or {}

        self.driver: Any = None
        self.wait: Any = None

    # ── Context manager ───────────────────────────────────────────────────────

    def __enter__(self) -> "WorkerSession":
        headless = bool(self.config.get("headless", False))
        _print(f">>> Mở trình duyệt Chrome: headless={headless}")
        self.driver, self.wait = init_driver(headless=headless)
        try:
            login_emr(self.driver, self.wait, self.config)
            if self._post_login:
                self._post_login(self)
        except Exception:
            # Đăng nhập thất bại: đóng driver trước khi raise để không leak
            _safe_quit(self.driver)
            self.driver = None
            raise
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> bool:
        # 1) Đóng trình duyệt
        _safe_quit(self.driver)

        # 2) Ghi result file dù thành công hay exception.
        # Một số tác vụ đọc dữ liệu chỉ mượn WorkerSession để đăng nhập Selenium,
        # không có result nghiệp vụ; khi caller truyền /dev/null/nul thì bỏ qua để
        # log không xuất hiện dòng gây hiểu nhầm "0 OK, 0 FAIL".
        result_path = str(self.result_path or "").strip()
        null_targets = {"/dev/null", "nul", "NUL", os.devnull}
        if result_path and result_path not in null_targets:
            try:
                result_obj = build_worker_result(self.results, **self._result_kwargs)
                write_worker_result(self.result_path, result_obj)
                succeeded = len(result_obj.get("succeeded") or [])
                failed    = len(result_obj.get("failed") or {})
                skipped   = result_obj.get("summary", {}).get("skipped_count", 0)
                _print(
                    f"[RESULT] Ghi kết quả: {succeeded} OK, {failed} FAIL, "
                    f"{skipped} SKIP → {self.result_path}"
                )
            except Exception as write_err:
                _print(f"[WARN] Không ghi được result file: {write_err}")

        # Không nuốt exception — để caller xử lý
        return False

    # ── Helpers dùng trong khối with ─────────────────────────────────────────

    def mark_success(self, key: str, **extra: Any) -> None:
        """Ghi nhận một key thành công."""
        self.results[key] = {"success": True, "error": None, **extra}

    def mark_skipped(self, key: str, reason: str, **extra: Any) -> None:
        """Ghi nhận một key bị bỏ qua hợp lệ (không tính là lỗi)."""
        self.results[key] = {"success": True, "skipped": True, "reason": reason, "error": None, **extra}

    def mark_failed(self, key: str, error: Any, **extra: Any) -> None:
        """Ghi nhận một key thất bại."""
        self.results[key] = {"success": False, "error": str(error), **extra}

    # ── Navigation helpers (thay thế _goto/_ensure/_search lặp ở 4 file) ─────

    def goto_inpatient_list(self) -> str:
        """Điều hướng về danh sách nội trú, tự đăng nhập lại nếu session hết hạn."""
        return _goto_inpatient_list_base(
            self.driver, self.wait, self.config,
            login_func=login_emr,
            log_func=_print,
            debug_func=lambda d, lbl: _debug_page_base(d, lbl, log_func=_print),
        )

    def ensure_inpatient_list(self) -> None:
        """Đảm bảo đang ở trang danh sách nội trú; điều hướng về nếu chưa."""
        _ensure_inpatient_list_base(
            self.driver, self.wait, self.config,
            login_func=login_emr,
            log_func=_print,
            debug_func=lambda d, lbl: _debug_page_base(d, lbl, log_func=_print),
        )

    def search_patient(self, ma_bn: str, *, allow_completed: bool = False) -> str:
        """Tìm bệnh nhân trên danh sách nội trú theo trạng thái phù hợp.

        Trả về tên trạng thái tìm được ("Đang thực hiện" / "Hoàn tất").
        Raise RuntimeError nếu BN đang "Đi mổ" hoặc không tìm thấy.
        """
        return _search_patient_on_ward_or_raise_base(
            self.driver, self.wait, self.config, ma_bn,
            login_func=login_emr,
            log_func=_print,
            debug_func=lambda d, lbl: _debug_page_base(d, lbl, log_func=_print),
            allow_completed=allow_completed,
        )

    # ── Class-level helper: ghi result rỗng và thoát sớm ─────────────────────

    @staticmethod
    def skip(result_path: str, reason: str, **result_kwargs: Any) -> None:
        """Ghi worker result rỗng với lý do bỏ qua, KHÔNG mở Chrome.

        Dùng khi không có dữ liệu phù hợp trước khi cần mở trình duyệt:

            if not data:
                WorkerSession.skip(result_path, "Không có dữ liệu.")
                return 0
        """
        try:
            result_obj = build_worker_result({}, skipped_reason=reason, **result_kwargs)
            write_worker_result(result_path, result_obj)
            _print(f"[SKIP] {reason} → {result_path}")
        except Exception as e:
            _print(f"[WARN] Không ghi được result file rỗng: {e}")


# ── Convenience factory ───────────────────────────────────────────────────────

def open_session(
    result_path: str,
    *,
    config: Optional[Dict[str, Any]] = None,
    post_login: Optional[Callable[[WorkerSession], None]] = None,
    result_kwargs: Optional[Dict[str, Any]] = None,
) -> WorkerSession:
    """Tạo WorkerSession với config tự load nếu không truyền vào.

    Cách dùng ngắn gọn nhất:

        with open_session(result_path, post_login=_ensure_inpatient_list) as ws:
            ...
    """
    cfg = config if config is not None else load_config()
    return WorkerSession(cfg, result_path, post_login=post_login, result_kwargs=result_kwargs)


# ── Internal helpers ──────────────────────────────────────────────────────────

def _force_kill_driver_process(driver: Any) -> None:
    """Cưỡng bức dừng ChromeDriver khi ``driver.quit()`` bị treo.

    Trên Windows dùng ``taskkill /T`` để dừng cả process tree (chromedriver +
    Chrome con). Đây chỉ là fallback sau khi quit bình thường đã quá timeout.
    """
    try:
        service = getattr(driver, "service", None)
        proc = getattr(service, "process", None)
        pid = int(getattr(proc, "pid", 0) or 0)
    except Exception:
        proc = None
        pid = 0

    if pid <= 0:
        return

    try:
        if sys.platform.startswith("win"):
            kwargs = {
                "stdout": subprocess.DEVNULL,
                "stderr": subprocess.DEVNULL,
                "timeout": 5,
                "check": False,
            }
            if hasattr(subprocess, "CREATE_NO_WINDOW"):
                kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], **kwargs)
        elif proc is not None:
            proc.kill()
    except Exception:
        try:
            if proc is not None:
                proc.kill()
        except Exception:
            pass

    try:
        if proc is not None:
            proc.wait(timeout=2)
    except Exception:
        pass


def _safe_quit(driver: Any) -> None:
    if driver is None:
        return

    # Selenium/ChromeDriver thỉnh thoảng treo vô hạn ở quit() trên Windows.
    # Nếu để gọi đồng bộ ở đây, worker đã in SUCCESS và đã ghi file output
    # nhưng Python không exit; Node tiếp tục await subprocess tới PY_TIMEOUT_MS.
    # Chạy quit trong daemon thread để có thể timeout mà không giữ tiến trình sống.
    try:
        timeout_seconds = float(os.environ.get("SELENIUM_QUIT_TIMEOUT", "6") or 6)
    except Exception:
        timeout_seconds = 6.0
    timeout_seconds = max(1.0, min(timeout_seconds, 30.0))

    done = threading.Event()

    def _quit() -> None:
        try:
            driver.quit()
        except Exception:
            pass
        finally:
            done.set()

    thread = threading.Thread(target=_quit, name="selenium-driver-quit", daemon=True)
    thread.start()
    if done.wait(timeout_seconds):
        return

    _print(
        f"[WARN] ChromeDriver không thoát sau {timeout_seconds:g}s; "
        "cưỡng bức dừng để worker không bị kẹt sau SUCCESS."
    )
    _force_kill_driver_process(driver)
    done.wait(1.0)


def _print(msg: str) -> None:
    print(msg, flush=True)
