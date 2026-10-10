from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from bhyt.portal import BhytPortal
from selenium.webdriver.common.by import By


class El:
    def __init__(self):
        self.value = ""
        self.clicked = False

    def clear(self):
        self.value = ""

    def send_keys(self, v):
        self.value += str(v)

    def is_displayed(self):
        return True


class FakeDriver:
    """Giả lập trang tra cứu thông tuyến: đã đăng nhập, có các ô theo id cho trước."""

    def __init__(self, ids):
        self.current_url = "https://gdbhyt.baohiemxahoi.gov.vn/ThongTuyenLSKCB/Index"
        self.title = "Tra cứu"
        self.by_id = {i: El() for i in ids}
        self.btn = El()

    def get(self, url):
        self.current_url = url

    def find_elements(self, by, value):
        if by == By.ID:
            el = self.by_id.get(value)
            return [el] if el else []
        if value.startswith("#"):
            return [self.btn] if value == "#btnTraCuu" else []
        return []

    def execute_script(self, script, *args):
        if "hasLoginForm" in script:
            return True  # session_status: đã đăng nhập
        if "documentReady" in script:
            return True  # _wait_ready
        if args and "click" in script:
            args[0].clicked = True
        return None

    def save_screenshot(self, path):
        with open(path, "wb") as fh:
            fh.write(b"PNG")
        return True

    @property
    def page_source(self):
        return "<html>tra cuu</html>"


def make_portal(tmp):
    return BhytPortal(Path(tmp) / "p", debug_dir=Path(tmp) / "debug")


class LookupThongTuyenTests(unittest.TestCase):
    def test_fills_known_fields_and_captures(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_portal(tmp)
            p.driver = FakeDriver(ids=["MaThe", "HoTen", "NamSinh"])
            out = p.lookup_thong_tuyen("DN4790112345", "NGUYEN VAN A", "1985")
        self.assertEqual(out["missing"], [])
        self.assertTrue(out["clicked"])
        self.assertEqual(p.driver.by_id["MaThe"].value, "DN4790112345")
        self.assertEqual(p.driver.by_id["HoTen"].value, "NGUYEN VAN A")
        self.assertEqual(p.driver.by_id["NamSinh"].value, "1985")
        self.assertIn("html", out["capture"])

    def test_reports_missing_field_when_id_not_found(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_portal(tmp)
            # Thiếu ô năm sinh trên trang → phải báo missing lookup_birth.
            p.driver = FakeDriver(ids=["MaThe", "HoTen"])
            out = p.lookup_thong_tuyen("DN4790112345", "NGUYEN VAN A", "1985")
        self.assertIn("lookup_birth", out["missing"])
        self.assertIn("html", out["capture"])

    def test_empty_values_are_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_portal(tmp)
            p.driver = FakeDriver(ids=["MaThe", "HoTen", "NamSinh"])
            out = p.lookup_thong_tuyen("DN4790112345", "", "")
        # Chỉ điền mã thẻ; không coi name/birth là missing vì bỏ trống.
        self.assertEqual(out["missing"], [])
        self.assertEqual(p.driver.by_id["HoTen"].value, "")


if __name__ == "__main__":
    unittest.main()
