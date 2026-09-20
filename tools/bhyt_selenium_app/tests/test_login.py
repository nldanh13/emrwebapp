from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from bhyt.portal import BhytPortal


class FakeElement:
    def __init__(self):
        self.value = ""
        self.clicked = False

    def clear(self):
        self.value = ""

    def send_keys(self, value):
        self.value += value

    def click(self):
        self.clicked = True


class FakeDriver:
    def __init__(self):
        self.current_url = "https://gdbhyt.baohiemxahoi.gov.vn/Account/Index"
        self.title = "PIS v2.0 | Đăng nhập"
        self.fields = {name: FakeElement() for name in ("macskcb", "username", "password", "Captcha_TB_I")}

    def find_elements(self, _by, value):
        return [self.fields[value]] if value in self.fields else []

    def find_element(self, _by, value):
        return self.fields[value]

    def execute_script(self, _script, *_args):
        return False

    def get(self, url):
        self.current_url = url


class PortalLoginTests(unittest.TestCase):
    def test_fills_expected_login_fields_and_focuses_captcha(self):
        with tempfile.TemporaryDirectory() as tmp:
            portal = BhytPortal(Path(tmp) / "profile")
            driver = FakeDriver()
            portal.driver = driver
            message = portal.fill_login("92001", "nguoidung", "matkhau")
        self.assertEqual(driver.fields["macskcb"].value, "92001")
        self.assertEqual(driver.fields["username"].value, "nguoidung")
        self.assertEqual(driver.fields["password"].value, "matkhau")
        self.assertTrue(driver.fields["Captcha_TB_I"].clicked)
        self.assertNotIn("matkhau", message)


if __name__ == "__main__":
    unittest.main()
