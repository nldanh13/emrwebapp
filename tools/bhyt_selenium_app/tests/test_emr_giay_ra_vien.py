from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from selenium.webdriver.common.by import By

from bhyt.emr import EmrError, EmrPortal
from test_pdf_giay_ra_vien import SAMPLE


INPATIENT_HTML = """
<table id="tblNoiTru">
  <tr><th>Mã BN</th><th>Họ tên</th><th>Năm sinh</th><th>Giới tính</th>
      <th>Ngày vào viện</th><th>Ngày ra viện</th><th>Trạng thái</th></tr>
  <tr><td>BN01</td><td>NGUYỄN VĂN AN</td><td>1988</td><td>Nam</td>
      <td>01/10/2026</td><td>05/10/2026</td><td>Hoàn tất</td></tr>
  <tr><td>BN02</td><td>LÊ THỊ CÚC</td><td>1950</td><td>Nữ</td>
      <td>02/10/2026</td><td>06/10/2026</td><td>Hoàn tất</td></tr>
</table>
"""


class FakeDriver:
    def __init__(self, url="http://192.168.2.26:2026/home.aspx?scope=a&usid=U1&st=S1&wpid=bacsidraw&noitruid=9",
                 html=""):
        self.current_url = url
        self._html = html
        self.opened = []
        self.scripts = []

    @property
    def window_handles(self):
        return ["h0"]

    def get(self, url):
        self.opened.append(url)

    def find_elements(self, by, value):
        return []

    def execute_script(self, script, *args):
        self.scripts.append((script, args))
        return True

    @property
    def page_source(self):
        return self._html

    def get_screenshot_as_png(self):
        return b"PNG"


def make_emr(tmp, **kw):
    return EmrPortal("http://192.168.2.26:2026", Path(tmp) / "p",
                     debug_dir=Path(tmp) / "debug", download_dir=Path(tmp) / "dl", **kw)


