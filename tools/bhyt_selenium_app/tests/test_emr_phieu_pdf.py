from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from bhyt.emr import EmrError, EmrPortal
from selenium.webdriver.common.by import By


class El:
    def __init__(self, attrs=None):
        self._attrs = attrs or {}

    def get_attribute(self, name):
        return self._attrs.get(name)


class FakeDriver:
    def __init__(self, handles=None, current_url="", tags=None, logged_in=True):
        self.handles = handles or ["h0"]
        self._current = "http://192.168.2.26:2026/home.aspx" if logged_in else "http://192.168.2.26:2026/login.aspx"
        self.current_url = current_url or self._current
        self.tags = tags or {}  # tên tag -> list El
        self.switched_to = None

    @property
    def window_handles(self):
        return self.handles

    def find_elements(self, by, value):
        if by == By.TAG_NAME:
            return self.tags.get(value, [])
        return []

    class _Switch:
        def __init__(self, d):
            self.d = d

        def window(self, h):
            self.d.switched_to = h
            self.d.current_url = f"http://192.168.2.26:2026/viewer?tab={h}"

    @property
    def switch_to(self):
        return FakeDriver._Switch(self)

    def get_cookies(self):
        return []

    @property
    def page_source(self):
        return "<html>emr</html>"

    def get_screenshot_as_png(self):
        return b"PNG"


def make_emr(tmp, **kw):
    return EmrPortal("http://192.168.2.26:2026", Path(tmp) / "p",
                     debug_dir=Path(tmp) / "debug", download_dir=Path(tmp) / "dl", **kw)


