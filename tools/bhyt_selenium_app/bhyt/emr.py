"""Nhập "Giấy chứng nhận nghỉ việc hưởng BHXH" vào EMR/HIS nội bộ của bệnh viện.

KHÁC với bhyt/portal.py (cổng BHYT quốc gia — dùng để TRA CỨU thẻ): module này vào
thẳng EMR nội bộ (vd http://192.168.2.26:2026) ở phần Khám bệnh, mở form giấy nghỉ của
một người bệnh rồi điền và (khi nhập thật) bấm Chấp nhận. Luồng và id phần tử theo đúng
bản ghi thao tác người dùng gửi; nếu EMR đổi id, chỉnh trong config.json → "emr" →
"selectors" thay vì sửa code.

An toàn: "Điền thử" KHÔNG bấm Chấp nhận. Không lưu mật khẩu/CAPTCHA ra đĩa — chỉ giữ
trong RAM của tiến trình này. Chỉ chạy được trong mạng bệnh viện (EMR là địa chỉ nội bộ).
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
    # Các ô trong form giấy nghỉ
    "so_ngay_nghi": "txtSoNgayNghi",
    "don_vi_lam_viec": "txtDonViLamViec",
    "ma_so_bhxh": "txtMaSoBHXH",
    "so_the_bhyt": "txtSoTheBHYT",
    "ngay_cap_giay": "txtNgayCapGiay",
    "nghi_tu_ngay": "txtNghiTuNgay",
    "nghi_den_ngay": "txtNghiDenNgay",
    "accept_button": "btnChapNhanGiay",
}


class EmrError(RuntimeError):
    pass


def build_cert_fields(record_fields: dict[str, Any]) -> dict[str, str]:
    """Ghép dữ liệu một hồ sơ (từ tab Nghỉ ốm / store) thành đúng các ô của form EMR.

    Pure function — test được mà không cần trình duyệt. Thiếu thì để rỗng, lúc điền
    sẽ báo ô nào còn trống.
    """
    f = record_fields or {}

    def pick(*keys: str) -> str:
        for key in keys:
            value = f.get(key)
            if value is not None and str(value).strip():
                return str(value).strip()
        return ""

    so_ngay = pick("so_ngay_nghi", "so_ngay")
    if not so_ngay:
        so_ngay = _days_between(pick("tu_ngay", "nghi_tu_ngay"), pick("den_ngay", "nghi_den_ngay"))

    return {
        "so_ngay_nghi": so_ngay,
        "don_vi_lam_viec": pick("ten_dv", "don_vi", "don_vi_lam_viec"),
        "ma_so_bhxh": pick("ma_bhxh", "ma_sobhxh", "ma_so_bhxh"),
        "so_the_bhyt": pick("ma_the", "so_the", "so_the_bhyt"),
        "ngay_cap_giay": pick("ngay_ct", "ngay_cap", "ngay_cap_giay"),
        "nghi_tu_ngay": pick("tu_ngay", "nghi_tu_ngay"),
        "nghi_den_ngay": pick("den_ngay", "nghi_den_ngay"),
    }


def _days_between(tu_ngay: str, den_ngay: str) -> str:
    """Số ngày nghỉ (bao gồm cả hai đầu) từ 2 ngày dd/mm/yyyy. Không tính được thì rỗng."""
    from datetime import datetime

    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y"):
        try:
            d1 = datetime.strptime(tu_ngay.strip(), fmt)
            break
        except (ValueError, AttributeError):
            d1 = None
    else:
        d1 = None
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y"):
        try:
            d2 = datetime.strptime(den_ngay.strip(), fmt)
            break
        except (ValueError, AttributeError):
            d2 = None
    else:
        d2 = None
    if not d1 or not d2:
        return ""
    delta = (d2 - d1).days + 1
    return str(delta) if delta > 0 else ""


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
    def _wait_clickable(self, by: str, value: str):
        driver = self._driver()
        WebDriverWait(driver, self.timeout).until(lambda d: d.find_elements(by, value))
        els = driver.find_elements(by, value)
        if not els:
            raise EmrError(f"Không thấy phần tử: {value}")
        return els[0]

    def _click(self, by: str, value: str, what: str):
        try:
            el = self._wait_clickable(by, value)
            self._driver().execute_script("arguments[0].click();", el)
        except TimeoutException as exc:
            self.dump_page(f"loi-{what}")
            raise EmrError(f"Không mở được: {what} (không thấy {value}). EMR có thể đổi giao diện.") from exc

    def open_cert_for_patient(self, patient_name: str) -> dict[str, Any]:
        """Mở đúng form "Giấy chứng nhận nghỉ việc hưởng BHXH" của một người bệnh.

        Dừng lại khi modal form đã hiện, CHƯA điền gì. Trả về trạng thái để kiểm tra
        trước khi điền.
        """
        with self._lock:
            if self._is_login_page():
                raise EmrError("Phiên EMR chưa đăng nhập hoặc đã hết hạn. Hãy đăng nhập lại.")
            name = (patient_name or "").strip()
            if not name:
                raise EmrError("Thiếu tên người bệnh để tìm trong EMR.")
            driver = self._driver()

            # 1) Mở nhóm menu → Danh sách Khám bệnh
            self._click(By.XPATH, self.sel("menu_group"), "nhóm menu bên trái")
            self._click(By.LINK_TEXT, self.sel("menu_exam_link"), "Danh sách Khám bệnh")

            # 2) Tìm người bệnh theo tên
            search = self._wait_clickable(By.ID, self.sel("search_input"))
            search.clear(); search.send_keys(name)
            self._click(By.ID, self.sel("search_button"), "nút Tìm kiếm")
            time.sleep(1.0)

            # 3) Chọn người bệnh theo tên (EMR hiển thị tên IN HOA)
            link = name.upper()
            try:
                self._click(By.LINK_TEXT, link, f"người bệnh {link}")
            except EmrError:
                self._click(By.PARTIAL_LINK_TEXT, link, f"người bệnh {link}")
            time.sleep(1.0)

            # 4) Mở phần hồ sơ chứa giấy tờ
            self._click(By.XPATH, self.sel("patient_record_menu"), "mục hồ sơ người bệnh")

            # 5) Một số hồ sơ hiện panel lỗi trong iframe — bấm bỏ nếu có (không bắt buộc).
            self._dismiss_error_panel_best_effort()

            # 6) Mở form giấy nghỉ
            self._click(By.LINK_TEXT, self.sel("cert_link"), "Giấy chứng nhận nghỉ việc hưởng BHXH")
            WebDriverWait(driver, self.timeout).until(
                lambda d: d.find_elements(By.ID, self.sel("modal"))
            )
            return {"opened": True, "patient": name,
                    "message": f"Đã mở form giấy nghỉ cho {name}."}

    def _dismiss_error_panel_best_effort(self):
        """Theo bản ghi: vào iframe index 0, bấm nút đóng panel 'has-errors' rồi ra top.
        Không phải hồ sơ nào cũng có — nên bỏ qua êm nếu không thấy."""
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

    # ── Điền & chấp nhận ────────────────────────────────────────────────────────
    def _fill_input(self, key: str, value: str):
        if value is None or str(value).strip() == "":
            return
        driver = self._driver()
        els = driver.find_elements(By.ID, self.sel(key))
        if not els:
            raise EmrError(f"Không thấy ô {self.sel(key)} trong form giấy nghỉ.")
        el = els[0]
        try:
            el.clear()
        except WebDriverException:
            pass
        el.click()
        el.send_keys(str(value))
        # Một số ô ngày dùng datepicker đọc value qua JS — set value + bắn event cho chắc.
        driver.execute_script(
            "arguments[0].value = arguments[1];"
            "arguments[0].dispatchEvent(new Event('input', {bubbles:true}));"
            "arguments[0].dispatchEvent(new Event('change', {bubbles:true}));",
            el, str(value),
        )

    def fill_cert(self, cert_fields: dict[str, str], dry_run: bool = True) -> str:
        """Điền 7 ô của form giấy nghỉ. dry_run=True thì KHÔNG bấm Chấp nhận."""
        with self._lock:
            driver = self._driver()
            if not driver.find_elements(By.ID, self.sel("modal")):
                raise EmrError("Form giấy nghỉ chưa mở. Hãy mở form cho người bệnh trước.")
            for key in ("so_ngay_nghi", "don_vi_lam_viec", "ma_so_bhxh", "so_the_bhyt",
                        "ngay_cap_giay", "nghi_tu_ngay", "nghi_den_ngay"):
                self._fill_input(key, cert_fields.get(key, ""))
            if dry_run:
                return "Đã điền thử form giấy nghỉ, chưa bấm Chấp nhận."
            return self._accept()

    def _accept(self) -> str:
        driver = self._driver()
        els = driver.find_elements(By.ID, self.sel("accept_button"))
        if not els:
            raise EmrError(f"Không thấy nút Chấp nhận ({self.sel('accept_button')}).")
        driver.execute_script("arguments[0].click();", els[0])
        time.sleep(1.5)
        return "Đã bấm Chấp nhận giấy nghỉ trên EMR."

    # ── Chụp lại trang/form để gửi kỹ thuật dựng tiếp ───────────────────────────
    def capture_cert(self, name: str = "form-giay-nghi") -> dict[str, Any]:
        """Lưu HTML + ảnh form giấy nghỉ (sau khi mở) để kỹ thuật khớp id/điền chính xác."""
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
