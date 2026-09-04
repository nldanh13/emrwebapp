# -*- coding: utf-8 -*-
"""
tests/test_infusions_result_key.py

Kiểm tra:
1. _result_keys_for_patient() — key kết quả theo ngày (bug gốc: chỉ dùng ma_bn)
2. _build_display_med_name()  — tiền tố (TT) cho thuốc tự túc
3. chuan_bi_du_lieu_json()    — tạo __managed_date marker đúng ngày

Chạy: python -m pytest tests/test_infusions_result_key.py -v
"""
import sys
import os
import json
import tempfile
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'worker'))

try:
    # Pure helper, không phụ thuộc Selenium. Tránh test fail chỉ vì máy dev/CI chưa cài Selenium.
    from infusion_result_keys import result_keys_for_patient as _result_keys_for_patient
    INFUSIONS_AVAILABLE = True
except Exception as e:
    INFUSIONS_AVAILABLE = False
    INFUSIONS_ERR = str(e)

try:
    from input_infusions_utils import (
        _build_display_med_name,
        chuan_bi_du_lieu_json,
    )
    UTILS_AVAILABLE = True
except Exception as e:
    UTILS_AVAILABLE = False
    UTILS_ERR = str(e)

skip_infusions = pytest.mark.skipif(
    not INFUSIONS_AVAILABLE,
    reason=f"input_infusions không import được: {'' if INFUSIONS_AVAILABLE else INFUSIONS_ERR}",
)
skip_utils = pytest.mark.skipif(
    not UTILS_AVAILABLE,
    reason=f"input_infusions_utils không import được: {'' if UTILS_AVAILABLE else UTILS_ERR}",
)


# ─────────────────────────────────────────────────────────────────────────────
# 1) _result_keys_for_patient
# ─────────────────────────────────────────────────────────────────────────────

@skip_infusions
class TestResultKeysForPatient:

    def _managed(self, date):
        return {"__managed_date": True, "Managed_Date": date}

    def _med(self, name="NaCl 0.9% 500ml", time="08:00"):
        return {"Search_Name": name, "Full_Name": name, "Time_Start_Str": time}

    # ── Bug gốc: nhập DT 1 ngày không được mark ngày khác ────────────────────

    def test_mot_ngay_tra_key_dung(self):
        """Nhập DT 26/04 → key phải là 'BN001::26/04/2026', không phải 'BN001'."""
        list_thuoc = [self._managed("26/04/2026"), self._med()]
        keys = _result_keys_for_patient("BN001", list_thuoc)
        assert keys == ["BN001::26/04/2026"], f"Keys sai: {keys}"

    def test_ngay_26_khong_mark_ngay_27(self):
        """Nhập DT ngày 26/04 → KHÔNG được mark ngày 27/04 là xong."""
        list_thuoc = [self._managed("26/04/2026"), self._med()]
        keys = _result_keys_for_patient("BN001", list_thuoc)
        assert "BN001::27/04/2026" not in keys, "Ngày 27 bị mark nhầm!"

    def test_nhieu_ngay_tao_nhieu_key(self):
        """BN có 3 ngày → phải trả 3 key riêng biệt."""
        list_thuoc = [
            self._managed("26/04/2026"),
            self._managed("27/04/2026"),
            self._managed("28/04/2026"),
            self._med("NaCl", "08:00"),
        ]
        keys = _result_keys_for_patient("BN002", list_thuoc)
        assert len(keys) == 3
        assert "BN002::26/04/2026" in keys
        assert "BN002::27/04/2026" in keys
        assert "BN002::28/04/2026" in keys

    def test_key_format_dung_cu_phap(self):
        """Key phải có đúng định dạng 'ma_bn::dd/mm/yyyy'."""
        list_thuoc = [self._managed("01/01/2026")]
        keys = _result_keys_for_patient("12345", list_thuoc)
        assert keys == ["12345::01/01/2026"]

    def test_fallback_khi_khong_co_managed_date(self):
        """Không có __managed_date → fallback về ma_bn (backward compat)."""
        list_thuoc = [self._med("NaCl", "08:00")]
        keys = _result_keys_for_patient("BN003", list_thuoc)
        assert keys == ["BN003"], f"Fallback sai: {keys}"

    def test_danh_sach_rong(self):
        """list_thuoc rỗng → fallback về ma_bn."""
        keys = _result_keys_for_patient("BN004", [])
        assert keys == ["BN004"]

    def test_managed_date_trong_khong_tinh(self):
        """__managed_date với Managed_Date rỗng không được tính vào keys."""
        list_thuoc = [{"__managed_date": True, "Managed_Date": ""}]
        keys = _result_keys_for_patient("BN005", list_thuoc)
        assert keys == ["BN005"]

    def test_key_duoc_sap_xep_theo_ngay(self):
        """Keys phải được sắp xếp để kết quả ổn định (dễ debug)."""
        list_thuoc = [
            self._managed("28/04/2026"),
            self._managed("26/04/2026"),
            self._managed("27/04/2026"),
        ]
        keys = _result_keys_for_patient("BN006", list_thuoc)
        assert keys == [
            "BN006::26/04/2026",
            "BN006::27/04/2026",
            "BN006::28/04/2026",
        ]


