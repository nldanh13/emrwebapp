from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from bhyt.emr import EmrError, EmrPortal
from selenium.webdriver.common.by import By


class Cell:
    def __init__(self, text):
        self.text = text


class Row:
    def __init__(self, cells):
        self._cells = [Cell(c) for c in cells]

    def find_elements(self, by, value):
        if value == "td":
            return self._cells
        return []


class FakeDriver:
    def __init__(self, rows, logged_in=True):
        base = "http://192.168.2.26:2026"
        self.current_url = f"{base}/home.aspx" if logged_in else f"{base}/login.aspx"
        self._rows = [Row(r) for r in rows]

    def find_elements(self, by, value):
        if by == By.CSS_SELECTOR and "tr" in value:
            return self._rows
        return []

    @property
    def page_source(self):
        return "<html>ds</html>"

    def get_screenshot_as_png(self):
        return b"PNG"


def make_emr(tmp, **sel):
    selectors = {"clinic_col_name": "0", "clinic_col_birth": "1", "clinic_col_gender": "2", "clinic_col_age": "3"}
    selectors.update(sel)
    return EmrPortal("http://192.168.2.26:2026", Path(tmp) / "p",
                     debug_dir=Path(tmp) / "debug", download_dir=Path(tmp) / "dl",
                     selectors=selectors)


class ListClinicPatientsTests(unittest.TestCase):
    def test_reads_rows_by_configured_columns(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver(rows=[
                ["NGUYỄN VĂN A", "1990", "Nam", "36"],
                ["TRẦN THỊ B", "2015", "Nữ", "11"],
            ])
            p._click = lambda *a, **k: None  # bỏ qua điều hướng
            out = p.list_clinic_patients()
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0]["ho_ten"], "NGUYỄN VĂN A")
        self.assertEqual(out[0]["nam_sinh"], "1990")
        self.assertEqual(out[1]["gioi_tinh"], "Nữ")

    def test_raises_when_name_col_unset(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp, clinic_col_name="")
            p.driver = FakeDriver(rows=[["A", "1990"]])
            p._click = lambda *a, **k: None
            with self.assertRaises(EmrError):
                p.list_clinic_patients()

    def test_raises_when_no_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver(rows=[])
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
