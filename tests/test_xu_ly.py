# -*- coding: utf-8 -*-
"""
tests/test_xu_ly.py — Test phân loại thuốc / dịch truyền (xu_ly.py).

Mục tiêu: đảm bảo process_all() không làm mất thuốc, không phân loại sai
sau mỗi lần sửa code.

Chạy: python -m pytest tests/test_xu_ly.py -v
"""
import json
import tempfile
import os
import pytest

try:
    from xu_ly import process_all
    XU_LY_AVAILABLE = True
except Exception as e:
    XU_LY_AVAILABLE = False
    XU_LY_ERROR = str(e)


def _run(records: list) -> list:
    """Chạy process_all trên danh sách records, trả về output."""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json',
                                     encoding='utf-8', delete=False) as f:
        json.dump(records, f, ensure_ascii=False)
        in_path = f.name

    out_path = in_path.replace('.json', '_out.json')
    try:
        process_all(in_path, output_file=out_path)
        if os.path.exists(out_path):
            with open(out_path, encoding='utf-8') as f:
                return json.load(f)
        return []
    finally:
        for p in [in_path, out_path]:
            try: os.unlink(p)
            except: pass


skip_if_unavailable = pytest.mark.skipif(
    not XU_LY_AVAILABLE,
    reason=f"xu_ly không import được: {XU_LY_ERROR if not XU_LY_AVAILABLE else ''}",
)


# ── Tests ──────────────────────────────────────────────────────────────────────

@skip_if_unavailable
class TestCoBan:

    def test_empty_input(self):
        """Input rỗng → output rỗng, không crash."""
        result = _run([])
        assert result == []

    def test_record_no_ylenh(self, record_empty):
        """BN không có Y lệnh và không có Diễn biến → process_all bỏ qua, không crash.

        Hành vi đúng: record hoàn toàn rỗng không tạo output (tránh nhập trắng vào EMR).
        Nếu muốn record vẫn xuất hiện trong output, cần có ít nhất Diễn biến hoặc Y lệnh.
        """
        result = _run([record_empty])
        # Không crash là điều kiện cần; output rỗng là hành vi đúng cho record trống.
        assert isinstance(result, list)

    def test_output_has_required_fields(self, record_thuoc_uong):
        """Output phải có các trường cần thiết."""
        result = _run([record_thuoc_uong])
        assert result, "Không tạo được output"
        r = result[0]
        for field in ['ma_bn', 'ngay_lam', 'thuoc']:
            assert field in r, f"Thiếu field: {field}"

    def test_ma_bn_preserved(self, record_thuoc_uong):
        """ma_bn không được bị thay đổi sau xử lý."""
        result = _run([record_thuoc_uong])
        assert result[0]['ma_bn'] == 'TEST001'

    def test_ngay_lam_preserved(self, record_thuoc_uong):
        """ngay_lam không được bị thay đổi."""
        result = _run([record_thuoc_uong])
        assert result[0]['ngay_lam'] == '26/04/2026'


@skip_if_unavailable
class TestPhanLoaiThuoc:

    def test_thuoc_uong_duoc_phan_loai(self, record_thuoc_uong):
        """Thuốc uống phải xuất hiện trong thuoc.thuoc_uong."""
        result = _run([record_thuoc_uong])
        assert result, "Không tạo được output"
        thuoc = result[0].get('thuoc', {})
        uong = thuoc.get('thuoc_uong', [])
        assert len(uong) > 0, "Không có thuốc uống nào được phân loại"

    def test_thuoc_tiem_duoc_phan_loai(self, record_thuoc_tiem):
        """Thuốc tiêm phải xuất hiện trong thuoc.thuoc_tiem."""
        result = _run([record_thuoc_tiem])
        assert result
        thuoc = result[0].get('thuoc', {})
        tiem = thuoc.get('thuoc_tiem', [])
        assert len(tiem) > 0, "Không có thuốc tiêm nào được phân loại"

    def test_dich_truyen_duoc_phan_loai(self, record_dich_truyen):
        """NaCl truyền tĩnh mạch phải vào dich_truyen."""
        result = _run([record_dich_truyen])
        assert result
        thuoc = result[0].get('thuoc', {})
        dt = thuoc.get('dich_truyen', [])
        assert len(dt) > 0, "Không có dịch truyền nào được phân loại"

    def test_thuoc_uong_khong_mat(self, record_thuoc_uong):
        """Số lượng thuốc uống không được ít hơn trong Y lệnh gốc."""
        # Input có 1 loại thuốc uống (AMOXICILLIN)
        result = _run([record_thuoc_uong])
        assert result
        thuoc = result[0].get('thuoc', {})
        uong = thuoc.get('thuoc_uong', [])
        names = [str(u.get('ten_thuoc', '') or u.get('ten_hien_thi', '')).upper() for u in uong]
        assert any('AMOXICILLIN' in n for n in names), \
            f"AMOXICILLIN bị mất sau xử lý. Còn lại: {names}"