# ─────────────────────────────────────────────────────────────────────────────
# 2) _build_display_med_name — tiền tố (TT) thuốc tự túc
# ─────────────────────────────────────────────────────────────────────────────

@skip_utils
class TestBuildDisplayMedName:

    def test_thuoc_thuong_khong_them_tt(self):
        """Thuốc bình thường không có tiền tố (TT)."""
        item = {"ten_thuoc": "Paracetamol 1g", "tu_tuc": False}
        assert _build_display_med_name(item) == "Paracetamol 1g"

    def test_tu_tuc_them_tien_to(self):
        """Thuốc tự túc phải có tiền tố '(TT) '."""
        item = {"ten_thuoc": "Paracetamol 1g", "tu_tuc": True}
        result = _build_display_med_name(item)
        assert result.startswith("(TT) "), f"Thiếu tiền tố: {result!r}"
        assert "Paracetamol 1g" in result

    def test_tu_tuc_da_co_tien_to_khong_them_lan_2(self):
        """Nếu ten_hien_thi đã có '(TT)', không được thêm lần thứ hai."""
        item = {"ten_hien_thi": "(TT) Paracetamol 1g", "tu_tuc": True}
        result = _build_display_med_name(item)
        assert result.count("(TT)") == 1, f"Bị thêm (TT) 2 lần: {result!r}"

    @pytest.mark.parametrize("ten_thuoc", [
        "Paracetamol 1g 01 chai x3",
        "Paracetamol 1g 01chai x3",
        "Paracetamol 1g 01 chai x 3",
    ])
    def test_tt_cac_mau_dinh_dang_khac_nhau(self, ten_thuoc):
        """Các mẫu định dạng số lượng khác nhau đều phải có tiền tố (TT)."""
        item = {"ten_thuoc": ten_thuoc, "tu_tuc": True}
        result = _build_display_med_name(item)
        assert result.startswith("(TT) "), \
            f"Thiếu tiền tố với ten_thuoc={ten_thuoc!r}: {result!r}"

    def test_ten_rong_tra_chuoi_rong(self):
        """ten_thuoc rỗng → trả về chuỗi rỗng."""
        item = {"ten_thuoc": "", "tu_tuc": True}
        assert _build_display_med_name(item) == ""

    def test_uu_tien_ten_hien_thi(self):
        """ten_hien_thi được ưu tiên hơn ten_thuoc."""
        item = {"ten_hien_thi": "NaCl 0.9% 500ml", "ten_thuoc": "Natri Clorid", "tu_tuc": False}
        assert _build_display_med_name(item) == "NaCl 0.9% 500ml"


