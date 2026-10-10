from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from bhyt.emr import EmrError, EmrPortal, build_cert_fields, _days_between
from selenium.webdriver.common.by import By


class El:
    def __init__(self, text=""):
        self.value = ""
        self.clicked = False
        self.text = text

    def clear(self):
        self.value = ""

    def send_keys(self, v):
        self.value += str(v)

    def click(self):
        self.clicked = True


class SwitchTo:
    def __init__(self, driver):
        self.driver = driver

    def frame(self, _f):
        self.driver.frame = "child"

    def default_content(self):
        self.driver.frame = "top"


class FakeDriver:
    """Giả lập EMR: đăng nhập xong thì rời login.aspx; có sẵn modal + 7 ô form giấy nghỉ."""

    def __init__(self, base="http://192.168.2.26:2026", logged_in=False, has_modal=False):
        self.base = base
        self.current_url = f"{base}/home.aspx" if logged_in else f"{base}/login.aspx"
        self.title = "EMR"
        self.frame = "top"
        self.switch_to = SwitchTo(self)
        self.login_clicked = False
        self.by_id = {
            "txtLoginName": El(), "txtPassword": El(), "btnLogin": El(),
            "txtTimKiem": El(), "btnTimKiem": El(),
        }
        if has_modal:
            for fid in ("divModalContentX", "txtSoNgayNghi", "txtDonViLamViec",
                        "txtMaSoBHXH", "txtSoTheBHYT", "txtNgayCapGiay",
                        "txtNghiTuNgay", "txtNghiDenNgay", "btnChapNhanGiay"):
                self.by_id[fid] = El()

    def find_elements(self, by, value):
        if by == By.ID:
            el = self.by_id.get(value)
            return [el] if el else []
        return []

    def find_element(self, by, value):
        return self.by_id[value]

    def get(self, url):
        self.current_url = url

    def execute_script(self, script, *args):
        # _click và _fill_input dùng execute_script('arguments[0].click()' / set value...)
        if args and isinstance(args[0], El):
            el = args[0]
            if "click" in script:
                el.clicked = True
                if el is self.by_id.get("btnLogin"):
                    self.login_clicked = True
                    self.current_url = f"{self.base}/home.aspx"  # đăng nhập xong
            elif "value" in script and len(args) > 1:
                el.value = str(args[1])
        return None

    def get_screenshot_as_png(self):
        return b"PNG"

    @property
    def page_source(self):
        return "<html>emr</html>"


def make_emr(tmp, **kw):
    return EmrPortal("http://192.168.2.26:2026", Path(tmp) / "p", **kw)


class BuildCertFieldsTests(unittest.TestCase):
    def test_maps_fields_and_computes_days(self):
        out = build_cert_fields({
            "ten_dv": "Cty A", "ma_bhxh": "0123456789", "ma_the": "DN4790112345",
            "tu_ngay": "01/10/2026", "den_ngay": "05/10/2026", "ngay_ct": "05/10/2026",
        })
        self.assertEqual(out["so_ngay_nghi"], "5")  # tính cả hai đầu
        self.assertEqual(out["don_vi_lam_viec"], "Cty A")
        self.assertEqual(out["ma_so_bhxh"], "0123456789")
        self.assertEqual(out["so_the_bhyt"], "DN4790112345")
        self.assertEqual(out["nghi_tu_ngay"], "01/10/2026")
        self.assertEqual(out["nghi_den_ngay"], "05/10/2026")

    def test_explicit_so_ngay_nghi_wins_over_computed(self):
        out = build_cert_fields({"so_ngay_nghi": "3", "tu_ngay": "01/10/2026", "den_ngay": "05/10/2026"})
        self.assertEqual(out["so_ngay_nghi"], "3")

    def test_days_between_invalid_returns_empty(self):
        self.assertEqual(_days_between("", ""), "")
        self.assertEqual(_days_between("05/10/2026", "01/10/2026"), "")  # ngược thứ tự
        self.assertEqual(_days_between("x", "y"), "")

    def test_missing_fields_left_empty(self):
        out = build_cert_fields({})
        self.assertEqual(out["don_vi_lam_viec"], "")
        self.assertEqual(out["so_the_bhyt"], "")


class EmrPortalTests(unittest.TestCase):
    def test_selectors_overridable(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp, selectors={"login_user": "txtUser"})
            self.assertEqual(p.sel("login_user"), "txtUser")
            self.assertEqual(p.sel("login_pass"), "txtPassword")

    def test_login_success_leaves_login_page(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver()
            res = p.login("hdien", "secret")
        self.assertTrue(res["logged_in"])
        self.assertEqual(p.driver.by_id["txtLoginName"].value, "hdien")
        self.assertTrue(p.driver.login_clicked)

    def test_login_failure_stays_on_login(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp, timeout=1)
            d = FakeDriver()
            # btnLogin không có → gửi Enter, vẫn ở login.aspx
            del d.by_id["btnLogin"]
            p.driver = d
            res = p.login("hdien", "sai")
        self.assertFalse(res["logged_in"])

    def test_fill_cert_dry_run_fills_but_does_not_accept(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver(logged_in=True, has_modal=True)
            cert = build_cert_fields({
                "ten_dv": "Cty A", "ma_bhxh": "0123", "ma_the": "DN41234567890",
                "tu_ngay": "01/10/2026", "den_ngay": "03/10/2026", "ngay_ct": "03/10/2026",
            })
            msg = p.fill_cert(cert, dry_run=True)
        self.assertIn("chưa bấm", msg.lower())
        self.assertEqual(p.driver.by_id["txtDonViLamViec"].value, "Cty A")
        self.assertEqual(p.driver.by_id["txtSoNgayNghi"].value, "3")
        self.assertFalse(p.driver.by_id["btnChapNhanGiay"].clicked)

    def test_fill_cert_real_clicks_accept(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver(logged_in=True, has_modal=True)
            msg = p.fill_cert({"so_ngay_nghi": "2"}, dry_run=False)
        self.assertIn("Chấp nhận", msg)
        self.assertTrue(p.driver.by_id["btnChapNhanGiay"].clicked)

    def test_fill_cert_without_modal_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver(logged_in=True, has_modal=False)
            with self.assertRaises(EmrError):
                p.fill_cert({"so_ngay_nghi": "2"}, dry_run=True)


if __name__ == "__main__":
    unittest.main()