@skip_if_unavailable
class TestThuocThem:

    def test_thuoc_truoc_7h_khong_mat(self, record_thuoc_them):
        """
        Y lệnh dự trù (mốc giờ < 07:00) không được bị mất.
        PARACETAMOL ở 05:30 phải có trong output.
        """
        result = _run([record_thuoc_them])
        assert result
        thuoc = result[0].get('thuoc', {})
        all_drugs = (
            thuoc.get('thuoc_uong', []) +
            thuoc.get('thuoc_tiem', []) +
            thuoc.get('dich_truyen', [])
        )
        names = [str(d.get('ten_thuoc', '') or d.get('ten_hien_thi', '') or
                      d.get('hoat_chat', '')).upper() for d in all_drugs]
        assert any('PARACETAMOL' in n for n in names), \
            f"PARACETAMOL (dự trù 05:30) bị mất. Còn lại: {names}"

    def test_thuoc_them_sau_7h_co_mat(self, record_thuoc_them):
        """
        Y lệnh thêm (mốc giờ >= 07:00) phải có trong output.
        IBUPROFEN ở 09:15 phải có trong output.
        """
        result = _run([record_thuoc_them])
        assert result
        thuoc = result[0].get('thuoc', {})
        all_drugs = (
            thuoc.get('thuoc_uong', []) +
            thuoc.get('thuoc_tiem', []) +
            thuoc.get('dich_truyen', [])
        )
        names = [str(d.get('ten_thuoc', '') or d.get('ten_hien_thi', '') or
                      d.get('hoat_chat', '')).upper() for d in all_drugs]
        assert any('IBUPROFEN' in n for n in names), \
            f"IBUPROFEN (thêm 09:15) bị mất. Còn lại: {names}"


@skip_if_unavailable
class TestNhieuNgay:

    def test_nhieu_ngay_khong_gom_sai(self, record_nhieu_ngay):
        """3 ngày của cùng 1 BN phải tạo ra đủ 3 record riêng."""
        result = _run(record_nhieu_ngay)
        ngay_lam_values = [r['ngay_lam'] for r in result]
        assert '26/04/2026' in ngay_lam_values, "Thiếu ngày 26/04"
        assert '27/04/2026' in ngay_lam_values, "Thiếu ngày 27/04"
        assert '28/04/2026' in ngay_lam_values, "Thiếu ngày 28/04"

    def test_dich_truyen_chi_trong_ngay_co(self, record_nhieu_ngay):
        """
        Dịch truyền chỉ xuất hiện ngày 27/04 (METRONIDAZOL).
        Ngày 26 và 28 không được có dịch truyền này.
        """
        result = _run(record_nhieu_ngay)
        by_date = {r['ngay_lam']: r for r in result}

        r27 = by_date.get('27/04/2026', {})
        dt27 = r27.get('thuoc', {}).get('dich_truyen', [])
        names27 = [str(d.get('ten_thuoc', '') or d.get('ten_hien_thi', '')).upper()
                   for d in dt27]
        assert any('METRONIDAZOL' in n for n in names27), \
            f"METRONIDAZOL phải có ngày 27/04. Có: {names27}"

        r26 = by_date.get('26/04/2026', {})
        dt26 = r26.get('thuoc', {}).get('dich_truyen', [])
        names26 = [str(d.get('ten_thuoc', '') or d.get('ten_hien_thi', '')).upper()
                   for d in dt26]
        assert not any('METRONIDAZOL' in n for n in names26), \
            f"METRONIDAZOL không được có ngày 26/04. Có: {names26}"

