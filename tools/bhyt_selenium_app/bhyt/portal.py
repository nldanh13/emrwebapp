from __future__ import annotations

from pathlib import Path
import threading
import time
from typing import Any, Callable

from selenium import webdriver
from selenium.common.exceptions import TimeoutException, WebDriverException
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait

from .mapping import DOC_BHXH, DOC_GRV, normalize_text


BASE_URL = "https://gdbhyt.baohiemxahoi.gov.vn"


class PortalError(RuntimeError):
    pass


class BhytPortal:
    def __init__(self, profile_dir: str | Path, timeout: int = 40):
        self.profile_dir = Path(profile_dir).resolve()
        self.timeout = timeout
        self.driver: webdriver.Chrome | None = None
        self._lock = threading.RLock()

    def start(self) -> str:
        with self._lock:
            if self.driver:
                try:
                    _ = self.driver.title
                    return "Chrome đang hoạt động"
                except WebDriverException:
                    self.driver = None
            self.profile_dir.mkdir(parents=True, exist_ok=True)
            options = webdriver.ChromeOptions()
            options.add_argument(f"--user-data-dir={self.profile_dir}")
            options.add_argument("--start-maximized")
            options.add_argument("--disable-notifications")
            options.add_experimental_option("excludeSwitches", ["enable-automation"])
            options.add_experimental_option("prefs", {
                "download.prompt_for_download": False,
                "profile.default_content_setting_values.notifications": 2,
            })
            self.driver = webdriver.Chrome(options=options)
            self.driver.get(f"{BASE_URL}/Home")
            return "Đã mở Chrome. Hãy đăng nhập thủ công nếu hệ thống yêu cầu."

    def fill_login(self, facility_code: str, username: str, password: str) -> str:
        """Fill portal credentials; CAPTCHA/OTP remain manual and nothing is persisted."""
        with self._lock:
            driver = self._require_driver()
            try:
                if self.session_status().get("logged_in"):
                    return "Phiên Chrome đã đăng nhập; không cần điền lại tài khoản."
            except PortalError:
                pass

            def has_login_fields(drv):
                return all(drv.find_elements(By.ID, item) for item in ("macskcb", "username", "password"))

            if not has_login_fields(driver):
                driver.get(BASE_URL + "/Account/Index")
                try:
                    WebDriverWait(driver, self.timeout).until(has_login_fields)
                except TimeoutException:
                    driver.get(BASE_URL)
                    WebDriverWait(driver, self.timeout).until(has_login_fields)

            for element_id, value in (
                ("macskcb", facility_code),
                ("username", username),
                ("password", password),
            ):
                element = driver.find_element(By.ID, element_id)
                element.clear()
                element.send_keys(value)

            captcha = driver.find_elements(By.ID, "Captcha_TB_I")
            if captcha:
                captcha[0].click()
            driver.execute_script("window.scrollTo(0, document.body.scrollHeight / 2);")
            return (
                "Đã điền Mã cơ sở KCB, tên đăng nhập và mật khẩu. "
                "Hãy nhập CAPTCHA trên Chrome, bấm Đăng nhập và hoàn tất OTP nếu được yêu cầu."
            )

    def close(self):
        with self._lock:
            if self.driver:
                try:
                    self.driver.quit()
                finally:
                    self.driver = None

    def _require_driver(self) -> webdriver.Chrome:
        if not self.driver:
            raise PortalError("Chưa mở Chrome")
        return self.driver

    def session_status(self) -> dict[str, Any]:
        driver = self._require_driver()
        try:
            logged_in = bool(driver.execute_script(
                r"""
                const hasLoginForm = !!document.getElementById('login1') ||
                    (!!document.getElementById('username') && !!document.getElementById('password'));
                const hasLogout = !!document.querySelector(
                    'a[href*="/Account/LogOff"], a[href*="/Account/Logout"], a[href*="DangXuat"]'
                );
                const protectedPage = !/\/Account\/(Index|Login)?\/?$/i.test(location.pathname) &&
                    !hasLoginForm && /gdbhyt\.baohiemxahoi\.gov\.vn$/i.test(location.hostname);
                return hasLogout || protectedPage;
                """
            ))
            return {"logged_in": logged_in, "url": driver.current_url, "title": driver.title}
        except WebDriverException as exc:
            raise PortalError(f"Không đọc được trạng thái Chrome: {exc}") from exc

    def _wait_ready(self):
        driver = self._require_driver()

        def ready(drv):
            return drv.execute_script(
                """
                const documentReady = document.readyState === 'complete';
                const ajaxReady = !window.jQuery || window.jQuery.active === 0;
                const panels = Array.from(document.querySelectorAll(
                    '.dxlp-loadingPanel, .dx-loading-panel, [id$="_LP"]'
                ));
                const visible = panels.some(el => {
                    const style = window.getComputedStyle(el);
                    return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
                });
                return documentReady && ajaxReady && !visible;
                """
            )

        WebDriverWait(driver, self.timeout).until(ready)

    def _open_create(self, doc_type: str):
        driver = self._require_driver()
        path = "/PhuLuc07/CreateNew" if doc_type == DOC_BHXH else "/PhuLuc3/CreateNew"
        driver.get(BASE_URL + path)
        self._wait_ready()
        if "/Account/" in driver.current_url or not self.session_status()["logged_in"]:
            raise PortalError("Phiên đăng nhập chưa sẵn sàng hoặc đã hết hạn")
        expected = "frmCreatenew07" if doc_type == DOC_BHXH else "frmCreatenew03"
        WebDriverWait(driver, self.timeout).until(
            lambda drv: drv.execute_script("return !!document.getElementById(arguments[0]);", expected)
        )

    def _wait_control(self, name: str):
        driver = self._require_driver()
        WebDriverWait(driver, self.timeout).until(
            lambda drv: drv.execute_script("return !!window[arguments[0]];", name)
        )

    def _set_value(self, name: str, value: Any, text: bool = False):
        if value is None or str(value).strip() == "":
            return
        self._wait_control(name)
        method = "SetText" if text else "SetValue"
        self._require_driver().execute_script(
            """
            const control = window[arguments[0]];
            const method = arguments[2];
            if (!control || typeof control[method] !== 'function') {
                throw new Error('Không có control/method: ' + arguments[0] + '.' + method);
            }
            control[method](arguments[1]);
            if (typeof control.RaiseValueChangedEvent === 'function') control.RaiseValueChangedEvent();
            """,
            name,
            str(value),
            method,
        )

    def _set_checked(self, name: str, value: Any):
        self._wait_control(name)
        checked = normalize_text(value) in {"1", "true", "co", "yes", "x"}
        self._require_driver().execute_script(
            "window[arguments[0]].SetChecked(arguments[1]);",
            name,
            checked,
        )

    def _combo_items(self, name: str) -> list[dict[str, Any]]:
        self._wait_control(name)
        return self._require_driver().execute_script(
            """
            const control = window[arguments[0]];
            const result = [];
            const count = typeof control.GetItemCount === 'function' ? control.GetItemCount() : 0;
            for (let i = 0; i < count; i++) {
                const item = control.GetItem(i);
                let text = '';
                if (item) {
                    if (item.texts && item.texts.length) text = Array.from(item.texts).join(' ');
                    else if (item.text !== undefined) text = String(item.text);
                }
                result.push({index: i, text: text, value: item ? item.value : null});
            }
            return result;
            """,
            name,
        ) or []

    def _select_combo(self, name: str, wanted_text: str, required: bool = True):
        if not str(wanted_text or "").strip():
            if required:
                raise PortalError(f"Thiếu giá trị cho danh sách {name}")
            return
        wanted = normalize_text(wanted_text)
        items = self._combo_items(name)
        exact = [item for item in items if normalize_text(item.get("text")) == wanted]
        contains = [item for item in items if wanted and wanted in normalize_text(item.get("text"))]
        reverse = [item for item in items if normalize_text(item.get("text")) in wanted]
        choices = exact or contains or reverse
        if not choices:
            sample = ", ".join(item.get("text", "") for item in items[:5])
            raise PortalError(f"Không tìm thấy '{wanted_text}' trong {name}. Ví dụ có sẵn: {sample}")
        index = int(choices[0]["index"])
        self._require_driver().execute_script(
            """
            const control = window[arguments[0]];
            control.SetSelectedIndex(arguments[1]);
            if (typeof control.RaiseSelectedIndexChanged === 'function') control.RaiseSelectedIndexChanged();
            """,
            name,
            index,
        )

    def _set_card(self, value: str):
        card = recompact(value)
        if not card:
            return
        if len(card) not in {15, 17}:
            raise PortalError(f"Mã thẻ phải có 15 hoặc 17 ký tự, hiện có {len(card)}")
        parts = [card[:2], card[2:3], card[3:5], card[5:]]
        for index, part in enumerate(parts, start=1):
            self._set_value(f"ma_theSub{index}", part)

    def _fill_bhxh(self, fields: dict[str, str]):
        simple = {
            "ma_ct": "ma_ct", "so_seri": "so_seri", "so_kcb": "so_kcb",
            "mau_so": "mau_so", "ma_bhxh": "ma_sobhxh", "ho_ten": "ho_ten",
            "ngay_sinh": "ngay_sinh", "ten_dv": "ten_dv", "chan_doan": "chan_doan",
            "ho_ten_cha": "ho_ten_cha", "ho_ten_me": "ho_ten_me",
            "nguoi_dai_dien": "nguoi_dai_dien", "so_cccd": "so_cccd",
            "noicap_cccd": "noicap_cccd",
        }
        for field, control in simple.items():
            self._set_value(control, fields.get(field, ""))
        for field, control in {
            "ngay_kcb": "ngay_kcb", "tu_ngay": "tu_ngay", "den_ngay": "den_ngay",
            "ngay_ct": "ngay_ct", "ngaycap_cccd": "ngaycap_cccd",
        }.items():
            self._set_value(control, fields.get(field, ""), text=True)
        self._set_card(fields.get("ma_the", ""))
        self._select_combo("gioi_tinh", fields.get("gioi_tinh", ""))
        self._select_combo("bs_id", fields.get("doctor_text", ""))
        if fields.get("loai_giay_to"):
            self._select_combo("loai_giay_to", fields["loai_giay_to"], required=False)

    def _fill_grv(self, fields: dict[str, str]):
        simple = {
            "ma_ct": "ma_ct", "so_seri": "so_seri", "ma_bhxh": "ma_sobhxh",
            "ho_ten": "ho_ten", "ngay_sinh": "ngay_sinh", "ho_ten_me": "ho_ten_nnd",
            "ho_ten_cha": "ho_ten_cha", "nghe_nghiep": "nghe_nghiep",
            "dia_chi": "dia_chi", "tuoi_thai": "tuoi_thai", "chan_doan": "chan_doan",
            "pp_dieutri": "pp_dieutri", "ghi_chu": "ghi_chu",
            "nguoi_dai_dien": "nguoi_dai_dien", "so_cccd": "so_cccd",
            "noicap_cccd": "noicap_cccd",
        }
        for field, control in simple.items():
            self._set_value(control, fields.get(field, ""))
        for field, control in {
            "tu_ngay": "tu_ngay", "den_ngay": "den_ngay", "ngay_ct": "ngay_ct",
            "ngoaitru_tungay": "ngoaitru_tungay", "ngoaitru_denngay": "ngoaitru_denngay",
            "ngaycap_cccd": "ngaycap_cccd",
        }.items():
            self._set_value(control, fields.get(field, ""), text=True)
        self._set_card(fields.get("ma_the", ""))
        self._select_combo("gioi_tinh", fields.get("gioi_tinh", ""))
        self._select_combo("ma_khoa", fields.get("ma_khoa", ""))
        self._select_combo("dan_toc", fields.get("dan_toc", ""))
        self._select_combo("loai_giay_to", fields.get("loai_giay_to", "Không có giấy tờ"))
        self._select_combo("bs_id", fields.get("doctor_text", ""))
        self._set_checked("dc_thainghen", fields.get("dc_thainghen", ""))

    def fill_record(self, record: dict[str, Any], dry_run: bool = True) -> str:
        with self._lock:
            doc_type = record["doc_type"]
            fields = record["fields"]
            self._open_create(doc_type)
            if doc_type == DOC_BHXH:
                self._fill_bhxh(fields)
            elif doc_type == DOC_GRV:
                self._fill_grv(fields)
            else:
                raise PortalError(f"Loại hồ sơ không hỗ trợ: {doc_type}")
            self._wait_ready()
            if dry_run:
                return "Đã điền thử, chưa bấm Lưu"
            return self._save(doc_type)

    def _save(self, doc_type: str) -> str:
        driver = self._require_driver()
        old_url = driver.current_url
        function = "SavePhuLuc7" if doc_type == DOC_BHXH else "SavePhuLuc3"
        driver.execute_script(
            """
            if (typeof window[arguments[0]] !== 'function') {
                throw new Error('Không tìm thấy hàm lưu ' + arguments[0]);
            }
            window[arguments[0]](false);
            """,
            function,
        )

        end = time.time() + self.timeout
        last_message = ""
        while time.time() < end:
            time.sleep(0.4)
            try:
                message = driver.execute_script(
                    """
                    const el = document.getElementById('MessAlert');
                    if (!el) return '';
                    const popup = document.getElementById('popupAlertMessage_PW-1');
                    if (popup) {
                        const style = getComputedStyle(popup);
                        if (style.display === 'none' || style.visibility === 'hidden') return '';
                    }
                    return (el.innerText || el.textContent || '').trim();
                    """
                ) or ""
                if message:
                    last_message = message
                    break
                if driver.current_url != old_url or "/CreateNew" not in driver.current_url:
                    return "Đã gửi hồ sơ và trang đã chuyển tiếp"
            except WebDriverException:
                continue
        if last_message:
            raise PortalError(last_message)
        raise TimeoutException("Không xác định được kết quả sau khi bấm Lưu; cần kiểm tra trực tiếp trên trình duyệt")


