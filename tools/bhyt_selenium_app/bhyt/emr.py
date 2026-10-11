"""Đọc dữ liệu "Giấy chứng nhận nghỉ việc hưởng BHXH" từ EMR/HIS nội bộ của bệnh viện.

Hướng dữ liệu: ĐỌC từ EMR nội bộ (vd http://192.168.2.26:2026, phần Khám bệnh) →
để điền lên cổng BHXH (gdbhyt.baohiemxahoi.gov.vn) bằng bhyt/portal.py. Module này
CHỈ ĐỌC, không bấm Lưu/Chấp nhận gì trên EMR. Luồng và id phần tử theo đúng bản ghi
thao tác người dùng gửi; nếu EMR đổi id, chỉnh trong config.json → "emr" → "selectors".

Không lưu mật khẩu ra đĩa — chỉ giữ trong RAM. Chỉ chạy được trong mạng bệnh viện.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
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
    # Nút/link "Xem phiếu" (phòng khám) — bấm sẽ ra file PDF phiếu nghỉ.
    "phieu_link": "Xem phiếu",
    # Giấy ra viện (nội trú): Danh sách Điều trị nội trú → hồ sơ → in "Giấy ra viện" (PDF).
    # wpid, bảng tblNoiTru, ô tìm kiếm, ô trạng thái và bộ lọc ngày theo DOM đã dùng ở
    # worker/selenium_emr_helpers.py. Tên phiếu in chưa xác nhận trên máy bệnh viện.
    "inpatient_wpid": "danhsachdieutrinoitrudraw",
    "inpatient_table": "NoiTru",
    "inpatient_search_input": "txtTimKiem",
    "inpatient_search_button": "",  # trống = gõ Enter trong ô tìm kiếm
    "inpatient_status_select": "drpSelectTrangThai",
    "inpatient_status_value": "Hoàn tất",
    "inpatient_range_select": "cbbLoai",
    "inpatient_date_from": "dtTuNgay",
    "inpatient_date_to": "dtDenNgay",
    "grv_report_link": "Giấy ra viện",
    "grv_report_id": "",
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


def _xpath_literal(text: str) -> str:
    """Bọc chuỗi an toàn cho XPath (xử lý cả dấu nháy đơn trong text)."""
    if "'" not in text:
        return f"'{text}'"
    parts = text.split("'")
    return "concat(" + ", \"'\", ".join(f"'{p}'" for p in parts) + ")"


class EmrError(RuntimeError):
    pass


# Khoảng ngày mở trên EMR khi tìm ca ra viện của một ngày: lùi chừng này ngày.
DISCHARGE_LOOKBACK_DAYS = 60


def parse_day(value: Any) -> date:
    """'05/10/2026' / '2026-10-05' / date → date. Trống = hôm nay."""
    if isinstance(value, date):
        return value
    raw = str(value or "").strip()
    if not raw:
        return date.today()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(raw, fmt).date()
        except ValueError:
            continue
    raise EmrError(f"Không hiểu ngày '{raw}'. Chọn ngày theo dạng ngày/tháng/năm.")


def _same_day(text: Any, target: date) -> bool:
    import re
    m = re.search(r"(\d{1,2})[/-](\d{1,2})[/-](\d{4})", str(text or ""))
    if not m:
        return False
    try:
        return date(int(m.group(3)), int(m.group(2)), int(m.group(1))) == target
    except ValueError:
        return False


# Chọn trạng thái + đặt "Khoảng" ngày trên danh sách nội trú. Port gọn từ
# set_inpatient_status_filter / set_time_range_filter (worker/selenium_emr_helpers.py).
_INPATIENT_FILTER_JS = r"""
const a = arguments[0];
function norm(s) {
  try { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/\s+/g, ' ').trim(); }
  catch (e) { return String(s || '').toLowerCase(); }
}
function fire(el, val) {
  try { el.dispatchEvent(new Event('input', {bubbles: true})); } catch (e) {}
  try { el.dispatchEvent(new Event('change', {bubbles: true})); } catch (e) {}
  try { if (window.jQuery) window.jQuery(el).val(val).trigger('change').trigger('dp.change'); } catch (e) {}
}
function pick(sel, test) {
  if (!sel) return false;
  const opt = Array.from(sel.options || []).find(test);
  if (!opt) return false;
  sel.value = opt.value; fire(sel, opt.value); return true;
}
const out = {};
if (a.status_id) {
  const want = norm(a.status);
  out.status = pick(document.getElementById(a.status_id), o => norm(o.text).includes(want));
}
if (a.date_from) {
  out.range = pick(document.getElementById(a.range_id),
                   o => norm(o.text).includes('khoang') || String(o.value).trim() === '7');
  try { if (typeof FilterChange === 'function') FilterChange(); } catch (e) {}
  const f = document.getElementById(a.from_id), t = document.getElementById(a.to_id);
  if (f) { f.value = '00:00 ' + a.date_from; f.setAttribute('value', f.value); fire(f, f.value); }
  if (t) { t.value = '23:59 ' + a.date_to; t.setAttribute('value', t.value); fire(t, t.value); }
  out.dates = !!(f && t);
}
return out;
"""


class EmrPortal:
    def __init__(self, base_url: str, profile_dir: str | Path, timeout: int = 40,
                 headless: bool = True, selectors: dict[str, str] | None = None,
                 debug_dir: str | Path | None = None,
                 download_dir: str | Path | None = None,
                 doctors: list[str] | None = None):
        self.base_url = (base_url or "").rstrip("/")
        self.profile_dir = Path(profile_dir).resolve()
        self.timeout = timeout
        self.headless = headless
        self.selectors = {**DEFAULT_EMR_SELECTORS, **(selectors or {})}
        self.debug_dir = Path(debug_dir).resolve() if debug_dir else None
        self.download_dir = (
            Path(download_dir).resolve() if download_dir
            else self.profile_dir.parent / "emr_downloads"
        )
        self._inpatient_range: tuple[str, str] = ("", "")  # khoảng ngày lần quét ra viện gần nhất
        self.doctors = list(doctors) if doctors else None  # để nhận tên trưởng khoa trên giấy ra viện
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
            self.download_dir.mkdir(parents=True, exist_ok=True)
            options = webdriver.ChromeOptions()
            options.add_argument(f"--user-data-dir={self.profile_dir}")
            options.add_argument("--disable-notifications")
            options.add_experimental_option("excludeSwitches", ["enable-automation"])
            # Bắt Chrome TẢI file PDF về thay vì mở trong trình xem — để tự đọc được file.
            options.add_experimental_option("prefs", {
                "download.default_directory": str(self.download_dir),
                "download.prompt_for_download": False,
                "plugins.always_open_pdf_externally": True,
                "profile.default_content_setting_values.automatic_downloads": 1,
            })
            if self.headless:
                options.add_argument("--headless=new")
                options.add_argument("--window-size=1366,900")
                options.add_argument("--disable-gpu")
            else:
                options.add_argument("--start-maximized")
            self.driver = webdriver.Chrome(options=options)
            # Headless cũng cho phép tải file về thư mục trên.
            try:
                self.driver.execute_cdp_cmd("Page.setDownloadBehavior", {
                    "behavior": "allow", "downloadPath": str(self.download_dir),
                })
            except WebDriverException:
                pass
            self.driver.get(f"{self.base_url}/login.aspx")
            return "Đã mở trình duyệt EMR."

    def _driver(self) -> webdriver.Chrome:
        if self.driver is None:
            raise EmrError("Chưa mở trình duyệt EMR. Hãy đăng nhập EMR trước.")
        return self.driver

    def _is_login_page(self) -> bool:
        if self.driver is None:
            return True  # chưa mở trình duyệt EMR = chưa đăng nhập
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

    def _go_to_patient_record(self, name: str):
        """Điều hướng: menu trái → Danh sách Khám bệnh → tìm người bệnh → mở hồ sơ.
        Dùng chung cho cả mở form giấy nghỉ lẫn bấm "Xem phiếu"."""
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

    # ── Nội trú: Danh sách Điều trị nội trú → hồ sơ → in Giấy ra viện ───────────
    def _inpatient_list_url(self) -> str:
        """URL danh sách nội trú, giữ tham số phiên (scope/lang/role/usid/st) của trang
        đang mở — giống _clean_inpatient_list_url ở worker/hchanh_fetch.py."""
        from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

        p = urlparse(self._driver().current_url or "")
        q = dict(parse_qsl(p.query, keep_blank_values=True))
        if "usid" not in {k.lower() for k in q}:
            raise EmrError(
                "Không thấy phiên EMR trên trang đang mở (thiếu usid). Hãy đăng nhập EMR lại."
            )
        clean = {k: v for k, v in q.items() if k.lower() in {"scope", "lang", "role", "usid", "st"}}
        clean["wpid"] = self.sel("inpatient_wpid")
        return urlunparse((p.scheme, p.netloc, p.path or "/home.aspx", "", urlencode(clean), ""))

    def _open_inpatient_list(self, keyword: str = "", date_from: str = "", date_to: str = ""):
        """Mở Danh sách Điều trị nội trú, chọn trạng thái "Hoàn tất" (= đã ra viện), đặt
        khoảng ngày (dd/mm/yyyy) nếu có, gõ từ khoá rồi tìm. Cách chọn trạng thái và
        khoảng ngày giống set_inpatient_status_filter / set_time_range_filter ở
        worker/selenium_emr_helpers.py (EMR mặc định lọc "3 tháng", phải đổi sang "Khoảng")."""
        driver = self._driver()
        driver.get(self._inpatient_list_url())
        time.sleep(1.0)
        driver.execute_script(_INPATIENT_FILTER_JS, {
            "status_id": self.sel("inpatient_status_select"),
            "status": self.sel("inpatient_status_value"),
            "range_id": self.sel("inpatient_range_select"),
            "from_id": self.sel("inpatient_date_from"),
            "to_id": self.sel("inpatient_date_to"),
            "date_from": date_from or date_to,
            "date_to": date_to or date_from,
        })
        time.sleep(0.5)
        inputs = driver.find_elements(By.ID, self.sel("inpatient_search_input"))
        buttons = driver.find_elements(By.ID, self.sel("inpatient_search_button")) \
            if self.sel("inpatient_search_button") else []
        if inputs:
            inputs[0].clear()
            if keyword:
                inputs[0].send_keys(keyword)
        if buttons:
            driver.execute_script("arguments[0].click();", buttons[0])
        elif inputs:
            inputs[0].send_keys(Keys.ENTER)
        time.sleep(1.5)

    def _go_to_inpatient_record(self, name: str):
        """Mở hồ sơ nội trú của người bệnh: tìm theo tên trong danh sách nội trú (cùng
        khoảng ngày vừa quét, nếu có), bấm link trên đúng dòng của bảng tblNoiTru."""
        date_from, date_to = self._inpatient_range
        self._open_inpatient_list(name, date_from, date_to)
        lit = _xpath_literal(name.upper())
        table = _xpath_literal(self.sel("inpatient_table"))
        row_link = (f"//table[contains(@id, {table})]//tr"
                    f"[contains(translate(normalize-space(.), 'abcdefghijklmnopqrstuvwxyz', "
                    f"'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), {lit})]//a")
        try:
            self._click(By.XPATH, row_link, f"hồ sơ nội trú {name.upper()}")
        except EmrError:
            self._click(By.PARTIAL_LINK_TEXT, name.upper(), f"hồ sơ nội trú {name.upper()}")
        time.sleep(1.0)
        self._dismiss_error_panel_best_effort()

    def _click_grv_report(self):
        """In "Giấy ra viện". Đã biết mã phiếu (grv_report_id) thì gọi thẳng
        OnReportPdf(mã) như worker/ward_print_discharge_bundle.py; chưa biết thì bấm
        link phiếu in có chữ "Giấy ra viện" (ưu tiên link gọi OnReportPdf)."""
        driver = self._driver()
        report_id = self.sel("grv_report_id")
        if report_id:
            ok = driver.execute_script(
                "if (typeof OnReportPdf === 'function') { OnReportPdf(arguments[0]); return true; }"
                " return false;",
                report_id,
            )
            if ok:
                return
        label = _xpath_literal(self.sel("grv_report_link"))
        try:
            self._click(By.XPATH,
                        f"//a[contains(@href, 'OnReportPdf')][contains(normalize-space(.), {label})]",
                        "phiếu in Giấy ra viện")
        except EmrError:
            self._click(By.XPATH,
                        f"//*[self::a or self::button][contains(normalize-space(.), {label})]",
                        "phiếu in Giấy ra viện")

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
            self._go_to_patient_record(name)
            self._click(By.LINK_TEXT, self.sel("cert_link"), "Giấy chứng nhận nghỉ việc hưởng BHXH")
            WebDriverWait(driver, self.timeout).until(
                lambda d: d.find_elements(By.ID, self.sel("modal"))
            )
            return {"opened": True, "patient": name, "message": f"Đã mở form giấy nghỉ của {name}."}

    # ── Bấm "Xem phiếu" → tải PDF phiếu phòng khám → đọc ────────────────────────
    def read_phieu_pdf(self, patient_name: str) -> dict[str, Any]:
        """Điều hướng tới hồ sơ người bệnh, bấm "Xem phiếu", tải file PDF về rồi đọc
        bằng pdf_phieu.parse_phieu_pdf. Trả về {pdf_path, doc_type, fields}.

        Lấy file PDF theo 2 cách (ưu tiên cách 1): (1) Chrome tải file về thư mục
        download_dir (đã bật always_open_pdf_externally); (2) nếu không thấy file tải về,
        tìm URL file PDF (tab mới / embed / link) rồi tải bằng requests + cookie phiên EMR.
        Nếu đều không được thì chụp trang để kỹ thuật khớp lại selector.
        """
        from .pdf_phieu import parse_phieu_pdf

        return self._read_pdf(
            patient_name,
            navigate=self._go_to_patient_record,
            click=self._click_phieu_button,
            parse=parse_phieu_pdf,
            fail_name="xem-phieu",
            fail_message='Bấm "Xem phiếu" xong nhưng không lấy được file PDF. Đã chụp trang — '
                         "gửi em bản chụp để khớp lại, hoặc kiểm tra EMR có bật tải PDF không.",
        )

    def read_giay_ra_vien_pdf(self, patient_name: str) -> dict[str, Any]:
        """Giấy ra viện (nội trú, mẫu 03): mở Danh sách Điều trị nội trú → hồ sơ người
        bệnh → in "Giấy ra viện" ra PDF → đọc bằng pdf_giay_ra_vien. Lấy file PDF giống
        hệt phiếu phòng khám (iframe trong modal hoặc file tải về)."""
        from .pdf_giay_ra_vien import parse_grv_pdf

        return self._read_pdf(
            patient_name,
            navigate=self._go_to_inpatient_record,
            click=self._click_grv_report,
            parse=lambda path: parse_grv_pdf(path, self.doctors),
            fail_name="giay-ra-vien",
            fail_message='Đã mở hồ sơ nội trú nhưng không lấy được file PDF "Giấy ra viện". '
                         "Đã chụp trang — gửi em bản chụp để khớp lại.",
        )

    def read_sick_leave_pdf(self, patient_name: str, doc_type: str = "") -> dict[str, Any]:
        """Đọc đúng loại giấy theo loại hồ sơ: giấy ra viện (nội trú) hoặc phiếu phòng khám."""
        from .mapping import DOC_GRV

        if doc_type == DOC_GRV:
            return self.read_giay_ra_vien_pdf(patient_name)
        return self.read_phieu_pdf(patient_name)

    def _read_pdf(self, patient_name: str, navigate, click, parse, fail_name: str,
                  fail_message: str) -> dict[str, Any]:
        """Mạch chung: điều hướng tới hồ sơ → bấm nút in → lấy PDF → đọc."""
        from .pdf_phieu import PhieuPdfError

        with self._lock:
            if self._is_login_page():
                raise EmrError("Phiên EMR chưa đăng nhập hoặc đã hết hạn. Hãy đăng nhập lại.")
            name = (patient_name or "").strip()
            if not name:
                raise EmrError("Thiếu tên người bệnh để tìm trong EMR.")
            driver = self._driver()
            self.download_dir.mkdir(parents=True, exist_ok=True)

            before_files = self._list_downloads()
            before_handles = set(driver.window_handles)

            navigate(name)
            click()

            pdf_path = self._acquire_phieu_pdf(before_files, before_handles, name)

            if pdf_path is None:
                self.dump_page(fail_name)
                raise EmrError(fail_message)
            try:
                parsed = parse(pdf_path)
            except PhieuPdfError as exc:
                raise EmrError(f"Tải được PDF nhưng đọc không ra: {exc}") from exc
            return {
                "pdf_path": str(pdf_path),
                "doc_type": parsed["doc_type"],
                "fields": parsed["fields"],
            }

    def _click_phieu_button(self):
        """Bấm nút "Xem phiếu". Trên EMR đây là <button><strong>Xem phiếu</strong></button>
        (không phải link <a>), nên dò theo text cho cả button lẫn a. Giữ fallback link."""
        label = self.sel("phieu_link")
        xpath = (f"//*[self::button or self::a]"
                 f"[contains(normalize-space(.), {_xpath_literal(label)})]")
        try:
            self._click(By.XPATH, xpath, 'nút "Xem phiếu"')
        except EmrError:
            # Dự phòng: EMR cũ có thể dựng "Xem phiếu" bằng link.
            try:
                self._click(By.LINK_TEXT, label, 'nút "Xem phiếu"')
            except EmrError:
                self._click(By.PARTIAL_LINK_TEXT, label, 'nút "Xem phiếu"')

    def _acquire_phieu_pdf(self, before_files: set[str], before_handles: set[str],
                           name: str) -> Path | None:
        """Lấy file PDF sau khi bấm "Xem phiếu". EMR mở modal có <iframe src=...pdf>
        (không tải file, không mở tab mới), nên vừa chờ iframe/embed trỏ tới PDF để
        tải bằng cookie phiên, vừa chờ Chrome tải file về — cái nào xong trước lấy
        cái đó. Không đợi hết timeout cho một cách rồi mới thử cách kia."""
        deadline = time.time() + self.timeout
        while time.time() < deadline:
            if not any(self.download_dir.glob("*.crdownload")):
                new = self._list_downloads() - before_files
                if new:
                    newest = max((self.download_dir / n for n in new),
                                 key=lambda p: p.stat().st_mtime)
                    if newest.stat().st_size > 0:
                        return newest
            pdf_path = self._download_pdf_from_page(before_handles, name)
            if pdf_path is not None:
                return pdf_path
            time.sleep(0.5)
        return None

    # ── Quét danh sách phòng khám cuối ngày → ca còn tuổi lao động → ai có phiếu ──
    def list_clinic_patients(self) -> list[dict[str, Any]]:
        """Mở "Danh sách Khám bệnh" rồi đọc bảng theo TÊN CỘT (tự dò cột họ tên/năm
        sinh… nên EMR đổi thứ tự cột vẫn đúng, không cần cấu hình chỉ số). Trả về
        list {ho_ten, nam_sinh, gioi_tinh, tuoi, ma_bn, raw}."""
        from .clinic_list import parse_clinic_patients

        with self._lock:
            if self._is_login_page():
                raise EmrError("Phiên EMR chưa đăng nhập hoặc đã hết hạn. Hãy đăng nhập lại.")
            driver = self._driver()
            self._click(By.XPATH, self.sel("menu_group"), "nhóm menu bên trái")
            self._click(By.LINK_TEXT, self.sel("menu_exam_link"), "Danh sách Khám bệnh")
            time.sleep(1.0)

            try:
                patients = parse_clinic_patients(driver.page_source or "")
            except RuntimeError as exc:
                raise EmrError(str(exc)) from exc
            if not patients:
                self.dump_page("danh-sach-kham")
                raise EmrError(
                    "Không đọc được bảng Danh sách Khám bệnh (không thấy cột quen thuộc). "
                    "Đã chụp trang — gửi em bản chụp để khớp lại."
                )
            return patients

    def harvest_sick_leave(self, ref_year: int | None = None, limit: int | None = None,
                           progress=None) -> dict[str, Any]:
        """Quét danh sách khám → lọc còn tuổi lao động → với mỗi ca thử đọc phiếu
        nghỉ (Xem phiếu); ca nào có phiếu hợp lệ thì gom lại để nhập lên cổng.
        Trả về {scanned, working_age, found: [{ho_ten, doc_type, fields, pdf_path}]}."""
        with self._lock:
            return self._harvest(self.list_clinic_patients(), self.read_phieu_pdf,
                                 ref_year, limit, progress)

    def list_inpatient_discharges(self, day: Any = None,
                                  lookback_days: int = DISCHARGE_LOOKBACK_DAYS) -> list[dict[str, Any]]:
        """Người bệnh RA VIỆN trong ngày ``day`` (mặc định hôm nay; nhận dd/mm/yyyy hoặc
        yyyy-mm-dd). Mở Danh sách Điều trị nội trú trạng thái "Hoàn tất" với khoảng ngày
        lùi ``lookback_days`` ngày (khoảng ngày của EMR có thể tính theo ngày vào viện, nên
        mở rộng để không sót ca nằm lâu), rồi chỉ giữ dòng có Ngày ra viện đúng ngày đó.
        Bảng không có cột ngày ra thì giữ hết. Trả về list {ho_ten, nam_sinh, gioi_tinh,
        tuoi, ma_bn, trang_thai, ngay_ra, raw}; ngày đó không có ai ra viện thì list rỗng."""
        from .clinic_list import INPATIENT_TOKENS, parse_clinic_patients

        target = parse_day(day)
        date_to = target.strftime("%d/%m/%Y")
        date_from = (target - timedelta(days=int(lookback_days))).strftime("%d/%m/%Y")
        with self._lock:
            if self._is_login_page():
                raise EmrError("Phiên EMR chưa đăng nhập hoặc đã hết hạn. Hãy đăng nhập lại.")
            self._inpatient_range = (date_from, date_to)
            self._open_inpatient_list("", date_from, date_to)
            try:
                patients = parse_clinic_patients(self._driver().page_source or "",
                                                 INPATIENT_TOKENS)
            except RuntimeError as exc:
                raise EmrError(str(exc)) from exc
            if not patients:
                self.dump_page("danh-sach-noi-tru")
                raise EmrError(
                    "Không đọc được bảng Danh sách Điều trị nội trú (không thấy cột quen thuộc "
                    "hoặc EMR không có ca nào trong khoảng ngày). Đã chụp trang — gửi em bản chụp "
                    "để khớp lại."
                )
            if not any(p.get("ngay_ra") for p in patients):
                return patients
            return [p for p in patients if _same_day(p.get("ngay_ra"), target)]

    def harvest_discharges(self, ref_year: int | None = None, limit: int | None = None,
                           progress=None, day: Any = None) -> dict[str, Any]:
        """Quét người bệnh ra viện trong ngày ``day`` (mặc định hôm nay) → lọc còn tuổi
        lao động → với mỗi ca in Giấy ra viện (PDF) và đọc; ca nào đọc được thì gom lại
        để nhập cổng (mẫu 03)."""
        with self._lock:
            return self._harvest(self.list_inpatient_discharges(day), self.read_giay_ra_vien_pdf,
                                 ref_year, limit, progress)

    def _harvest(self, patients: list[dict[str, Any]], reader, ref_year, limit,
                 progress) -> dict[str, Any]:
        from .working_age import is_likely_working_age, is_likely_working_age_by_age

        year = int(ref_year) if ref_year else datetime.now().year

        def working(p: dict[str, Any]) -> bool:
            if str(p.get("tuoi") or "").strip():
                return is_likely_working_age_by_age(p.get("tuoi"), p.get("gioi_tinh"), year)
            return is_likely_working_age(p.get("nam_sinh"), p.get("gioi_tinh"), year)

        candidates = [p for p in patients if working(p)]
        if limit:
            candidates = candidates[: int(limit)]

        found: list[dict[str, Any]] = []
        for i, cand in enumerate(candidates):
            if callable(progress):
                progress(i + 1, len(candidates), cand["ho_ten"])
            try:
                res = reader(cand["ho_ten"])
            except EmrError:
                continue  # không có giấy / không mở được → coi như không cần nhập
            found.append({
                "ho_ten": cand["ho_ten"],
                "doc_type": res.get("doc_type"),
                "fields": res.get("fields", {}),
                "pdf_path": res.get("pdf_path"),
            })
        return {"scanned": len(patients), "working_age": len(candidates), "found": found}

    def _list_downloads(self) -> set[str]:
        try:
            return {p.name for p in self.download_dir.glob("*.pdf")}
        except OSError:
            return set()

    def _wait_for_download(self, before_files: set[str]) -> Path | None:
        """Chờ file .pdf mới xuất hiện trong download_dir (bỏ qua .crdownload đang tải)."""
        deadline = time.time() + self.timeout
        while time.time() < deadline:
            time.sleep(0.5)
            if any(self.download_dir.glob("*.crdownload")):
                continue  # còn đang tải
            new = self._list_downloads() - before_files
            if new:
                newest = max((self.download_dir / n for n in new), key=lambda p: p.stat().st_mtime)
                if newest.stat().st_size > 0:
                    return newest
        return None

    def _resolve_url(self, url: str) -> str:
        url = (url or "").strip()
        if not url or url.startswith(("http://", "https://")):
            return url
        if url.startswith("//"):
            return "https:" + url
        return f"{self.base_url}/{url.lstrip('/')}"

    def _find_pdf_url_in_page(self, before_handles: set[str]) -> str:
        """Tìm URL file PDF sau khi bấm "Xem phiếu".

        Ưu tiên nguồn chắc chắn là PDF (src/href chứa .pdf) để không bắt nhầm iframe
        khác trên trang (ví dụ iframe panel báo lỗi). Thứ tự: embed/iframe/object hoặc
        link có .pdf → tab mới → embed/iframe/object bất kỳ."""
        driver = self._driver()
        embeds = (("embed", "src"), ("iframe", "src"), ("object", "data"))

        # 1) Nguồn có đuôi .pdf — chắc chắn là file phiếu.
        for tag, attr in embeds:
            for el in driver.find_elements(By.TAG_NAME, tag):
                src = el.get_attribute(attr) or ""
                if ".pdf" in src.lower():
                    return src
        for a in driver.find_elements(By.TAG_NAME, "a"):
            href = a.get_attribute("href") or ""
            if ".pdf" in href.lower():
                return href

        # 2) Tab mới (EMR cũ có thể mở PDF ở tab khác).
        for handle in driver.window_handles:
            if handle not in before_handles:
                driver.switch_to.window(handle)
                url = (driver.current_url or "")
                if url and not url.startswith(("about:", "chrome:")):
                    return url

        # 3) Embed/iframe/object bất kỳ (dự phòng).
        for tag, attr in embeds:
            for el in driver.find_elements(By.TAG_NAME, tag):
                src = el.get_attribute(attr) or ""
                if src and not src.startswith(("about:", "chrome:")):
                    return src
        return ""

    def _download_pdf_from_page(self, before_handles: set[str], name: str) -> Path | None:
        """Cách 2: tìm URL file PDF rồi tải bằng requests, mang theo cookie phiên EMR."""
        url = self._resolve_url(self._find_pdf_url_in_page(before_handles))
        if not url or url.startswith("blob:"):
            return None  # blob: không tải bằng requests được — để cách 1/chụp trang lo
        try:
            import requests
        except ImportError:
            return None
        driver = self._driver()
        session = requests.Session()
        for c in driver.get_cookies():
            try:
                session.cookies.set(c.get("name"), c.get("value"), domain=c.get("domain"))
            except Exception:  # noqa: BLE001
                pass
        try:
            resp = session.get(url, timeout=self.timeout, stream=True)
            resp.raise_for_status()
            data = resp.content
        except Exception:  # noqa: BLE001
            return None
        ctype = resp.headers.get("Content-Type", "").lower()
        if not (data[:5].startswith(b"%PDF") or "pdf" in ctype):
            return None
        safe = "".join(c for c in name if c.isalnum() or c in "-_ ").strip().replace(" ", "_") or "phieu"
        path = self.download_dir / f"{safe}_{int(time.time())}.pdf"
        try:
            path.write_bytes(data)
        except OSError:
            return None
        return path

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
