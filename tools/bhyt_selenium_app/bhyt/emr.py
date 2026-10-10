"""Đọc dữ liệu "Giấy chứng nhận nghỉ việc hưởng BHXH" từ EMR/HIS nội bộ của bệnh viện.

Hướng dữ liệu: ĐỌC từ EMR nội bộ (vd http://192.168.2.26:2026, phần Khám bệnh) →
để điền lên cổng BHXH (gdbhyt.baohiemxahoi.gov.vn) bằng bhyt/portal.py. Module này
CHỈ ĐỌC, không bấm Lưu/Chấp nhận gì trên EMR. Luồng và id phần tử theo đúng bản ghi
thao tác người dùng gửi; nếu EMR đổi id, chỉnh trong config.json → "emr" → "selectors".

Không lưu mật khẩu ra đĩa — chỉ giữ trong RAM. Chỉ chạy được trong mạng bệnh viện.
"""

from __future__ import annotations

from pathlib import Path
import base64
import threading
import time
from typing import Any

from selenium import webdriver
from selenium.common.exceptions import TimeoutException, WebDriverException
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait


# id/selector mặc định theo bản ghi thao tác EMR. Chỉnh trong config.json nếu EMR đổi.
DEFAULT_EMR_SELECTORS = {
    # Đăng nhập
    "login_user": "txtLoginName",
    "login_pass": "txtPassword",
    "login_button": "btnLogin",
    # Mở danh sách Khám bệnh
    "menu_group": '//*[@id="side-menu"]/li[4]/a/span',
    "menu_exam_link": "Danh sách Khám bệnh",
    # Tìm người bệnh
    "search_input": "txtTimKiem",
    "search_button": "btnTimKiem",
    # Mở hồ sơ + form giấy nghỉ
    "patient_record_menu": '//*[@id="divMenuContent"]/nav/ul/li[2]/span',
    "clear_error_button": "#root > div > div.panel-header.has-errors > div:nth-child(2) > button:nth-child(3)",
    "cert_link": "Giấy chứng nhận nghỉ việc hưởng BHXH",
    "modal": "divModalContentX",
    # Các ô trong form giấy nghỉ (để ĐỌC giá trị)
    "so_ngay_nghi": "txtSoNgayNghi",
    "don_vi_lam_viec": "txtDonViLamViec",
    "ma_so_bhxh": "txtMaSoBHXH",
    "so_the_bhyt": "txtSoTheBHYT",
    "ngay_cap_giay": "txtNgayCapGiay",
    "nghi_tu_ngay": "txtNghiTuNgay",
    "nghi_den_ngay": "txtNghiDenNgay",
}

# Ánh xạ ô trên EMR → tên field nội bộ mà bhyt/portal.py dùng để điền cổng BHXH (mẫu 07).
# Lưu ý: EMR không có số seri / số KCB / mẫu số trên form này nên các field đó vẫn lấy
# từ file BHXH / bổ sung tay như cũ — đọc EMR chỉ bù các field dưới đây.
EMR_TO_RECORD = {
    "don_vi_lam_viec": "ten_dv",
    "ma_so_bhxh": "ma_bhxh",
    "so_the_bhyt": "ma_the",
    "ngay_cap_giay": "ngay_ct",
    "nghi_tu_ngay": "tu_ngay",
    "nghi_den_ngay": "den_ngay",
    "so_ngay_nghi": "so_ngay_nghi",  # tham khảo; cổng tự tính theo tu_ngay/den_ngay
}


class EmrError(RuntimeError):
    pass