def recompact(value: Any) -> str:
    return "".join(str(value or "").split()).upper()


class Worker:
    def __init__(self, portal: BhytPortal, store: Any):
        self.portal = portal
        self.store = store
        self.thread: threading.Thread | None = None
        self.stop_event = threading.Event()
        self.state: dict[str, Any] = {"running": False, "current_id": None, "message": ""}
        self._lock = threading.Lock()

    def start(self, record_ids: list[int], dry_run: bool = True, delay_seconds: float = 1.0):
        with self._lock:
            if self.thread and self.thread.is_alive():
                raise PortalError("Tiến trình nhập liệu đang chạy")
            self.stop_event.clear()
            self.thread = threading.Thread(
                target=self._run,
                args=(record_ids, dry_run, delay_seconds),
                daemon=True,
            )
            self.thread.start()

    def stop(self):
        self.stop_event.set()
        self.state["message"] = "Đang dừng sau hồ sơ hiện tại"

    def _run(self, record_ids: list[int], dry_run: bool, delay_seconds: float):
        self.state = {"running": True, "current_id": None, "message": "Bắt đầu"}
        try:
            for record_id in record_ids:
                if self.stop_event.is_set():
                    break
                record = self.store.get_record(record_id)
                if not record:
                    continue
                if record["status"] == "success":
                    continue
                if record["issues"]:
                    self.store.mark(record_id, "error", "; ".join(record["issues"]))
                    continue
                self.state.update(current_id=record_id, message=f"Đang nhập {record['patient_name']}")
                self.store.mark(record_id, "running", "", increment_attempt=True)
                try:
                    result = self.portal.fill_record(record, dry_run=dry_run)
                    status = "previewed" if dry_run else "success"
                    self.store.mark(record_id, status, result)
                    if dry_run:
                        self.state["message"] = "Đã điền thử một hồ sơ. Kiểm tra trên Chrome trước khi chạy thật."
                        break
                except Exception as exc:
                    self.store.mark(record_id, "error", str(exc))
                if self.stop_event.wait(max(0.0, delay_seconds)):
                    break
        finally:
            self.state.update(running=False, current_id=None, message="Đã dừng" if self.stop_event.is_set() else "Đã hoàn tất")

    def status(self) -> dict[str, Any]:
        return dict(self.state)