@skip_if_unavailable
class TestParseTheoBangCanhBao:

    def test_thuoc_tu_tuc_u_khong_bi_xep_thuoc_tiem(self):
        result = _run([{
            "Mã BN": "TEST_TT_U",
            "Họ tên": "BN TEST",
            "Bác sĩ": "BS TEST",
            "Vi_Tri": "P10",
            "ngay_lam": "29/04/2026",
            "Diễn biến": "",
            "Y lệnh": (
                "08:00 | Bác sĩ: BS TEST\n"
                "+ Thuốc:\n"
                "(TT)  1st Strike 01 vx2 u 8h 16h\n"
                "(TT) ZnC 70mg 01vx2 u 8h 16h\n"
                "(TT) Omega 3 1000mg EPA 01vx2u 8h 16h\n"
                "(TT)  ONS Glucerna có sẵn 200ml x2 u xen kẽ ăn\n"
            ),
        }])
        assert result
        thuoc = result[0].get("thuoc", {})
        uong_names = [str(d.get("ten_thuoc", "")).upper() for d in thuoc.get("thuoc_uong", [])]
        tiem_names = [str(d.get("ten_thuoc", "")).upper() for d in thuoc.get("thuoc_tiem", [])]
        assert any("1ST STRIKE" in n for n in uong_names)
        assert any("ZNC 70MG" in n for n in uong_names)
        assert any("OMEGA 3" in n for n in uong_names)
        assert any("ONS GLUCERNA" in n for n in uong_names)
        assert not any("1ST STRIKE" in n or "ZNC 70MG" in n or "OMEGA 3" in n or "ONS GLUCERNA" in n for n in tiem_names)

    def test_thuoc_uong_khong_lay_the_tich_truyen_tu_config(self):
        result = _run([{
            "Mã BN": "TEST_LINEZOLID_U",
            "Họ tên": "BN TEST",
            "Bác sĩ": "BS TEST",
            "Vi_Tri": "P10",
            "ngay_lam": "29/04/2026",
            "Diễn biến": "",
            "Y lệnh": (
                "08:00 | Bác sĩ: BS TEST\n"
                "+ Thuốc:\n"
                "(TT) Linezolid 600mg 01 viên X 2 uống 8h-20h\n"
            ),
        }])
        assert result
        uong = result[0].get("thuoc", {}).get("thuoc_uong", [])
        linezolid = next((d for d in uong if "LINEZOLID" in str(d.get("ten_thuoc", "")).upper()), None)
        assert linezolid is not None
        assert float(linezolid.get("the_tich") or 0) == 0

    def test_so_luong_moi_gio_theo_gio_trong_ngoac_khong_mac_dinh_14_20(self):
        result = _run([{
            "Mã BN": "TEST_DOSE_HOUR",
            "Họ tên": "BN TEST",
            "Bác sĩ": "BS TEST",
            "Vi_Tri": "P10",
            "ngay_lam": "29/04/2026",
            "Diễn biến": "",
            "Y lệnh": (
                "08:00 | Bác sĩ: BS TEST\n"
                "+ Thuốc:\n"
                "CEFOXITIN 1G x 6 (Lọ)\n"
                "Tiêm mạch chậm, 1 ngày, sáng 2 lọ, chiều 2 lọ, tối 2 lọ(8 giờ, 16 giờ, 22 giờ).\n"
                "PHARBACOL (Paracetamol) 650mg x 3 (Viên)\n"
                "Uống, 1 ngày, sáng 1 viên, chiều 1 viên, tối 1 viên(8 giờ, 16 giờ, 22 giờ).\n"
            ),
        }])
        assert result
        thuoc = result[0].get("thuoc", {})
        cefoxitin = next((d for d in thuoc.get("thuoc_tiem", []) if "CEFOXITIN" in str(d.get("ten_thuoc", "")).upper()), None)
        pharbacol = next((d for d in thuoc.get("thuoc_uong", []) if "PHARBACOL" in str(d.get("ten_thuoc", "")).upper()), None)
        assert cefoxitin is not None
        assert pharbacol is not None
        assert {int(k): v for k, v in cefoxitin.get("so_luong_moi_gio", {}).items()} == {8: 2, 16: 2, 22: 2}
        assert {int(k): v for k, v in pharbacol.get("so_luong_moi_gio", {}).items()} == {8: 1, 16: 1, 22: 1}

    def test_pharbacol_vien_u_inline_khong_dinh_vao_dich_truyen(self):
        result = _run([{
            "Mã BN": "TEST_PHARBACOL_U",
            "Họ tên": "BN TEST",
            "Bác sĩ": "BS TEST",
            "Vi_Tri": "P10",
            "ngay_lam": "05/05/2026",
            "Diễn biến": "",
            "Y lệnh": (
                "08:00 | Bác sĩ: BS TEST\n"
                "+ Thuốc:\n"
                "PHARBACOL (Paracetamol) 650mg x 3 (Viên) (u) 8h-16h-22h\n"
            ),
        }])
        assert result
        thuoc = result[0].get("thuoc", {})
        assert not any("PHARBACOL" in str(d.get("ten_thuoc", "")).upper() for d in thuoc.get("dich_truyen", []))
        pharbacol = next((d for d in thuoc.get("thuoc_uong", []) if "PHARBACOL" in str(d.get("ten_thuoc", "")).upper()), None)
        assert pharbacol is not None
        assert pharbacol.get("gio_dung") == "8 giờ, 16 giờ, 22 giờ"
        assert pharbacol.get("duong_dung") == "U"

    def test_pharbacol_vien_thieu_duong_dung_khong_suy_luan_ttm(self):
        result = _run([{
            "Mã BN": "TEST_PHARBACOL_NO_ROUTE",
            "Họ tên": "BN TEST",
            "Bác sĩ": "BS TEST",
            "Vi_Tri": "P10",
            "ngay_lam": "05/05/2026",
            "Diễn biến": "",
            "Y lệnh": (
                "08:00 | Bác sĩ: BS TEST\n"
                "+ Thuốc:\n"
                "PHARBACOL (Paracetamol) 650mg x 3 (Viên)\n"
            ),
        }])
        assert result
        thuoc = result[0].get("thuoc", {})
        assert not any("PHARBACOL" in str(d.get("ten_thuoc", "")).upper() for d in thuoc.get("dich_truyen", []))

