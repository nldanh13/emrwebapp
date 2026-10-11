from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from selenium.webdriver.common.by import By

from bhyt.emr import EmrError, EmrPortal


class FakeDriver:
    """Trang "Thông tin bệnh nhân, chi phí": trả giá trị theo id ô."""

    def __init__(self, values=None):
        self.current_url = "http://192.168.2.26:2026/home.aspx?usid=U1"
        self.values = values or {}

    def find_elements(self, by, value):
        return [object()] if by == By.ID and value in self.values else []

    def execute_script(self, script, *args):
        return {k: self.values.get(v, "") for k, v in args[0].items()}

    @property
    def page_source(self):
        return "<html></html>"

    def get_screenshot_as_png(self):
        return b"PNG"


def make_emr(tmp, **kw):
    return EmrPortal("http://192.168.2.26:2026", Path(tmp) / "p",
                     debug_dir=Path(tmp) / "debug", download_dir=Path(tmp) / "dl", **kw)


VALUES = {
    "cbbDanToc": "Kinh", "cbbLoaiGiayTo": "Căn cước công dân", "txtSoCMND": "086300000786",
    "txtNgayCap": "03/12/2025", "cbbGioiTinh": "Nam",
}


class ReadPatientInfoTests(unittest.TestCase):
    def test_follows_recorded_flow_and_maps_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver(VALUES)
            clicks = []
            p._click = lambda by, value, what: clicks.append(value)
            p._type_search = lambda keyword: clicks.append(("search", keyword))
            out = p.read_patient_info("26096263")
        # Đúng thứ tự bản ghi: Quản lý Bệnh nhân → Chuyển đối tượng... → D/s Bệnh nhân → tìm
        # → nút trên dòng → Thông tin bệnh nhân, chi phí.
        self.assertEqual(clicks[:4], ["Quản lý Bệnh nhân", "Chuyển đối tượng bệnh nhân sang bảo hiểm",
                                      "D/s Bệnh nhân", ("search", "26096263")])
        self.assertIn("26096263", clicks[4])
        self.assertEqual(clicks[-1], "Thông tin bệnh nhân, chi phí")
        self.assertEqual(out["fields"], {
            "dan_toc": "Kinh", "loai_giay_to": "Căn cước công dân", "so_cccd": "086300000786",
            "ngaycap_cccd": "03/12/2025", "gioi_tinh": "Nam",
        })

    def test_placeholder_options_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver({**VALUES, "cbbDanToc": "-- Chọn --", "txtSoCMND": ""})
            p._click = lambda *a, **k: None
            p._type_search = lambda keyword: None
            out = p.read_patient_info("26096263")
        self.assertNotIn("dan_toc", out["fields"])
        self.assertNotIn("so_cccd", out["fields"])

    def test_requires_login(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(EmrError):
                make_emr(tmp).read_patient_info("26096263")


class ReadDischargeRecordTests(unittest.TestCase):
    def test_info_fills_what_discharge_paper_lacks(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.read_giay_ra_vien_pdf = lambda name: {
                "doc_type": "GRV03", "pdf_path": "x",
                "fields": {"ho_ten": name, "gioi_tinh": "Nữ", "loai_giay_to": "Không có giấy tờ"},
            }
            seen = []
            p.read_patient_info = lambda keyword: seen.append(keyword) or {"fields": {
                "gioi_tinh": "Nam", "dan_toc": "Kinh", "so_cccd": "086300000786",
                "ngaycap_cccd": "03/12/2025", "loai_giay_to": "Căn cước công dân"}}
            out = p.read_discharge_record("NGUYỄN VĂN AN", ma_bn="26096263")
        self.assertEqual(seen, ["26096263"])                  # tìm theo mã BN khi có
        f = out["fields"]
        self.assertEqual(f["gioi_tinh"], "Nữ")               # giấy ra viện giữ nguyên
        self.assertEqual(f["dan_toc"], "Kinh")               # thông tin BN bù chỗ thiếu
        self.assertEqual(f["so_cccd"], "086300000786")
        self.assertEqual(f["loai_giay_to"], "Căn cước công dân")  # có CCCD thì dùng loại giấy tờ EMR

    def test_info_failure_keeps_discharge_paper(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.read_giay_ra_vien_pdf = lambda name: {"doc_type": "GRV03", "fields": {"ho_ten": name}}

            def boom(keyword):
                raise EmrError("không mở được")
            p.read_patient_info = boom
            out = p.read_discharge_record("A")
        self.assertEqual(out["fields"], {"ho_ten": "A"})
        self.assertIn("không mở được", out["info_error"])

    def test_khoa_and_doctor_from_list_row(self):
        # Giấy ra viện thật không in khoa và tên bác sĩ: lấy từ cột của danh sách nội trú.
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.read_giay_ra_vien_pdf = lambda name: {"doc_type": "GRV03", "fields": {"ho_ten": name}}
            p.read_patient_info = lambda keyword: {"fields": {}}
            out = p.read_discharge_record("A", "BN01", {"khoa": "Chấn thương chỉnh hình",
                                                         "bac_si": "Phạm Việt Tân"})
        self.assertEqual(out["fields"]["ma_khoa"], "Chấn thương chỉnh hình")
        self.assertEqual(out["fields"]["doctor_text"], "Phạm Việt Tân")


    def test_default_khoa_and_doctor(self):
        # Mặc định khoa K24, bác sĩ Nguyễn Lê Hoan; người dùng đổi được khi quét.
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp, grv_defaults={
                "ma_khoa": "Ngoại Chấn thương chỉnh hình - Thần kinh (K24)",
                "doctor_text": "Nguyễn Lê Hoan"})
            p.read_giay_ra_vien_pdf = lambda name: {"doc_type": "GRV03", "fields": {"ho_ten": name}}
            p.read_patient_info = lambda keyword: {"fields": {}}
            row = {"khoa": "Khoa khác", "bac_si": "Phạm Việt Tân"}
            out = p.read_discharge_record("A", "BN01", row)
            self.assertEqual(out["fields"]["ma_khoa"], "Ngoại Chấn thương chỉnh hình - Thần kinh (K24)")
            self.assertEqual(out["fields"]["doctor_text"], "Nguyễn Lê Hoan")
            changed = p.read_discharge_record("A", "BN01", row, defaults={"doctor_text": "Phạm Việt Tân"})
        self.assertEqual(changed["fields"]["doctor_text"], "Phạm Việt Tân")
        self.assertEqual(changed["fields"]["ma_khoa"], "Ngoại Chấn thương chỉnh hình - Thần kinh (K24)")

if __name__ == "__main__":
    unittest.main()
