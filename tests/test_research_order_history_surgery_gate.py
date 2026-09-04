from pathlib import Path

import importlib.util

ROOT = Path(__file__).resolve().parents[1]
MOD_PATH = ROOT / "worker" / "hchanh_fetch.py"
spec = importlib.util.spec_from_file_location("hchanh_fetch", MOD_PATH)
hchanh_fetch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hchanh_fetch)


def test_order_history_surgery_markers_detect_pt_rows_from_full_history_html():
    html = """
    <select id="soLuongHienThi"><option value="1000">Tất cả</option></select>
    <tbody id="tbodyylenh">
      <tr><td colspan="11"><a>10/06/2026</a></td></tr>
      <tr id="trpt">
        <td>1</td><td>Xem</td><td>1164840</td><td>07:00 10/06/2026</td>
        <td><a>Nguyễn Tư Thái Bảo<br><i>(PT: PHÒNG PHẪU THUẬT)</i></a></td>
        <td><a data-content="Chuyển mổ">Chuyển mổ</a></td>
        <td><a onclick="onShowLichSuChung('PT');">PT: 1/1</a></td>
        <td></td><td></td><td></td><td></td><td></td>
      </tr>
      <tr id="trnormal">
        <td>2</td><td>Xem</td><td>1163961</td><td>08:58 09/06/2026</td>
        <td>BS</td><td><a data-content="Ngoại CTCH nhận">Ngoại CTCH nhận</a></td>
        <td><a>XN: 9/9</a></td><td></td><td></td><td></td><td></td><td></td>
      </tr>
    </tbody>
    """
    markers = hchanh_fetch._parse_order_history_surgery_markers_from_html(html)
    assert len(markers) == 1
    assert markers[0]["so_phieu"] == "1164840"
    assert markers[0]["tg_ylenh"] == "07:00 10/06/2026"


def test_order_history_surgery_markers_empty_when_no_pt():
    html = """
    <tbody id="tbodyylenh">
      <tr><td colspan="11"><a>10/06/2026</a></td></tr>
      <tr><td>1</td><td>Xem</td><td>1163961</td><td>08:58 09/06/2026</td>
      <td>BS</td><td><a data-content="Dự trù thuốc">Dự trù thuốc</a></td>
      <td><a>XN: 9/9</a></td><td></td><td></td><td></td><td></td><td></td></tr>
    </tbody>
    """
    assert hchanh_fetch._parse_order_history_surgery_markers_from_html(html) == []


def test_order_history_show_all_url_adds_limit_params():
    url = "https://emr.local/home.aspx?wpid=bacsidraw&nextlink=lichsuylenh&page=1"
    out = hchanh_fetch._order_history_show_all_url(url)
    assert "soLuongHienThi=1000" in out
    assert "pageSize=1000" in out


def test_surgery_gate_reuses_prefetched_order_history_rows_without_html_refetch():
    order_history = {
        "rows": [
            {
                "ngay": "10/06/2026",
                "so_phieu": "1164840",
                "tg_ylenh": "07:00 10/06/2026",
                "bac_si": "BS A",
                "dien_bien": "Chuyển mổ",
                "kq_text": "PT: 1/1",
                "has_surgery_marker": True,
                "row_text": "PT: 1/1 Chuyển mổ",
            },
            {
                "ngay": "10/06/2026",
                "so_phieu": "1163961",
                "tg_ylenh": "08:58 09/06/2026",
                "bac_si": "BS B",
                "dien_bien": "Dự trù thuốc",
                "kq_text": "XN: 9/9",
                "has_surgery_marker": False,
            },
        ],
        "ward_admissions": [{"ten_khoa": "Khoa CTCH", "ngay_vao": "08:57 09/06/2026"}],
    }
    gate = hchanh_fetch._surgery_gate_from_order_history(order_history, "01/06/2026", "10/06/2026")
    assert gate["_source"] == "output.order_history.rows"
    assert gate["total_rows"] == 2
    assert len(gate["markers"]) == 1
    assert gate["markers"][0]["so_phieu"] == "1164840"
    assert gate["ward_admissions"][0]["ten_khoa"] == "Khoa CTCH"


def test_surgery_marker_search_range_uses_day_buffer():
    ranges = hchanh_fetch._surgery_marker_search_ranges(["03/02/2026"], window_days=1)
    assert ranges == [("02/02/2026", "04/02/2026")]


def test_surgery_marker_search_range_merges_close_dates():
    ranges = hchanh_fetch._surgery_marker_search_ranges(["03/02/2026", "04/02/2026"], window_days=1)
    assert ranges == [("02/02/2026", "05/02/2026")]