@skip_if_unavailable
class TestDuTruMarker:

    def test_du_tru_thuoc_8h_duoc_gan_co_noi_bo_va_khong_vao_y_lenh_khac(self):
        result = _run([{
            "Mã BN": "TEST_DUTRU_8H",
            "Họ tên": "BN TEST",
            "Bác sĩ": "BS TEST",
            "Vi_Tri": "P10",
            "ngay_lam": "29/04/2026",
            "Diễn biến": "",
            "Y lệnh": (
                "08:00 | Bác sĩ: BS TEST\n"
                "+ Y lệnh khác:\n"
                "Dự trù thuốc\n"
                "+ Thuốc:\n"
                "Linezolid 600mg 01 viên X 2 uống 8h-20h\n"
            ),
        }])
        assert result
        r = result[0]
        uong = r.get("thuoc", {}).get("thuoc_uong", [])
        assert uong, "Phải phân tích được thuốc uống dự trù lúc 08:00"
        assert any(d.get("du_tru") is True or d.get("reserve_order") is True for d in uong)
        other = r.get("y_lenh_khac", {}).get("khac", [])
        assert not any("dự trù" in str(x).lower() for x in other)

@skip_if_unavailable
class TestDuTruMarkerFromDienBien:

    def test_du_tru_o_dien_bien_cung_gio_khong_bi_gan_thuoc_them(self):
        result = _run([{
            "Mã BN": "TEST_DUTRU_DB",
            "Họ tên": "BN TEST",
            "Bác sĩ": "BS TEST",
            "Vi_Tri": "P10",
            "ngay_lam": "29/04/2026",
            "Diễn biến": (
                "08:00 29/04/2026 - Bác sĩ: BS TEST\n"
                "Dự trù thuốc ngày 29/4/2026\n"
                "08:42 29/04/2026 - Bác sĩ: BS TEST\n"
                "Ngoại CTCH xem lại\n"
            ),
            "Y lệnh": (
                "08:00 29/04/2026 - Bác sĩ: BS TEST\n"
                "+ Y lệnh khác:\n"
                "(TT) Paracetamol 1g/100ml 01 túi x2 (TTM) Cg/p 8h - 20h\n"
                "(TT) 1st Strike 01 vx2 u 8h 16h\n"
                "08:42 29/04/2026 - Bác sĩ: BS TEST\n"
                "+ Y lệnh khác:\n"
                "Thêm:\n"
                "(TT) cefixim 400mg 01 viên uống 8h\n"
            ),
        }])
        assert result
        thuoc = result[0].get("thuoc", {})
        all_items = thuoc.get("dich_truyen", []) + thuoc.get("thuoc_uong", [])
        reserve_items = [d for d in all_items if str(d.get("gio_y_lenh")) == "08:00"]
        add_items = [d for d in all_items if str(d.get("gio_y_lenh")) == "08:42"]
        assert reserve_items, "Phải có thuốc dự trù ở mốc 08:00"
        assert all(d.get("du_tru") is True or d.get("reserve_order") is True for d in reserve_items)
        assert add_items, "Phải có thuốc thêm ở mốc 08:42"
        assert all(not (d.get("du_tru") is True or d.get("reserve_order") is True) for d in add_items)