# ─────────────────────────────────────────────────────────────────────────────
# 3) chuan_bi_du_lieu_json — __managed_date marker đúng ngày
# ─────────────────────────────────────────────────────────────────────────────

def _make_json_entry(ma_bn, ngay_lam, dich_truyen=None):
    """Tạo entry DuLieu_PhanLoai giả để test chuan_bi_du_lieu_json."""
    return {
        "ma_bn": ma_bn,
        "ngay_lam": ngay_lam,
        "bac_si": "BS Test",
        "bac_si_theo_gio": [],
        "rule_log": {},
        "thuoc": {
            "dich_truyen": dich_truyen or [
                {
                    "ten_thuoc": "NaCl 0.9% 500ml",
                    "ten_hien_thi": "NaCl 0.9% 500ml",
                    "duong_dung_goc": "TTM",
                    "duong_dung": "TTM",
                    "tg_bat_dau": "08:00 " + ngay_lam,
                    "tg_ket_thuc": "",
                    "the_tich": 500,
                    "toc_do": "30",
                    "bac_si": "BS Test",
                    "tu_tuc": False,
                }
            ],
            "thuoc_tiem": [],
            "thuoc_uong": [],
        }
    }


@skip_utils
class TestChuanBiDuLieuJson:

    def _write_json(self, entries):
        f = tempfile.NamedTemporaryFile(
            mode='w', suffix='.json', encoding='utf-8', delete=False
        )
        json.dump(entries, f, ensure_ascii=False)
        f.close()
        return f.name

    def test_tao_managed_date_marker(self):
        """chuan_bi_du_lieu_json phải tạo __managed_date marker với Managed_Date đúng."""
        path = self._write_json([_make_json_entry("BN001", "26/04/2026")])
        try:
            data = chuan_bi_du_lieu_json(
                path,
                selected_dates={"26/04/2026"},
            )
        finally:
            os.unlink(path)

        assert "BN001" in data, "BN001 không có trong data"
        markers = [
            x for x in data["BN001"]
            if isinstance(x, dict) and x.get("__managed_date")
        ]
        assert len(markers) >= 1, "Không có __managed_date marker"
        assert any(m["Managed_Date"] == "26/04/2026" for m in markers)

    def test_loc_dung_ngay_duoc_chon(self):
        """selected_dates={'26/04/2026'} → không được đưa entry 27/04 vào data."""
        path = self._write_json([
            _make_json_entry("BN001", "26/04/2026"),
            _make_json_entry("BN001", "27/04/2026"),
        ])
        try:
            data = chuan_bi_du_lieu_json(
                path,
                selected_dates={"26/04/2026"},
            )
        finally:
            os.unlink(path)

        markers = [
            x for x in (data.get("BN001") or [])
            if isinstance(x, dict) and x.get("__managed_date")
        ]
        dates_in_data = {m["Managed_Date"] for m in markers}
        assert "26/04/2026" in dates_in_data
        assert "27/04/2026" not in dates_in_data, \
            "Ngày 27/04 không nên xuất hiện khi chỉ chọn 26/04"

    def test_result_keys_khop_voi_managed_dates(self):
        """Keys từ _result_keys_for_patient phải khớp với managed dates trong data."""
        path = self._write_json([
            _make_json_entry("BN001", "26/04/2026"),
            _make_json_entry("BN001", "27/04/2026"),
        ])
        try:
            data = chuan_bi_du_lieu_json(path)  # không lọc ngày → lấy cả 2
        finally:
            os.unlink(path)

        list_thuoc = data.get("BN001", [])
        keys = _result_keys_for_patient("BN001", list_thuoc)

        assert "BN001::26/04/2026" in keys
        assert "BN001::27/04/2026" in keys
        assert "BN001" not in keys, \
            "Không được có key fallback khi đã có managed_date"
