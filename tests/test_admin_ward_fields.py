# -*- coding: utf-8 -*-
from main_worker import _attach_ward_admission_history, _canonical_patient_row_for_runtime, _extract_patient_admin_info_from_html, _normalize_admin_fields
from processing.output_schema import make_patient_day_record
from emr_parsers import extract_ward_admissions_from_html


def test_canonical_runtime_keeps_ward_admission_and_department_fields():
    row = {
        "Mã BN": "BN001",
        "Họ tên": "NGUYEN VAN A",
        "Ngày giờ vào khoa": "09:15 13/05/2026",
        "Tên khoa điều trị": "Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh",
    }

    out = _canonical_patient_row_for_runtime(row)

    assert out["tg_vao"] == "09:15 13/05/2026"
    assert out["thoi_gian_vao_khoa"] == "09:15 13/05/2026"
    assert out["khoa_chuyen_den"] == "Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh"
    assert out["khoa_dieu_tri"] == "Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh"
    assert out["ten_khoa_dieu_tri"] == "Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh"


def test_normalize_admin_fields_reads_aliases_without_losing_legacy_keys():
    row = {
        "Thời gian vào khoa": "07:30 13/05/2026",
        "Khoa điều trị": "CTCH-TK",
    }

    out = _normalize_admin_fields(row.copy())

    assert out["tg_vao"] == "07:30 13/05/2026"
    assert out["thoi_gian_vao_khoa"] == "07:30 13/05/2026"
    assert out["khoa_chuyen_den"] == "CTCH-TK"
    assert out["khoa_dieu_tri"] == "CTCH-TK"
    assert out["ten_khoa_dieu_tri"] == "CTCH-TK"


def test_extract_admin_fields_from_html_inputs_and_selects():
    html = """
    <div id="wrap-xutri">
      <label for="txtThoiGianVaoKhoa">Thời gian vào khoa</label>
      <input id="txtThoiGianVaoKhoa" value="10:20 13/05/2026" />
      <label for="cboKhoaDieuTri">Tên khoa điều trị</label>
      <select id="cboKhoaDieuTri">
        <option>Khác</option>
        <option selected>Khoa Ngoại CTCH-TK</option>
      </select>
    </div>
    """

    info = _extract_patient_admin_info_from_html(html)

    assert info["tg_vao"] == "10:20 13/05/2026"
    assert info["thoi_gian_vao_khoa"] == "10:20 13/05/2026"
    assert info["khoa_chuyen_den"] == "Khoa Ngoại CTCH-TK"
    assert info["khoa_dieu_tri"] == "Khoa Ngoại CTCH-TK"
    assert info["ten_khoa_dieu_tri"] == "Khoa Ngoại CTCH-TK"


def test_extract_admin_fields_does_not_guess_first_select_option_without_selected():
    html = """
    <div>
      <label for="cboKhoaDieuTri">Tên khoa điều trị</label>
      <select id="cboKhoaDieuTri">
        <option>Khác</option>
        <option>Khoa Ngoại CTCH-TK</option>
      </select>
    </div>
    """

    info = _extract_patient_admin_info_from_html(html)

    assert "khoa_chuyen_den" not in info
    assert "khoa_dieu_tri" not in info
    assert "ten_khoa_dieu_tri" not in info


def test_output_schema_propagates_new_ward_fields():
    record = make_patient_day_record(
        {
            "ma_bn": "BN002",
            "ho_ten": "LE THI B",
            "thoi_gian_vao_khoa": "14:00 12/05/2026",
            "ten_khoa_dieu_tri": "Khoa Điều trị mẫu",
        },
        ngay_lam="13/05/2026",
        raw_dien_bien="",
        raw_y_lenh="",
        doc_name="",
        doc_content="",
        order_header_time="",
        clean_text_for_entry=lambda x: x,
    )

    assert record["tg_vao"] == "14:00 12/05/2026"
    assert record["thoi_gian_vao_khoa"] == "14:00 12/05/2026"
    assert record["khoa_chuyen_den"] == "Khoa Điều trị mẫu"
    assert record["khoa_dieu_tri"] == "Khoa Điều trị mẫu"
    assert record["ten_khoa_dieu_tri"] == "Khoa Điều trị mẫu"



def test_extract_ward_admissions_from_ylenh_html_headers():
    html = """
    <div class="ibox-title">
      <h5 onclick="showAllTrangThaiYLenh('ward-3');">Khoa điều trị thứ 3: Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh (Ngày vào: 21:33 08/05/2026 - Chẩn đoán: Bệnh đái tháo đường không phụ thuộc insuline (Có biến chứng xác định khác))</h5>
    </div>
    <div class="ibox-title">
      <h5 onclick="showAllTrangThaiYLenh('ward-2');">Khoa điều trị thứ 2: Khoa Gây Mê Hồi Sức (Ngày vào: 19:04 08/05/2026 - Chẩn đoán: Sau phẫu thuật)</h5>
    </div>
    """

    history = extract_ward_admissions_from_html(html)

    assert len(history) == 2
    assert history[0]["thu_tu"] == 2
    assert history[0]["thoi_gian_vao_khoa"] == "19:04 08/05/2026"
    assert history[0]["ten_khoa_dieu_tri"] == "Khoa Gây Mê Hồi Sức"
    assert history[0]["khoa_id"] == "ward-2"
    assert history[1]["thu_tu"] == 3
    assert history[1]["ten_khoa_dieu_tri"] == "Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh"
    assert "Có biến chứng xác định khác" in history[1]["chan_doan"]


def test_attach_ward_history_sets_current_department_and_canonical_keeps_history():
    row = {"Mã BN": "BN003", "Họ tên": "TRAN VAN C"}
    html = """
    <h5 onclick="showAllTrangThaiYLenh('ward-1');">Khoa điều trị thứ 1: Khoa Cấp cứu (Ngày vào: 17:00 08/05/2026 - Chẩn đoán: Theo dõi)</h5>
    <h5 onclick="showAllTrangThaiYLenh('ward-3');">Khoa điều trị thứ 3: Khoa Ngoại CTCH-TK (Ngày vào: 21:33 08/05/2026 - Chẩn đoán: Gãy xương)</h5>
    """

    history = _attach_ward_admission_history(row, html)
    out = _canonical_patient_row_for_runtime(row)

    assert len(history) == 2
    assert row["thoi_gian_vao_khoa"] == "21:33 08/05/2026"
    assert row["ten_khoa_dieu_tri"] == "Khoa Ngoại CTCH-TK"
    assert out["thoi_gian_vao_khoa"] == "21:33 08/05/2026"
    assert out["ten_khoa_dieu_tri"] == "Khoa Ngoại CTCH-TK"
    assert len(out["lich_su_khoa_dieu_tri"]) == 2


def test_output_schema_propagates_ward_history():
    history = [
        {"thu_tu": 1, "thoi_gian_vao_khoa": "17:00 08/05/2026", "ten_khoa_dieu_tri": "Khoa Cấp cứu"},
        {"thu_tu": 2, "thoi_gian_vao_khoa": "19:04 08/05/2026", "ten_khoa_dieu_tri": "Khoa Gây Mê Hồi Sức"},
    ]
    record = make_patient_day_record(
        {"ma_bn": "BN004", "lich_su_khoa_dieu_tri": history},
        ngay_lam="13/05/2026",
        raw_dien_bien="",
        raw_y_lenh="",
        doc_name="",
        doc_content="",
        order_header_time="",
        clean_text_for_entry=lambda x: x,
    )

    assert record["lich_su_khoa_dieu_tri"] == history