class ResolveUrlTests(unittest.TestCase):
    def test_absolute_kept(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            self.assertEqual(p._resolve_url("https://x/y.pdf"), "https://x/y.pdf")

    def test_relative_joined_to_base(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            self.assertEqual(p._resolve_url("/Report/Phieu.pdf"),
                             "http://192.168.2.26:2026/Report/Phieu.pdf")
            self.assertEqual(p._resolve_url("Report/Phieu.pdf"),
                             "http://192.168.2.26:2026/Report/Phieu.pdf")

    def test_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(make_emr(tmp)._resolve_url(""), "")


class FindPdfUrlTests(unittest.TestCase):
    def test_new_tab_url_preferred(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver(handles=["h0", "h1"])
            url = p._find_pdf_url_in_page(before_handles={"h0"})
            self.assertIn("tab=h1", url)  # đã chuyển sang tab mới

    def test_embed_src_when_no_new_tab(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver(
                handles=["h0"],
                tags={"embed": [El({"src": "http://192.168.2.26:2026/f/Phieu.pdf"})]},
            )
            self.assertEqual(p._find_pdf_url_in_page({"h0"}),
                             "http://192.168.2.26:2026/f/Phieu.pdf")

    def test_anchor_pdf_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver(
                handles=["h0"],
                tags={"a": [El({"href": "http://x/trang.html"}),
                            El({"href": "http://x/Phieu.PDF"})]},
            )
            self.assertEqual(p._find_pdf_url_in_page({"h0"}), "http://x/Phieu.PDF")

    def test_prefers_pdf_iframe_over_other_iframe(self):
        # EMR: modal có iframe PDF (iframe_main) + có thể còn iframe khác (panel lỗi).
        # Phải chọn iframe trỏ tới .pdf, không bắt nhầm iframe đầu tiên.
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver(
                handles=["h0"],
                tags={"iframe": [
                    El({"src": "http://192.168.2.26:2026/panel/error.html"}),
                    El({"src": "temp/10.2026/hmtu/PDF/KB_GiayHuongBHXHNghiViec_2026.pdf"}),
                ]},
            )
            self.assertEqual(
                p._find_pdf_url_in_page({"h0"}),
                "temp/10.2026/hmtu/PDF/KB_GiayHuongBHXHNghiViec_2026.pdf",
            )

    def test_nothing_found(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver(handles=["h0"])
            self.assertEqual(p._find_pdf_url_in_page({"h0"}), "")


class WaitDownloadTests(unittest.TestCase):
    def test_returns_new_pdf(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp, timeout=2)
            p.download_dir.mkdir(parents=True, exist_ok=True)
            before = set()
            f = p.download_dir / "phieu.pdf"
            f.write_bytes(b"%PDF-1.4 data")
            got = p._wait_for_download(before)
            self.assertEqual(got, f)

    def test_none_when_no_new_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp, timeout=1)
            p.download_dir.mkdir(parents=True, exist_ok=True)
            self.assertIsNone(p._wait_for_download(set()))


class ReadPhieuPdfIntegrationTests(unittest.TestCase):
    def test_downloaded_pdf_is_parsed_and_mapped(self):
        # Kiểm tra mạch nối: tải được file -> gọi parse_phieu_pdf với đúng đường dẫn ->
        # trả field + bù vào kết quả. (Độ chính xác của parse đã test ở test_pdf_phieu.)
        import bhyt.pdf_phieu as pp
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver(logged_in=True)
            p.download_dir.mkdir(parents=True, exist_ok=True)
            pdf_file = p.download_dir / "phieu.pdf"
            pdf_file.write_bytes(b"%PDF-1.4 fake")

            p._go_to_patient_record = lambda name: None
            p._click_phieu_button = lambda: None
            p._acquire_phieu_pdf = lambda before_files, before_handles, name: pdf_file

            seen = {}
            orig = pp.parse_phieu_pdf
            pp.parse_phieu_pdf = lambda path: (seen.update(path=str(path)) or {
                "doc_type": "BHXH07", "mau_so": "07",
                "fields": {"so_kcb": "260004779", "so_cccd": "086300000786"}, "raw": {},
            })
            try:
                out = p.read_phieu_pdf("NGUYEN VAN A")
            finally:
                pp.parse_phieu_pdf = orig

            self.assertEqual(seen["path"], str(pdf_file))
            self.assertEqual(out["doc_type"], "BHXH07")
            self.assertEqual(out["fields"]["so_kcb"], "260004779")
            self.assertEqual(out["fields"]["so_cccd"], "086300000786")
            self.assertEqual(out["pdf_path"], str(pdf_file))

    def test_raises_when_no_pdf(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            p.driver = FakeDriver(logged_in=True)
            p._go_to_patient_record = lambda name: None
            p._click_phieu_button = lambda: None
            p._acquire_phieu_pdf = lambda before_files, before_handles, name: None
            with self.assertRaises(EmrError):
                p.read_phieu_pdf("NGUYEN VAN A")


class ClickPhieuButtonTests(unittest.TestCase):
    def test_clicks_button_by_text_xpath(self):
        # "Xem phiếu" là <button>, không phải link — phải dò bằng XPath button/a theo text.
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp)
            calls = []
            p._click = lambda by, value, what: calls.append((by, value))
            p._click_phieu_button()
        self.assertEqual(len(calls), 1)
        by, value = calls[0]
        self.assertEqual(by, By.XPATH)
        self.assertIn("button", value)
        self.assertIn("Xem phiếu", value)


class AcquirePhieuPdfTests(unittest.TestCase):
    def test_returns_pdf_from_page_download(self):
        # Trường hợp EMR nhúng PDF trong iframe (không tải file): lấy qua _download_pdf_from_page.
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp, timeout=2)
            p.download_dir.mkdir(parents=True, exist_ok=True)
            got_file = p.download_dir / "from_page.pdf"
            got_file.write_bytes(b"%PDF-1.4 x")
            p._download_pdf_from_page = lambda before_handles, name: got_file
            out = p._acquire_phieu_pdf(set(), set(), "A")
        self.assertEqual(out, got_file)

    def test_none_when_neither_download_nor_page(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = make_emr(tmp, timeout=1)
            p.download_dir.mkdir(parents=True, exist_ok=True)
            p._download_pdf_from_page = lambda before_handles, name: None
            self.assertIsNone(p._acquire_phieu_pdf(set(), set(), "A"))


if __name__ == "__main__":
    unittest.main()