@skip_if_unavailable
class TestDuTruActualEmrBlocks:

    def test_du_tru_trong_dien_bien_08h_khong_hien_thuoc_them_va_them_that_su_co_flag(self):
        result = _run([{
            "Mã BN": "TEST_DUTRU_ACTUAL",
            "Họ tên": "BN TEST",
            "Bác sĩ": "BS TEST",
            "Vi_Tri": "P10",
            "ngay_lam": "29/04/2026",
            "Diễn biến": (
                "08:00 | Bác sĩ: Phạm Việt Tân\n"
                "Dự trù thuốc ngày 29/4/2026\n"
                "---\n"
                "08:42 | Bác sĩ: Nguyễn Chí Nguyện\n"
                "Ngoại CTCH xem lại\n"
            ),
            "Y lệnh": (
                "08:00 | Bác sĩ: Phạm Việt Tân\n"
                "+ Y lệnh khác:\n"
                "(TT) Domitazol 02 viên x 3 (u) 8h 16h 22h\n"
                "(TT) Paracetamol 1g/100ml 01 túi x2 (TTM) Cg/p 8h - 20h\n"
                "+ Thuốc:\n"
                "KAVASDIN 5 (Amlodipin)  x 1 (Viên)\n"
                "Uống, 1 ngày, sáng 1 viên(8 giờ).\n"
                "---\n"
                "08:42 | Bác sĩ: Nguyễn Chí Nguyện\n"
                "+ Y lệnh khác:\n"
                "Thêm:\n"
                "(TT) cefixim 400mg 01 viên uống 8h\n"
                "(TT) Linezolid 600mg 01 viên X 2 uống 8h-20h\n"
            ),
        }])
        assert result
        thuoc = result[0].get("thuoc", {})
        all_items = thuoc.get("dich_truyen", []) + thuoc.get("thuoc_tiem", []) + thuoc.get("thuoc_uong", [])
        reserve_items = [d for d in all_items if str(d.get("gio_y_lenh")) == "08:00"]
        add_items = [d for d in all_items if str(d.get("gio_y_lenh")) == "08:42"]
        assert reserve_items
        assert all(d.get("du_tru") is True and d.get("thuoc_them") is not True for d in reserve_items)
        assert add_items
        assert all(d.get("thuoc_them") is True and d.get("du_tru") is not True for d in add_items)

@skip_if_unavailable
class TestMalformedSelfPaidMarker:

    def test_tt0_nucleo_cmp_tb_8h_duoc_nhan_la_thuoc_tiem_tu_tuc(self):
        result = _run([{
            "Mã BN": "TEST_TT0_NUCLEO",
            "Họ tên": "BN TEST",
            "Bác sĩ": "BS TEST",
            "Vi_Tri": "P09",
            "ngay_lam": "04/05/2026",
            "Diễn biến": "",
            "Y lệnh": (
                "08:00 | Bác sĩ: BS TEST\n"
                "+ Thuốc:\n"
                "(TT0 Nucleo CMP 1A (TB) 8h\n"
            ),
        }])
        assert result
        thuoc = result[0].get("thuoc", {})
        tiem = thuoc.get("thuoc_tiem", [])
        uong = thuoc.get("thuoc_uong", [])
        all_tiem_names = [str(d.get("ten_thuoc", "")).upper() for d in tiem]
        all_uong_names = [str(d.get("ten_thuoc", "")).upper() for d in uong]
        nucleo = next((d for d in tiem if "NUCLEO CMP" in str(d.get("ten_thuoc", "")).upper()), None)
        assert nucleo is not None, f"Nucleo CMP phải vào thuốc tiêm. Tiêm: {all_tiem_names}; Uống: {all_uong_names}"
        assert "8 giờ" in str(nucleo.get("gio_dung", ""))
        assert "bắp" in str(nucleo.get("duong_dung_goc", "")).lower()
        assert nucleo.get("tu_tuc") is True
        assert not any("NUCLEO CMP" in n for n in all_uong_names)


