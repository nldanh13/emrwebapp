"""D/s Phẫu thuật: BN không mổ không phải chờ hết 15 giây, BN có mổ vẫn bắt được dòng đến muộn."""
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "worker"
if str(WORKER) not in sys.path:
    sys.path.insert(0, str(WORKER))

import hchanh_fetch as core  # noqa: E402

LIST_URL = "http://emr/home.aspx?wpid=danhsachphauthuatdraw"


class FakeListDriver:
    """Bảng trả về theo thời gian: trước `ready_at` là bảng cũ, sau đó là kết quả tìm."""

    def __init__(self, before, after, ready_at, after_html=""):
        self.current_url = LIST_URL
        self.before = before
        self.after = after
        self.ready_at = time.time() + ready_at
        self.after_html = after_html

    def _ready(self):
        return time.time() >= self.ready_at

    @property
    def page_source(self):
        return self.after_html if self._ready() else "<html>bảng mặc định</html>"

    def execute_script(self, script, *args):
        sig = self.after if self._ready() else self.before
        return [sig[0], sig[1], 0]


def test_empty_result_stops_once_table_changed_and_settled():
    driver = FakeListDriver(before=(25, 4000), after=(1, 20), ready_at=0.2)
    before = core._surgery_list_table_signature(driver)
    started = time.time()
    found = core._wait_for_surgery_list_rows(driver, "BN1", timeout=15, before_signature=before, poll_interval=0.05)
    assert found is False
    assert time.time() - started < 3


def test_late_rows_for_patient_are_still_found():
    html = '<table><tr access_id="pt1"><td>1</td><td>BN1</td></tr></table>'
    driver = FakeListDriver(before=(25, 4000), after=(1, 300), ready_at=0.5, after_html=html)
    before = core._surgery_list_table_signature(driver)
    assert core._wait_for_surgery_list_rows(driver, "BN1", timeout=5, before_signature=before, poll_interval=0.05) is True


def test_unchanged_table_keeps_full_wait():
    # Bảng không đổi: không chắc lệnh tìm đã chạy, nên vẫn chờ đủ thời gian như trước.
    driver = FakeListDriver(before=(0, 0), after=(0, 0), ready_at=0)
    started = time.time()
    assert core._wait_for_surgery_list_rows(driver, "BN1", timeout=1.0, before_signature=(0, 0), poll_interval=0.05) is False
    assert time.time() - started >= 0.95


def test_busy_ajax_is_not_treated_as_settled():
    class Busy(FakeListDriver):
        def execute_script(self, script, *args):
            return [1, 20, 1]

    driver = Busy(before=(25, 4000), after=(1, 20), ready_at=0)
    started = time.time()
    assert core._wait_for_surgery_list_rows(driver, "BN1", timeout=1.0, before_signature=(25, 4000), poll_interval=0.05) is False
    assert time.time() - started >= 0.95