class InpatientListUrlTests(unittest.TestCase):
    def test_keeps_session_drops_patient_params(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver()
            url = p._inpatient_list_url()
        self.assertIn("usid=U1", url)
        self.assertIn("st=S1", url)
        self.assertIn("wpid=danhsachdieutrinoitrudraw", url)
        self.assertNotIn("noitruid", url)

    def test_without_session_asks_to_login(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver(url="http://192.168.2.26:2026/home.aspx")
            with self.assertRaises(EmrError):
                p._inpatient_list_url()


class ReadGiayRaVienTests(unittest.TestCase):
    def test_pdf_parsed_into_form_03_fields(self):
        # Mạch đầy đủ: mở hồ sơ nội trú → in giấy ra viện → lấy PDF → đọc ra field mẫu 03.
        import bhyt.pdf_giay_ra_vien as grv
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver()
            pdf_file = Path(tmp) / "grv.pdf"
            pdf_file.write_bytes(b"%PDF-1.4 fake")
            steps = []
            p._go_to_inpatient_record = lambda name: steps.append(("open", name))
            p._click_grv_report = lambda: steps.append(("print",))
            p._acquire_phieu_pdf = lambda before_files, before_handles, name: pdf_file

            orig = grv.extract_pdf_text
            grv.extract_pdf_text = lambda path, **kw: SAMPLE
            try:
                out = p.read_giay_ra_vien_pdf("Nguyễn Văn An")
            finally:
                grv.extract_pdf_text = orig

        self.assertEqual(steps, [("open", "Nguyễn Văn An"), ("print",)])
        self.assertEqual(out["doc_type"], "GRV03")
        self.assertEqual(out["fields"]["ma_khoa"], "Nội tổng hợp")
        self.assertEqual(out["fields"]["doctor_text"], "Phạm Việt Tân")

    def test_no_pdf_saves_page_and_explains(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver()
            p._go_to_inpatient_record = lambda name: None
            p._click_grv_report = lambda: None
            p._acquire_phieu_pdf = lambda before_files, before_handles, name: None
            with self.assertRaises(EmrError) as ctx:
                p.read_giay_ra_vien_pdf("A")
            self.assertIn("Giấy ra viện", str(ctx.exception))
            self.assertTrue((Path(tmp) / "debug" / "emr-giay-ra-vien.html").exists())

    def test_known_report_id_calls_onreportpdf(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp, selectors={"grv_report_id": "ABC-123"})
            p.driver = FakeDriver()
            p._click = lambda *a, **k: self.fail("không cần bấm link khi đã biết mã phiếu")
            p._click_grv_report()
        script, args = p.driver.scripts[-1]
        self.assertIn("OnReportPdf", script)
        self.assertEqual(args, ("ABC-123",))

    def test_report_link_by_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver()
            clicked = []
            p._click = lambda by, value, what: clicked.append((by, value))
            p._click_grv_report()
        self.assertEqual(clicked[0][0], By.XPATH)
        self.assertIn("OnReportPdf", clicked[0][1])
        self.assertIn("Giấy ra viện", clicked[0][1])


class NotLoggedInTests(unittest.TestCase):
    def test_no_browser_says_login_first(self):
        # Chưa mở trình duyệt EMR: báo đăng nhập, không lộ lỗi Python trần.
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            for call in (lambda: p.read_giay_ra_vien_pdf("A"), p.list_inpatient_discharges):
                with self.assertRaises(EmrError) as ctx:
                    call()
                self.assertIn("đăng nhập", str(ctx.exception))


class HarvestDischargesTests(unittest.TestCase):
    def test_lists_discharged_by_header(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver(html=INPATIENT_HTML)
            p._open_inpatient_list = lambda *a, **k: None
            out = p.list_inpatient_discharges(day="05/10/2026")
        self.assertEqual([x["ho_ten"] for x in out], ["NGUYỄN VĂN AN"])  # chỉ ca ra viện ngày 05/10
        self.assertEqual(out[0]["ngay_ra"], "05/10/2026")
        self.assertEqual(out[0]["trang_thai"], "Hoàn tất")

    def test_empty_list_saves_page(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver(html="<html>trống</html>")
            p._open_inpatient_list = lambda *a, **k: None
            with self.assertRaises(EmrError):
                p.list_inpatient_discharges()

    def test_working_age_only_and_reads_giay_ra_vien(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver(html=INPATIENT_HTML.replace("06/10/2026", "05/10/2026"))
            p._open_inpatient_list = lambda *a, **k: None
            calls = []

            def fake_read(name):
                calls.append(name)
                return {"doc_type": "GRV03", "fields": {"ho_ten": name}, "pdf_path": "x"}
            p.read_giay_ra_vien_pdf = fake_read
            p.read_patient_info = lambda keyword: {"fields": {"so_cccd": "086300000786"}}
            p.read_phieu_pdf = lambda name: self.fail("nội trú không đọc phiếu phòng khám")
            out = p.harvest_discharges(ref_year=2026, day="2026-10-05")
        self.assertEqual(out["scanned"], 2)
        self.assertEqual(out["working_age"], 1)  # bà Cúc 76 tuổi bị loại
        self.assertEqual(calls, ["NGUYỄN VĂN AN"])
        self.assertEqual(out["found"][0]["doc_type"], "GRV03")
        self.assertEqual(out["found"][0]["fields"]["so_cccd"], "086300000786")  # bù từ thông tin BN


class DischargeDayTests(unittest.TestCase):
    def test_default_day_is_today(self):
        from datetime import date
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver(html=INPATIENT_HTML)
            seen = {}
            p._open_inpatient_list = lambda keyword="", date_from="", date_to="": seen.update(
                date_from=date_from, date_to=date_to)
            try:
                p.list_inpatient_discharges()
            except EmrError:
                pass  # bảng mẫu không có ca nào ra viện hôm nay
        self.assertEqual(seen["date_to"], date.today().strftime("%d/%m/%Y"))

    def test_other_day_filters_rows_and_opens_emr_range(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver(html=INPATIENT_HTML)
            seen = {}
            p._open_inpatient_list = lambda keyword="", date_from="", date_to="": seen.update(
                date_from=date_from, date_to=date_to)
            out = p.list_inpatient_discharges(day="2026-10-06")
        self.assertEqual([x["ho_ten"] for x in out], ["LÊ THỊ CÚC"])
        self.assertEqual(seen["date_to"], "06/10/2026")
        # Mở EMR lùi xa hơn để không sót ca vào viện từ trước, rồi lọc theo ngày ra.
        self.assertEqual(seen["date_from"], "07/08/2026")

    def test_no_case_that_day_is_not_an_error(self):
        # Ngày không có ai ra viện: trả rỗng (để giao diện báo "không có ca"), không phải lỗi.
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver(html=INPATIENT_HTML)
            p._open_inpatient_list = lambda *a, **k: None
            self.assertEqual(p.list_inpatient_discharges(day="01/01/2026"), [])

    def test_bad_day_explains(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver(html=INPATIENT_HTML)
            with self.assertRaises(EmrError) as ctx:
                p.list_inpatient_discharges(day="hôm qua")
            self.assertIn("ngày", str(ctx.exception))

    def test_patient_opened_with_same_range(self):
        # Mở hồ sơ từng ca phải dùng cùng trạng thái/khoảng ngày vừa quét, kẻo EMR không hiện ca đã ra viện.
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver(html=INPATIENT_HTML)
            calls = []
            p._open_inpatient_list = lambda keyword="", date_from="", date_to="": calls.append(
                (keyword, date_from, date_to))
            p._click = lambda *a, **k: None
            p._dismiss_error_panel_best_effort = lambda: None
            p.list_inpatient_discharges(day="05/10/2026")
            p._go_to_inpatient_record("Nguyễn Văn An")
        self.assertEqual(calls[1], ("Nguyễn Văn An", calls[0][1], "05/10/2026"))


if __name__ == "__main__":
    unittest.main()
