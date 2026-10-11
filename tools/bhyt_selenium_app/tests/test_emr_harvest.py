from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from bhyt.emr import EmrError, EmrPortal
from selenium.webdriver.common.by import By


CLINIC_HTML = """
<table>
  <tr><th>Mã BN</th><th>Họ tên</th><th>Năm sinh</th><th>Giới tính</th>
      <th>Trạng thái</th><th>Nơi thực hiện</th></tr>
  <tr><td>BN001</td><td>NGUYỄN VĂN A</td><td>1990</td><td>Nam</td><td>Hoàn tất</td><td>PK</td></tr>
  <tr><td>BN002</td><td>TRẦN THỊ B</td><td>2015</td><td>Nữ</td><td>Hoàn tất</td><td>PK</td></tr>
</table>
"""


class FakeDriver:
    def __init__(self, html="", logged_in=True):
        base = "http://192.168.2.26:2026"
        self.current_url = f"{base}/home.aspx" if logged_in else f"{base}/login.aspx"
        self._html = html

    def find_elements(self, by, value):
        return []

    @property
    def page_source(self):
        return self._html

    def get_screenshot_as_png(self):
        return b"PNG"


def make_emr(tmp, **sel):
    return EmrPortal("http://192.168.2.26:2026", Path(tmp) / "p",
                     debug_dir=Path(tmp) / "debug", download_dir=Path(tmp) / "dl",
                     selectors=sel or {})


class ListClinicPatientsTests(unittest.TestCase):
    def test_reads_rows_by_header_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver(html=CLINIC_HTML)
            p._click = lambda *a, **k: None  # bỏ qua điều hướng
            out = p.list_clinic_patients()
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0]["ho_ten"], "NGUYỄN VĂN A")
        self.assertEqual(out[0]["nam_sinh"], "1990")
        self.assertEqual(out[1]["gioi_tinh"], "Nữ")

    def test_raises_when_no_table(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver(html="<html>không có bảng khám</html>")
            p._click = lambda *a, **k: None
            with self.assertRaises(EmrError):
                p.list_clinic_patients()


class HarvestSickLeaveTests(unittest.TestCase):
    def test_filters_working_age_and_keeps_those_with_phieu(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            # 3 ca: A (36, có phiếu), trẻ em B (11, bị loại), C (40, không có phiếu)
            p.list_clinic_patients = lambda: [
                {"ho_ten": "A", "nam_sinh": "1990", "gioi_tinh": "Nam", "tuoi": "36", "raw": []},
                {"ho_ten": "B", "nam_sinh": "2015", "gioi_tinh": "Nữ", "tuoi": "11", "raw": []},
                {"ho_ten": "C", "nam_sinh": "1986", "gioi_tinh": "Nam", "tuoi": "40", "raw": []},
            ]

            def fake_read(name):
                if name == "A":
                    return {"doc_type": "BHXH07", "fields": {"so_kcb": "260004779", "ho_ten": "A"}, "pdf_path": "x"}
                raise EmrError("không có phiếu")
            p.read_phieu_pdf = fake_read

            out = p.harvest_sick_leave(ref_year=2026)
        self.assertEqual(out["scanned"], 3)
        self.assertEqual(out["working_age"], 2)   # A và C (B bị loại vì 11 tuổi)
        self.assertEqual(len(out["found"]), 1)    # chỉ A có phiếu
        self.assertEqual(out["found"][0]["ho_ten"], "A")

    def test_limit_caps_candidates(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.list_clinic_patients = lambda: [
                {"ho_ten": n, "nam_sinh": "1990", "gioi_tinh": "Nam", "tuoi": "36", "raw": []}
                for n in ("A", "B", "C")
            ]
            calls = []
            p.read_phieu_pdf = lambda name: (calls.append(name) or (_ for _ in ()).throw(EmrError("x")))
            out = p.harvest_sick_leave(ref_year=2026, limit=2)
        self.assertEqual(out["working_age"], 2)
        self.assertEqual(calls, ["A", "B"])


if __name__ == "__main__":
    unittest.main()
