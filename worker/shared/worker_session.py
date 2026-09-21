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
    wait_after_action        as _wait_after_action_base,
)
from nurse_emr_accounts import get_emr_account_for_nurse
try:
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support import expected_conditions as EC
except ModuleNotFoundError:  # Cho phép import module này khi chưa cài Selenium (test thuần).
    By = EC = None  # type: ignore


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

    def switch_account(self, username: str, password: str) -> bool:
        """Đóng phiên đăng nhập hiện tại và đăng nhập lại bằng tài khoản khác.

        Dùng khi cần đổi tài khoản EMR giữa chừng (ví dụ: nhập chăm sóc ca làm
        bằng tài khoản điều dưỡng A, xong đổi sang tài khoản điều dưỡng B cho
        ca trực) mà không muốn thoát hẳn tiến trình worker. Trả về True nếu
        đăng nhập lại thành công. Nếu đăng nhập bằng tài khoản mới thất bại,
        tự động thử khôi phục lại bằng tài khoản cũ để phiên làm việc còn
        dùng tiếp được (trả về False) — chỉ khi CẢ khôi phục cũng thất bại
        mới raise, vì lúc đó driver coi như đã hỏng hẳn.
        """
        username = str(username or "").strip()
        password = str(password or "")
        if not username or not password:
            return False

        old_config = self.config
        current_username = str(old_config.get("username") or "").strip()
        if username == current_username:
            return True

        _print(f">>> Đổi tài khoản EMR: {current_username or '(mặc định)'} -> {username}")
        _safe_quit(self.driver)
        self.driver = None
        self.wait = None

        new_config = dict(old_config)
        new_config["username"] = username
        new_config["password"] = password

        headless = bool(new_config.get("headless", False))
        try:
            self.driver, self.wait = init_driver(headless=headless)
            login_emr(self.driver, self.wait, new_config)
            self.config = new_config
            if self._post_login:
                self._post_login(self)
            return True
        except Exception as e:
            _print(f"[WARN] Đổi tài khoản EMR thất bại ({username}): {e}")
            _safe_quit(self.driver)
            self.driver = None
            self.wait = None

        # Đăng nhập tài khoản mới thất bại: thử khôi phục lại tài khoản cũ
        # để worker còn tiếp tục xử lý được các BN/giờ khác thay vì hỏng cả phiên.
        try:
            self.driver, self.wait = init_driver(headless=headless)
            login_emr(self.driver, self.wait, old_config)
            self.config = old_config
            if self._post_login:
                self._post_login(self)
            _print("[INFO] Đã khôi phục tài khoản EMR trước đó sau khi đổi tài khoản thất bại.")
        except Exception as e2:
            _safe_quit(self.driver)
            self.driver = None
            self.wait = None
            raise RuntimeError(
                f"Đổi tài khoản EMR thất bại và không khôi phục lại được phiên cũ: {e2}"
            ) from e2
        return False

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

    def open_care_form(self, ma_bn: str, *, allow_completed: bool = False) -> None:
        """Tìm BN rồi mở hồ sơ + tab "TT chăm sóc" (icon mắt > TT chăm sóc).

        Gộp lại trình tự đang lặp ở nhiều nơi (input_care.py, các script dọn
        dẹp) — tìm BN xong luôn cần bấm đúng 2 bước này mới vào được bảng
        phiếu chăm sóc. Raise nếu không tìm/mở được.
        """
        self.search_patient(ma_bn, allow_completed=allow_completed)
        driver, wait = self.driver, self.wait
        wait.until(EC.element_to_be_clickable((By.XPATH, "//i[contains(@class, 'fa-eye')]"))).click()
        wait.until(EC.element_to_be_clickable((By.ID, "btnTTCS"))).click()
        _wait_after_action_base(driver, 0.8, ready_timeout=10)

    def switch_account_to(
        self,
        username: str,
        password: str,
        ma_bn: str,
        *,
        allow_completed: bool = False,
        reopen: Optional[Callable[["WorkerSession", str], None]] = None,
    ) -> bool:
        """Đổi sang đúng tài khoản EMR chỉ định (no-op nếu đã đúng tài khoản),
        rồi mở lại đúng trang đang thao tác cho BN `ma_bn`.

        Đây là ĐIỂM DUY NHẤT xử lý "đổi tài khoản + mở lại trang" — mọi luồng
        cần đổi tài khoản EMR (chăm sóc, phòng khám, dịch truyền, công cụ dọn
        phiếu...) đều gọi qua đây (trực tiếp hoặc qua `switch_to_creator_account`
        / `restore_account`) để sau này EMR đổi logic chỉ cần sửa 1 chỗ.

        `reopen(ws, ma_bn)` quyết định cách mở lại trang sau khi đổi tài
        khoản — mỗi luồng có một cách mở khác nhau (tab TT chăm sóc, modal
        dịch truyền, hồ sơ theo URL riêng...); mặc định dùng `open_care_form`
        (mở tab TT chăm sóc) nếu không truyền `reopen` riêng.

        Trả về False nếu đổi tài khoản hoặc mở lại trang thất bại.
        """
        current_username = str(self.config.get("username") or "").strip()
        if username == current_username:
            return True
        if not self.switch_account(username, password):
            return False
        reopen_fn = reopen or (lambda ws, mb: ws.open_care_form(mb, allow_completed=allow_completed))
        try:
            reopen_fn(self, ma_bn)
        except Exception as e:
            _print(f"[WARN] Đổi tài khoản EMR xong nhưng không mở lại được hồ sơ BN {ma_bn}: {e}")
            return False
        return True

    def switch_to_creator_account(
        self,
        creator: str,
        ma_bn: str,
        *,
        allow_completed: bool = False,
        reopen: Optional[Callable[["WorkerSession", str], None]] = None,
    ) -> bool:
        """Đảm bảo đang đăng nhập đúng tài khoản EMR của `creator` và đang mở
        đúng trang cho BN `ma_bn` — dùng trước khi sửa/xóa một phiếu do người
        đó tạo, vì EMR hiện chỉ cho đúng tài khoản người tạo tự sửa/xóa phiếu
        của mình (xem worker/nurse_emr_accounts.py).

        Trả về False nếu không tra được tài khoản EMR cho `creator`, hoặc đổi
        tài khoản/mở lại trang thất bại — khi đó KHÔNG được thao tác sửa/xóa
        phiếu này, vì tài khoản đang đăng nhập không phải người tạo.
        """
        account = get_emr_account_for_nurse(creator)
        if not account:
            return False
        return self.switch_account_to(
            account["username"], account["password"], ma_bn,
            allow_completed=allow_completed, reopen=reopen,
        )

    def restore_account(
        self,
        original_username: str,
        original_password: str,
        ma_bn: str,
        *,
        allow_completed: bool = False,
        reopen: Optional[Callable[["WorkerSession", str], None]] = None,
    ) -> None:
        """Khôi phục lại đúng tài khoản EMR ban đầu (nếu đã phải đổi sang tài
        khoản người khác để sửa/xóa phiếu của họ) và mở lại đúng trang. Gọi
        sau khi xong việc sửa/xóa để các bước tiếp theo không bị lệch tài
        khoản. Không làm gì nếu `original_username` rỗng hoặc đã đúng."""
        if not original_username:
            return
        if not self.switch_account_to(
            original_username, original_password, ma_bn,
            allow_completed=allow_completed, reopen=reopen,
        ):
            _print(f"[WARN] Không khôi phục được tài khoản EMR gốc {original_username}.")

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