def test_discharge_detected_from_progress_note_even_when_xu_tri_status_only():
    from processing.patient_day_builder import build_patient_day_records

    data = [{
        "Mã BN": "99050547",
        "Họ tên": "NGƯỜI BỆNH M",
        "Bác sĩ": "BÁC SĨ THỬ",
        "Chẩn đoán": "Gãy lún thân sống N12, L4",
        "T/G vào": "08:25 29-04-2026",
        "Khoa chuyển đến": "Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh Buồng/giường",
        "Xử trí": "Đang thực hiện",
        "Vi_Tri": "P08",
        "ngay_lam": "05/05/2026",
        "Y lệnh": "05:00 | Bác sĩ: BÁC SĨ THỬ\n+ Thuốc:\nPHARBACOL (Paracetamol) 650mg x 2 (Viên)\nUống, 1 ngày, chiều 1 viên, tối 1 viên.",
        "Diễn biến": "05:00 | Bác sĩ: BÁC SĨ THỬ\nDự trù thuốc\n---\n08:00 | Bác sĩ: BÁC SĨ THỬ\nBệnh nhân tỉnh\nBệnh tạm ổn-> Xuất viện\nUống thuốc theo toa, tái khám đăng kí phòng khám số 20 chiều ngày 14/5/2026",
    }]

    result = build_patient_day_records(data)
    assert len(result) == 1
    record = result[0]
    assert record.get("care_mode") == "discharge_day"
    events = record.get("care_special_events") or []
    assert any(ev.get("type") == "discharge" and ev.get("time_full") == "08:00 05/05/2026" for ev in events)


def test_list_discharge_disposition_is_not_overwritten_by_status_like_detail_value():
    from main_worker import _merge_patient_admin_info

    row = {
        "Mã BN": "99050547",
        "Họ tên": "NGƯỜI BỆNH M",
        "Trạng thái": "Đang thực hiện",
        "Xử trí": "Ra viện Đỡ giảm",
    }
    html = """
    <html><body>
      <div>Trạng thái: Đang thực hiện</div>
      <div>Xử trí: Đang thực hiện</div>
    </body></html>
    """
    merged = _merge_patient_admin_info(row, html, overwrite=True)
    assert merged["Xử trí"] == "Ra viện Đỡ giảm"
    assert merged["xu_tri"] == "Ra viện Đỡ giảm"


def test_discharge_label_time_overrides_progress_note_time():
    from processing.patient_day_builder import build_patient_day_records

    data = [{
        "Mã BN": "99050547",
        "Họ tên": "NGƯỜI BỆNH M",
        "Bác sĩ": "BÁC SĨ THỬ",
        "Chẩn đoán": "Gãy lún thân sống N12, L4",
        "T/G vào": "08:25 29-04-2026",
        "Khoa chuyển đến": "Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh Buồng/giường",
        "Xử trí": "Ra viện Đỡ giảm",
        "ngay_ra_vien": "13:00 05/05/2026",
        "gio_ra_vien": "13:00",
        "ngay_ra_vien_date": "05/05/2026",
        "ra_vien_hom_nay": True,
        "Vi_Tri": "P08",
        "ngay_lam": "05/05/2026",
        "Y lệnh": "05:00 | Bác sĩ: BÁC SĨ THỬ\n+ Thuốc:\nPHARBACOL (Paracetamol) 650mg x 2 (Viên)\nUống, 1 ngày, chiều 1 viên, tối 1 viên.",
        "Diễn biến": "05:00 | Bác sĩ: BÁC SĨ THỬ\nDự trù thuốc\n---\n08:00 | Bác sĩ: BÁC SĨ THỬ\nBệnh nhân tỉnh\nBệnh tạm ổn-> Xuất viện\nUống thuốc theo toa, tái khám đăng kí phòng khám số 20 chiều ngày 14/5/2026",
    }]

    result = build_patient_day_records(data)
    assert len(result) == 1
    record = result[0]
    assert record.get("care_mode") == "discharge_day"
    events = [ev for ev in (record.get("care_special_events") or []) if ev.get("type") == "discharge"]
    assert len(events) == 1
    assert events[0].get("time_full") == "13:00 05/05/2026"
    assert not any(ev.get("time_full") == "08:00 05/05/2026" for ev in events)


