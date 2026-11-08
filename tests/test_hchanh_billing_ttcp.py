"""Bảng Tổng kết → Chi phí (table#dataTableYeuCau): đường xem bảng kê của ca đã Hoàn tất.
Mẫu dựng theo cấu trúc HTML thật của EMR (17 cột, tiêu đề 2 tầng, dòng nhóm đối tượng/loại/khoa);
số liệu và tên đều giả, không có dữ liệu người bệnh."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "worker"
if str(WORKER) not in sys.path:
    sys.path.insert(0, str(WORKER))

import hchanh_fetch as core  # noqa: E402

HEAD = (
    '<thead><tr><th rowspan="2">STT</th><th rowspan="2">Tên chi phí</th><th rowspan="2">ĐT</th>'
    '<th rowspan="2">MH (%)</th><th rowspan="2">ĐVT</th><th rowspan="2">SL</th><th rowspan="2">Đơn giá BV</th>'
    '<th rowspan="2">Đơn giá BH</th><th rowspan="2">TLTTDV (%)</th><th rowspan="2">Thành tiền BV</th>'
    '<th rowspan="2">TLTT (%)</th><th rowspan="2">Thành tiền BH</th><th colspan="4">Nguồn thanh toán</th>'
    '<th rowspan="2">Phụ thu</th></tr>'
    '<tr><th>Quỹ BHYT</th><th>B/N CCT</th><th>Khác</th><th>B/N tự trả</th></tr></thead>'
)


def group(text, kind):
    if kind == "doi_tuong":
        return f'<tr><td colspan="17" style="color:black; background: #2EB8EC;">{text}</td></tr>'
    if kind == "khoa":
        return (f'<tr><td colspan="17" style="color:#337ab7;"><a data-toggle="collapse" href=".collapseKhoaPhong0">'
                f'<i class="fa fa-minus"></i></a><strong>{text}</strong></td></tr>')
    return f'<tr><td colspan="17" style="color: black;"><b>{text}</b></td></tr>'


def item(name, dt, sl, gia_bv, tt_bv, tt_bh, quy, cct, tu_tra):
    cells = ["1", name, dt, "80", "Lần", sl, gia_bv, gia_bv, "100", tt_bv, "100", tt_bh, quy, cct, "0.00", tu_tra, "0.00"]
    return '<tr class="collapse in collapseKhoaPhong0">' + "".join(f"<td>{c}</td>" for c in cells) + "</tr>"


TTCP_PAGE = (
    '<div id="divNoiTruContent"><div id="divTableYeuCau"><table id="dataTableYeuCau" class="table table-bordered">'
    + HEAD + '<tbody>'
    + group("Đối tượng bảo hiểm y tế", "doi_tuong")
    + group("Xét nghiệm", "loai")
    + group("Khoa Giả Lập A", "khoa")
    + item("Xét nghiệm giả 1", "Bảo hiểm", "2", "50,000.00", "100,000.00", "100,000.00", "80,000.00", "20,000.00", "0.00")
    + group("Ngày giường", "loai")
    + group("Khoa Giả Lập A", "khoa")
    + item("Giường giả", "Bảo hiểm", "3", "300,000.00", "900,000.00", "750,000.00", "600,000.00", "150,000.00", "150,000.00")
    + group("Đối tượng khác BHYT", "doi_tuong")
    + group("Vật tư y tế tiêu hao", "loai")
    + group("Khoa Giả Lập B", "khoa")
    + item("Vật tư giả", "Viện phí", "1", "1,234,567.00", "1,234,567.00", "0.00", "0.00", "0.00", "1,234,567.00")
    + item("Thuốc trong gói giả", "Trong gói", "1", "0.00", "0.00", "0.00", "0.00", "0.00", "0.00")
    + '</tbody></table></div>'
    '<div id="divTongHopChiPhi"><label>Tổng chi phí</label><input value="2,234,567"></div></div>'
)


def _rows():
    soup = core._soup(TTCP_PAGE)
    return core.parse_billing_ttcp_rows(soup.select_one("table#dataTableYeuCau"))


def test_ttcp_rows_read_all_columns_and_groups():
    rows = _rows()
    assert [r["name"] for r in rows] == ["Xét nghiệm giả 1", "Giường giả", "Vật tư giả", "Thuốc trong gói giả"]
    bed = rows[1]
    assert bed["loai_yc"] == "Ngày giường"
    assert bed["khoa"] == "Khoa Giả Lập A"
    assert bed["nhom_doi_tuong"] == "Đối tượng bảo hiểm y tế"
    assert bed["sl"] == 3 and bed["don_gia"] == 300000 and bed["thanh_tien"] == 900000
    assert bed["thanh_tien_bh"] == 750000 and bed["quy_bhyt"] == 600000
    assert bed["bn_cung_chi_tra"] == 150000 and bed["bn_tu_tra"] == 150000
    assert bed["dvt"] == "Lần" and bed["muc_huong"] == "80"
    assert rows[2]["nhom_doi_tuong"] == "Đối tượng khác BHYT"
    assert rows[2]["thanh_tien"] == 1234567
    assert [r["payment_group"] for r in rows] == ["bhyt", "bhyt", "self_pay", "zero"]


def test_ttcp_page_counts_as_billing_page_and_markers():
    assert any(m in TTCP_PAGE for m in core._hchanh_action_markers("billing"))


class FakeSess:
    base_origin = "https://emr.example"

    def __init__(self, html):
        self.html = html
        self.urls = []

    def get_html(self, url):
        self.urls.append(url)
        return self.html, 200


def test_fetch_billing_reads_ttcp_table_not_old_15_column_layout(monkeypatch):
    code = "BN900001"
    link_map = {core._patient_link_key(code, "doctor"): "https://emr.example/home.aspx?wpid=x&tiepnhanid=00000000-0000-0000-0000-000000000001"}
    monkeypatch.setattr(core, "_fetch_hchanh_html_by_click", lambda *a, **k: {"html": TTCP_PAGE})
    sess = FakeSess("<html></html>")
    out = core.fetch_billing(sess, code, link_map, {})
    # Không mở trang chiphichitietdraw (màn Sửa chi phí) bằng HTTP dù có tiepnhanid.
    assert sess.urls == []
    assert out["_fetch_status"] == "ok"
    assert len(out["rows"]) == 4
    assert out["tong_cong"] == 2234567
    assert out["tong_bhyt"] == 1000000
    assert out["tong_tu_tuc"] == 1234567
    assert out["_billing_page_checked"] is True
    assert out["_source"] == "emr_tong_ket_chi_phi"


def test_fetch_billing_reports_error_when_draw_fails(monkeypatch):
    monkeypatch.setattr(core, "_fetch_hchanh_html_by_click", lambda *a, **k: None)
    code = "BN900002"
    link_map = {core._patient_link_key(code, "doctor"): "https://emr.example/home.aspx?wpid=x"}
    out = core.fetch_billing(FakeSess(""), code, link_map, {})
    assert out["_fetch_status"] == "error" and out["_reason"] == "no_billing_view"
    assert out["rows"] == []
