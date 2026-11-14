"""Kho nghiên cứu đọc Sổ biên bản hội chẩn (SBBHC) đã hoàn tất: chỉ đọc (GET), bỏ phiếu chưa hoàn tất."""
import hchanh_fetch as hf
from hchanh_fetch import parse_sbbhc_form, is_sbbhc_row, fetch_consults

# Mẫu giả (không có dữ liệu người bệnh thật), theo id ô mà phần Phòng khám đang điền.
FORM_HTML = (
    '<form><input id="ThoiGianHoiChan" value="09:30 12/11/2026">'
    '<input id="HopTai" value="Khoa Chấn thương chỉnh hình">'
    '<textarea id="YeuCau">Hội chẩn chỉ định phẫu thuật</textarea>'
    '<textarea id="ChanDoanTuyenDuoi">Gãy cổ xương đùi (P)</textarea>'
    '<textarea id="HuongDieuTri">Thay khớp háng bán phần</textarea>'
    '<textarea id="KetLuan">Đồng ý phẫu thuật</textarea>'
    '<select id="ThuKy"><option value="1">A</option><option value="2" selected>Điều dưỡng B</option></select>'
    '</form>'
)


def test_parse_form_by_field_id():
    f = parse_sbbhc_form(FORM_HTML)
    assert f["ThoiGianHoiChan"] == "09:30 12/11/2026"
    assert f["YeuCau"] == "Hội chẩn chỉ định phẫu thuật"
    assert f["KetLuan"] == "Đồng ý phẫu thuật"
    assert f["ThuKy"] == "Điều dưỡng B"
    assert "TomTat" not in f


def test_parse_form_from_embedded_js_object():
    html = '<script>var _obj = {"TRANGTHAI":1,"YeuCau":"Xin \\"ý kiến\\"","KetLuan":"Mổ"};</script><textarea id="KetLuan"></textarea>'
    f = parse_sbbhc_form(html)
    assert f["YeuCau"] == 'Xin "ý kiến"'
    assert f["KetLuan"] == "Mổ"


def test_is_sbbhc_row():
    assert is_sbbhc_row({"loai_phieu": "SBBHC"})
    assert is_sbbhc_row({"loai_phieu": "Sổ biên bản hội chẩn"})
    assert is_sbbhc_row({"loai_phieu": "Phiếu khác", "mo_ta": "Biên bản hội chẩn phẫu thuật"})
    assert not is_sbbhc_row({"loai_phieu": "Phiếu chăm sóc"})


class FakeSess:
    base_origin = "https://emr.example"

    def __init__(self, pages):
        self.pages = pages
        self.calls = []

    def get_html(self, url):
        self.calls.append(("GET", url))
        return self.pages.get(url, ""), url

    def post_html(self, *a, **k):  # pragma: no cover - không được gọi
        raise AssertionError("Đọc SBBHC không được POST lên EMR")


def _docs(rows):
    return lambda sess, ma_bn, link_map, config: {"_fetch_status": "ok", "rows": rows}


def test_fetch_consults_reads_only_finished_sbbhc(monkeypatch):
    rows = [
        {"loai_phieu": "SBBHC", "hoan_tat": True, "hosoid": "h1", "form_url": "u1", "khoa": "CTCH", "ngay_tao": "12/11/2026"},
        {"loai_phieu": "SBBHC", "hoan_tat": False, "hosoid": "h2", "form_url": "u2"},
        {"loai_phieu": "Phiếu chăm sóc", "hoan_tat": True, "hosoid": "h3", "form_url": "u3"},
    ]
    monkeypatch.setattr(hf, "fetch_documents", _docs(rows))
    sess = FakeSess({"u1": FORM_HTML})
    out = fetch_consults(sess, "BN1", {}, {})
    assert out["_fetch_status"] == "ok"
    assert sess.calls == [("GET", "u1")]
    assert out["skipped_unfinished"] == 1
    assert len(out["rows"]) == 1
    r = out["rows"][0]
    assert r["hosoid"] == "h1" and r["khoa"] == "CTCH" and r["KetLuan"] == "Đồng ý phẫu thuật"


def test_fetch_consults_empty_and_unreadable(monkeypatch, tmp_path):
    monkeypatch.setattr(hf, "fetch_documents", _docs([{"loai_phieu": "Phiếu khác", "hoan_tat": True}]))
    assert fetch_consults(FakeSess({}), "BN1", {}, {})["_fetch_status"] == "ok"
    monkeypatch.setattr(hf, "fetch_documents", _docs([{"loai_phieu": "SBBHC", "hoan_tat": True, "hosoid": "h1", "form_url": "u1"}]))
    out = fetch_consults(FakeSess({"u1": "<html>đăng nhập</html>"}), "BN1", {}, {"runtime_dir": str(tmp_path)})
    assert out["_fetch_status"] == "error"
    assert out["rows"] == []


def test_fetch_consults_passes_documents_error(monkeypatch):
    monkeypatch.setattr(hf, "fetch_documents", lambda *a: {"_fetch_status": "no_url"})
    assert fetch_consults(FakeSess({}), "BN1", {}, {})["_fetch_status"] == "no_url"
