from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from bhyt.portal import BhytPortal, PortalError
from selenium.webdriver.common.by import By


class El:
    def __init__(self, png=b"", text="", displayed=True, enabled=True):
        self.value = ""
        self.clicked = False
        self._png = png
        self.text = text
        self._disp = displayed
        self._en = enabled

    def clear(self):
        self.value = ""

    def send_keys(self, v):
        self.value += str(v)

    def click(self):
        self.clicked = True

    def is_displayed(self):
        return self._disp

    def is_enabled(self):
        return self._en

    @property
    def screenshot_as_png(self):
        return self._png


class FakeDriver:
    """Giả lập trang đăng nhập cổng: có đủ ô, ảnh CAPTCHA, nút Đăng nhập (CSS #btnLogin).
    Sau khi bấm nút, nếu CAPTCHA 'đúng' thì coi như đã đăng nhập."""

    def __init__(self, good_captcha="ABCD"):
        self.current_url = "https://gdbhyt.baohiemxahoi.gov.vn/Account/Index"
        self.title = "PIS | Đăng nhập"
        self.good_captcha = good_captcha
        self.by_id = {
            "macskcb": El(), "username": El(), "password": El(),
            "Captcha_TB_I": El(), "Captcha_IMG": El(png=b"PNGDATA"),
            "Captcha_RB": El(), "MessAlert": El(text=""),
        }
        self.login_btn = El()
        self.by_css = {"#btnLogin": [self.login_btn]}

    def find_elements(self, by, value):
        if by == By.ID:
            el = self.by_id.get(value)
            return [el] if el else []
        return self.by_css.get(value, [])

    def find_element(self, by, value):
        return self.by_id[value]

    def get(self, url):
        self.current_url = url

    def execute_script(self, _script, *_a):
        # session_status() hỏi đã đăng nhập chưa: đúng khi đã bấm nút với CAPTCHA đúng.
        if self.login_btn.clicked and self.by_id["Captcha_TB_I"].value == self.good_captcha:
            self.current_url = "https://gdbhyt.baohiemxahoi.gov.vn/Home/Index"
            return True
        return False


def make_portal(tmp, **kw):
    p = BhytPortal(Path(tmp) / "p", selectors={"login_button": "#btnLogin"}, **kw)
    return p


class HeadlessLoginTests(unittest.TestCase):
    def test_captcha_image_returned_as_data_url(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_portal(tmp)
            p.driver = FakeDriver()
            out = p.get_captcha_image()
        self.assertTrue(out["image"].startswith("data:image/png;base64,"))
        self.assertFalse(out["logged_in"])

    def test_submit_login_fills_fields_and_succeeds_with_right_captcha(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_portal(tmp)
            d = FakeDriver(good_captcha="K7MN")
            p.driver = d
            res = p.submit_login("92115", "nguoidung", "matkhau", "K7MN")
        self.assertTrue(res["logged_in"])
        self.assertEqual(d.by_id["macskcb"].value, "92115")
        self.assertEqual(d.by_id["Captcha_TB_I"].value, "K7MN")
        self.assertTrue(d.login_btn.clicked)

    def test_submit_login_reports_portal_message_on_wrong_captcha(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_portal(tmp, timeout=1)
            d = FakeDriver(good_captcha="K7MN")
            d.by_id["MessAlert"].text = "Mã xác nhận không đúng"
            p.driver = d
            res = p.submit_login("92115", "nguoidung", "matkhau", "SAI1")
        self.assertFalse(res["logged_in"])
        self.assertIn("không đúng", res["message"])
        self.assertTrue(res["need_captcha"])

    def test_missing_captcha_image_element_raises_clear_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_portal(tmp)
            d = FakeDriver()
            del d.by_id["Captcha_IMG"]
            p.driver = d
            with self.assertRaises(PortalError):
                p.get_captcha_image()

    def test_selectors_overridable_from_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = BhytPortal(Path(tmp) / "p", selectors={"facility_code": "ma_cskcb"})
            self.assertEqual(p.sel("facility_code"), "ma_cskcb")
            self.assertEqual(p.sel("username"), "username")


if __name__ == "__main__":
    unittest.main()
