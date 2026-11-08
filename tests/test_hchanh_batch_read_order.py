"""Lấy theo lô: bảng kê không bị đọc lúc chưa mở, Phiếu vào viện mở lại đúng trang,
hồ sơ nền chạy trước để các phần sau dùng đúng khoảng ngày nằm viện."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "worker"
if str(WORKER) not in sys.path:
    sys.path.insert(0, str(WORKER))

import hchanh_fetch as core  # noqa: E402

# Trang người bệnh trước khi bấm bảng kê: có sẵn nút "Sửa chi phí", chữ "Tổng", "BHYT", "Viện phí".
PATIENT_PAGE = '<button id="btnSuaChiPhi">Sửa chi phí</button><span>Tổng</span><span>BHYT</span><a>Viện phí</a>'
BILLING_PAGE = '<div id="divTongHopChiPhi"></div><div id="dsDichVu"><table><tr><td>Khám</td></tr></table></div>'


def test_billing_markers_not_present_on_patient_page_before_click():
    markers = core._hchanh_action_markers("billing")
    assert "btnSuaChiPhi" not in markers
    assert not any(m in PATIENT_PAGE for m in markers)
    assert any(m in BILLING_PAGE for m in markers)


class FakeBillingDriver:
    """Trang người bệnh, sau `open_after` lần đọc thì bảng kê mở, sau `rows_after` lần đếm thì có dòng."""

    def __init__(self, open_after=2, rows_after=2):
        self.reads = 0
        self.counts = 0
        self.open_after = open_after
        self.rows_after = rows_after

    @property
    def page_source(self):
        self.reads += 1
        return BILLING_PAGE if self.reads > self.open_after else PATIENT_PAGE

    def execute_script(self, script, *args):
        self.counts += 1
        return 5 if self.counts > self.rows_after else 0


def test_wait_billing_does_not_return_on_patient_page_and_waits_for_rows():
    driver = FakeBillingDriver(open_after=2, rows_after=2)
    assert core._wait_for_hchanh_action_content(driver, "billing", timeout=5) is True
    assert driver.reads > 2  # không trả về khi còn ở trang người bệnh
    assert driver.counts > 2  # đã chờ tới khi có dòng chi tiết


def test_wait_billing_times_out_when_page_never_opens():
    driver = FakeBillingDriver(open_after=10**9)
    assert core._wait_for_hchanh_action_content(driver, "billing", timeout=1) is False


def test_billing_status_is_honest():
    assert core._billing_fetch_status([{"ten": "Khám"}], {}, True) == "ok"
    assert core._billing_fetch_status([], {}, False) == "not_billing_page"
    assert core._billing_fetch_status([], {"tong_chi_phi": 26117752}, True) == "not_loaded"
    assert core._billing_fetch_status([], {"tong_chi_phi": 0}, True) == "empty"


def test_profile_and_discharge_run_before_other_files():
    assert core._order_hchanh_files(["billing", "profile"]) == ["profile", "billing"]
    assert core._order_hchanh_files(["order_history", "discharge", "billing", "profile"]) == [
        "profile", "discharge", "order_history", "billing"]
    assert core._order_hchanh_files(["billing"]) == ["billing"]


class FakeNavDriver:
    def __init__(self, url):
        self.current_url = url
        self.opened = []

        class _Switch:
            def default_content(self_inner):
                return None

        self.switch_to = _Switch()

    def get(self, url):
        self.opened.append(url)
        self.current_url = url


def test_nursing_page_reopened_when_url_is_another_page(monkeypatch):
    monkeypatch.setattr(core.time, "sleep", lambda *_: None)
    target = "https://emr.example/?wpid=dieuduongdraw&noitruid=1"
    # Trước đây URL chỉ cần chứa "dieuduongdraw" là bỏ qua → vẫn đứng ở trang bảng kê / người khác.
    driver = FakeNavDriver("https://emr.example/?wpid=dieuduongdraw&noitruid=999")
    core._open_nursing_page(driver, target)
    assert driver.opened == [target]
    core._open_nursing_page(driver, target)
    assert driver.opened == [target]  # đã đúng trang thì không tải lại
    core._open_nursing_page(driver, target, force=True)
    assert driver.opened == [target, target]


class FakeLink:
    def __init__(self, shown):
        self.shown = shown

    def is_displayed(self):
        return self.shown


class FakeFindDriver:
    def __init__(self, links):
        self.links = links

    def find_elements(self, by, value):
        assert "Phiếu vào viện" in value
        return self.links


def test_admission_link_found_by_visible_text_or_none():
    shown = FakeLink(True)
    assert core._find_admission_form_link(FakeFindDriver([FakeLink(False), shown]), timeout=0.5) is shown
    assert core._find_admission_form_link(FakeFindDriver([]), timeout=0.5) is None


def test_short_selenium_error_drops_backtrace():
    from selenium.common.exceptions import TimeoutException

    raw = TimeoutException("", stacktrace=["(No symbol) [0x7ff7fbf6be65]"])
    assert core._short_selenium_error(raw) == "hết giờ chờ phần tử trên trang EMR"
    other = Exception("Message: no such element\nStacktrace:\n(No symbol) [0x1]")
    assert core._short_selenium_error(other) == "no such element"