def test_extract_list_row_preserves_discharge_disposition_from_tbl_noitru():
    from main_worker import _extract_list_row_for_patient_from_html, _merge_admin_from_list_row

    html = '''
    <table id="tblNoiTru">
      <thead><tr><th>Mã BN</th><th>Họ tên</th><th>Trạng thái</th><th>Xử trí</th></tr></thead>
      <tbody>
        <tr><td>99050547</td><td>NGƯỜI BỆNH M</td><td>Đang thực hiện</td><td>Ra viện<br>Đỡ giảm</td></tr>
      </tbody>
    </table>
    '''
    list_row = _extract_list_row_for_patient_from_html(html, "99050547")
    row = {"Mã BN": "99050547", "Xử trí": "Đang thực hiện"}
    _merge_admin_from_list_row(row, list_row)
    assert row["Xử trí"] == "Ra viện Đỡ giảm"
    assert row["xu_tri"] == "Ra viện Đỡ giảm"


def test_current_active_list_row_clears_stale_discharge_disposition():
    from main_worker import _merge_admin_from_list_row

    row = {
        "Mã BN": "99050001",
        "Xử trí": "Ra viện Đỡ giảm",
        "xu_tri": "Ra viện Đỡ giảm",
        "ngay_ra_vien": "08:36 25/05/2026",
        "gio_ra_vien": "08:36",
        "ngay_ra_vien_date": "25/05/2026",
        "ra_vien_hom_nay": True,
        "care_mode": "discharge_day",
        "care_special_events": [{"type": "discharge", "time_full": "08:36 25/05/2026"}],
    }
    list_row = {
        "Mã BN": "99050001",
        "Trạng thái": "Đang thực hiện",
        "Xử trí": "Đang thực hiện",
    }

    merged = _merge_admin_from_list_row(row, list_row)
    assert merged.get("ngay_ra_vien") == ""
    assert merged.get("gio_ra_vien") == ""
    assert merged.get("ngay_ra_vien_date") == ""
    assert merged.get("ra_vien_hom_nay") is False
    assert merged.get("care_mode") != "discharge_day"
    assert not any(ev.get("type") == "discharge" for ev in merged.get("care_special_events", []))
    assert merged.get("xu_tri") == "Đang thực hiện"


def test_stale_discharge_before_current_ward_admission_is_removed_before_record_build():
    from main_worker import _build_record

    bn = {
        "Mã BN": "99050002",
        "Họ tên": "NGƯỜI BỆNH N",
        "Xử trí": "Ra viện Đỡ giảm",
        "xu_tri": "Ra viện Đỡ giảm",
        "ngay_ra_vien": "08:36 25/05/2026",
        "gio_ra_vien": "08:36",
        "ngay_ra_vien_date": "25/05/2026",
        "ra_vien_hom_nay": True,
        "thoi_gian_vao_khoa": "14:21 29/05/2026",
    }
    rec = _build_record(
        bn,
        "14/06/2026",
        {"Y lệnh": "08:00 | Bác sĩ\n+ Thuốc", "Diễn biến": "08:00 | Bệnh ổn"},
    )
    assert rec.get("ma_bn") == "99050002"
    assert rec.get("ngay_ra_vien") in (None, "")
    assert rec.get("gio_ra_vien") in (None, "")
    assert rec.get("ngay_ra_vien_date") in (None, "")
    assert rec.get("ra_vien_hom_nay") in (None, False)
    assert rec.get("xu_tri") in (None, "")