class EmrPortal:
    def __init__(self, base_url: str, profile_dir: str | Path, timeout: int = 40,
                 headless: bool = True, selectors: dict[str, str] | None = None,
                 debug_dir: str | Path | None = None):
        self.base_url = (base_url or "").rstrip("/")
        self.profile_dir = Path(profile_dir).resolve()
        self.timeout = timeout
        self.headless = headless
        self.selectors = {**DEFAULT_EMR_SELECTORS, **(selectors or {})}
        self.debug_dir = Path(debug_dir).resolve() if debug_dir else None
        self.driver: webdriver.Chrome | None = None
        self._lock = threading.RLock()

    def sel(self, key: str) -> str:
        return self.selectors.get(key, DEFAULT_EMR_SELECTORS.get(key, key))

    # ── Trình duyệt ───────────────────────────────────────────────────────────
    def start(self) -> str:
        with self._lock:
            if not self.base_url:
                raise EmrError("Chưa cấu hình địa chỉ EMR (config.json → emr.base_url).")
            if self.driver:
                try:
                    _ = self.driver.title
                    return "Trình duyệt EMR đang hoạt động"
                except WebDriverException:
                    self.driver = None
            self.profile_dir.mkdir(parents=True, exist_ok=True)
            options = webdriver.ChromeOptions()
            options.add_argument(f"--user-data-dir={self.profile_dir}")
            options.add_argument("--disable-notifications")
            options.add_experimental_option("excludeSwitches", ["enable-automation"])
            if self.headless:
                options.add_argument("--headless=new")
                options.add_argument("--window-size=1366,900")
                options.add_argument("--disable-gpu")
            else:
                options.add_argument("--start-maximized")
            self.driver = webdriver.Chrome(options=options)
            self.driver.get(f"{self.base_url}/login.aspx")
            return "Đã mở trình duyệt EMR."

    def _driver(self) -> webdriver.Chrome:
        if self.driver is None:
            raise EmrError("Chưa mở trình duyệt EMR. Hãy đăng nhập EMR trước.")
        return self.driver

    def _is_login_page(self) -> bool:
        try:
            return "login.aspx" in (self.driver.current_url or "").lower()
        except WebDriverException:
            return True

    def session_status(self) -> dict[str, Any]:
        if self.driver is None:
            return {"logged_in": False}
        try:
            return {"logged_in": not self._is_login_page(), "url": self.driver.current_url}
        except WebDriverException:
            return {"logged_in": False}

    # ── Đăng nhập (EMR không có CAPTCHA) ────────────────────────────────────────
    def login(self, username: str, password: str) -> dict[str, Any]:
        """Đăng nhập EMR và giữ phiên. Mật khẩu chỉ ở RAM, không ghi ra đĩa."""
        with self._lock:
            if self.driver is None:
                self.start()
            driver = self._driver()
            if not self._is_login_page():
                driver.get(f"{self.base_url}/login.aspx")
            WebDriverWait(driver, self.timeout).until(
                lambda d: d.find_elements(By.ID, self.sel("login_user"))
            )
            u = driver.find_element(By.ID, self.sel("login_user"))
            u.clear(); u.send_keys(username)
            p = driver.find_element(By.ID, self.sel("login_pass"))
            p.clear(); p.send_keys(password)
            btns = driver.find_elements(By.ID, self.sel("login_button"))
            if btns:
                driver.execute_script("arguments[0].click();", btns[0])
            else:
                p.send_keys(Keys.ENTER)
            deadline = time.time() + self.timeout
            while time.time() < deadline:
                time.sleep(0.5)
                if not self._is_login_page():
                    return {"logged_in": True, "message": "Đăng nhập EMR thành công.",
                            "url": driver.current_url}
            self.dump_page("dang-nhap-that-bai")
            return {"logged_in": False,
                    "message": "Chưa vào được EMR. Kiểm tra tài khoản/mật khẩu rồi thử lại."}

    # ── Điều hướng tới form giấy nghỉ của một người bệnh ────────────────────────
    def _wait_el(self, by: str, value: str):
        driver = self._driver()
        WebDriverWait(driver, self.timeout).until(lambda d: d.find_elements(by, value))
        els = driver.find_elements(by, value)
        if not els:
            raise EmrError(f"Không thấy phần tử: {value}")
        return els[0]

    def _click(self, by: str, value: str, what: str):
        try:
            el = self._wait_el(by, value)
            self._driver().execute_script("arguments[0].click();", el)
        except TimeoutException as exc:
            self.dump_page(f"loi-{what}")
            raise EmrError(f"Không mở được: {what} (không thấy {value}). EMR có thể đổi giao diện.") from exc

    def open_cert_for_patient(self, patient_name: str) -> dict[str, Any]:
        """Mở form "Giấy chứng nhận nghỉ việc hưởng BHXH" của một người bệnh để ĐỌC dữ liệu.
        Dừng lại khi form đã hiện, không điền/sửa gì."""
        with self._lock:
            if self._is_login_page():
                raise EmrError("Phiên EMR chưa đăng nhập hoặc đã hết hạn. Hãy đăng nhập lại.")
            name = (patient_name or "").strip()
            if not name:
                raise EmrError("Thiếu tên người bệnh để tìm trong EMR.")
            driver = self._driver()

            self._click(By.XPATH, self.sel("menu_group"), "nhóm menu bên trái")
            self._click(By.LINK_TEXT, self.sel("menu_exam_link"), "Danh sách Khám bệnh")

            search = self._wait_el(By.ID, self.sel("search_input"))
            search.clear(); search.send_keys(name)
            self._click(By.ID, self.sel("search_button"), "nút Tìm kiếm")
            time.sleep(1.0)

            link = name.upper()
            try:
                self._click(By.LINK_TEXT, link, f"người bệnh {link}")
            except EmrError:
                self._click(By.PARTIAL_LINK_TEXT, link, f"người bệnh {link}")
            time.sleep(1.0)

            self._click(By.XPATH, self.sel("patient_record_menu"), "mục hồ sơ người bệnh")
            self._dismiss_error_panel_best_effort()
            self._click(By.LINK_TEXT, self.sel("cert_link"), "Giấy chứng nhận nghỉ việc hưởng BHXH")
            WebDriverWait(driver, self.timeout).until(
                lambda d: d.find_elements(By.ID, self.sel("modal"))
            )
            return {"opened": True, "patient": name, "message": f"Đã mở form giấy nghỉ của {name}."}

    def _dismiss_error_panel_best_effort(self):
        """Theo bản ghi: vào iframe index 0, bấm nút đóng panel 'has-errors' rồi ra top.
        Không phải hồ sơ nào cũng có — bỏ qua êm nếu không thấy."""
        driver = self._driver()
        try:
            frames = driver.find_elements(By.TAG_NAME, "iframe")
            if not frames:
                return
            driver.switch_to.frame(frames[0])
            btns = driver.find_elements(By.CSS_SELECTOR, self.sel("clear_error_button"))
            if btns:
                driver.execute_script("arguments[0].click();", btns[0])
                time.sleep(0.3)
        except WebDriverException:
            pass
        finally:
            try:
                driver.switch_to.default_content()
            except WebDriverException:
                pass

    # ── Đọc dữ liệu từ form giấy nghỉ ───────────────────────────────────────────
    def _read_value(self, key: str) -> str:
        driver = self._driver()
        els = driver.find_elements(By.ID, self.sel(key))
        if not els:
            return ""
        el = els[0]
        try:
            val = el.get_attribute("value")
        except WebDriverException:
            val = None
        if val is None:
            try:
                val = driver.execute_script("return arguments[0].value;", el)
            except WebDriverException:
                val = ""
        return str(val or "").strip()

    def read_cert(self) -> dict[str, Any]:
        """Đọc các ô trên form giấy nghỉ (form phải đang mở). Trả về:
        - fields: theo tên field nội bộ (dùng để bù vào hồ sơ điền cổng BHXH)
        - raw: theo tên ô EMR, để đối chiếu
        """
        with self._lock:
            driver = self._driver()
            if not driver.find_elements(By.ID, self.sel("modal")):
                raise EmrError("Form giấy nghỉ chưa mở. Hãy mở form cho người bệnh trước.")
            raw: dict[str, str] = {}
            fields: dict[str, str] = {}
            for emr_key, record_key in EMR_TO_RECORD.items():
                value = self._read_value(emr_key)
                raw[emr_key] = value
                if value:
                    fields[record_key] = value
            return {"fields": fields, "raw": raw}

    # ── Chụp lại trang/form để gửi kỹ thuật dựng tiếp ───────────────────────────
    def capture_cert(self, name: str = "form-giay-nghi") -> dict[str, Any]:
        with self._lock:
            return self.dump_page(name)

    def dump_page(self, name: str) -> dict[str, Any]:
        if self.debug_dir is None or self.driver is None:
            return {"saved": False}
        self.debug_dir.mkdir(parents=True, exist_ok=True)
        safe = "".join(c for c in name if c.isalnum() or c in "-_") or "trang"
        html_path = self.debug_dir / f"emr-{safe}.html"
        png_path = self.debug_dir / f"emr-{safe}.png"
        try:
            html_path.write_text(self.driver.page_source or "", encoding="utf-8")
        except (OSError, WebDriverException):
            pass
        try:
            png = self.driver.get_screenshot_as_png()
            png_path.write_bytes(png)
            image = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
        except (OSError, WebDriverException):
            image = ""
        return {"saved": True, "html": str(html_path), "image_path": str(png_path), "image": image}

    def close(self):
        with self._lock:
            if self.driver is not None:
                try:
                    self.driver.quit()
                except WebDriverException:
                    pass
                self.driver = None
