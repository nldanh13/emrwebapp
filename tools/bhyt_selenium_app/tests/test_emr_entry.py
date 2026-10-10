from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from bhyt.emr import EmrError, EmrPortal, EMR_TO_RECORD
from selenium.webdriver.common.by import By


class El:
    def __init__(self, value=""):
        self.value = value
        self.clicked = False

    def clear(self):
        self.value = ""

    def send_keys(self, v):
        self.value += str(v)

    def click(self):
        self.clicked = True

    def get_attribute(self, name):
        return self.value if name == "value" else None


class SwitchTo:
    def __init__(self, driver):
        self.driver = driver

    def frame(self, _f):
        self.driver.frame = "child"

    def default_content(self):
        self.driver.frame = "top"


class FakeDriver:
    """Giả lập EMR: đăng nhập xong rời login.aspx; có sẵn modal + 7 ô form giấy nghỉ có giá trị."""

    def __init__(self, base="http://192.168.2.26:2026", logged_in=False, has_modal=False, values=None):
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
            v = values or {}
            self.by_id["divModalContentX"] = El()
            for fid in ("txtSoNgayNghi", "txtDonViLamViec", "txtMaSoBHXH", "txtSoTheBHYT",
                        "txtNgayCapGiay", "txtNghiTuNgay", "txtNghiDenNgay"):
                self.by_id[fid] = El(v.get(fid, ""))

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
        if args and isinstance(args[0], El):
            el = args[0]
            if "click" in script:
                el.clicked = True
                if el is self.by_id.get("btnLogin"):
                    self.login_clicked = True
                    self.current_url = f"{self.base}/home.aspx"
            elif "return arguments[0].value" in script:
                return el.value
        return None

    def get_screenshot_as_png(self):
        return b"PNG"

    @property
    def page_source(self):
        return "<html>emr</html>"


def make_emr(tmp, **kw):
    return EmrPortal("http://192.168.2.26:2026", Path(tmp) / "p", **kw)


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
            del d.by_id["btnLogin"]  # không có nút → Enter, vẫn ở login.aspx
            p.driver = d
            res = p.login("hdien", "sai")
        self.assertFalse(res["logged_in"])

    def test_read_cert_maps_emr_fields_to_record_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver(logged_in=True, has_modal=True, values={
                "txtSoNgayNghi": "3",
                "txtDonViLamViec": "Cty A",
                "txtMaSoBHXH": "0123456789",
                "txtSoTheBHYT": "DN4790112345",
                "txtNgayCapGiay": "05/10/2026",
                "txtNghiTuNgay": "01/10/2026",
                "txtNghiDenNgay": "03/10/2026",
            })
            out = p.read_cert()
        f = out["fields"]
        self.assertEqual(f["ten_dv"], "Cty A")
        self.assertEqual(f["ma_bhxh"], "0123456789")
        self.assertEqual(f["ma_the"], "DN4790112345")
        self.assertEqual(f["ngay_ct"], "05/10/2026")
        self.assertEqual(f["tu_ngay"], "01/10/2026")
        self.assertEqual(f["den_ngay"], "03/10/2026")
        self.assertEqual(f["so_ngay_nghi"], "3")
        # raw giữ theo khóa ô EMR để đối chiếu
        self.assertEqual(out["raw"]["don_vi_lam_viec"], "Cty A")

    def test_read_cert_skips_empty_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver(logged_in=True, has_modal=True, values={
                "txtMaSoBHXH": "0123456789",  # chỉ ô này có giá trị
            })
            out = p.read_cert()
        self.assertEqual(out["fields"], {"ma_bhxh": "0123456789"})
        self.assertNotIn("ten_dv", out["fields"])

    def test_read_cert_without_modal_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver(logged_in=True, has_modal=False)
            with self.assertRaises(EmrError):
                p.read_cert()

    def test_emr_to_record_is_read_only_mapping(self):
        # Không có ô nào ánh xạ tới số seri / số KCB (các field đó lấy từ file BHXH).
        self.assertNotIn("so_seri", EMR_TO_RECORD.values())
        self.assertNotIn("so_kcb", EMR_TO_RECORD.values())
        self.assertIn("ma_the", EMR_TO_RECORD.values())


if __name__ == "__main__":
    unittest.main()
