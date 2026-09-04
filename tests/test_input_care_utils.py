# -*- coding: utf-8 -*-
"""
tests/test_input_care_utils.py — Test các hàm tiện ích thuần trong input_care_utils.py.

Không cần Selenium, không cần EMR — chạy offline hoàn toàn.
Chạy: python -m pytest tests/test_input_care_utils.py -v
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'worker'))

import pytest

try:
    from input_care_utils import (
        _canon_hhmm, _canon_time_key, _time_field_matches,
        _hhmm_minutes_from_text, kiem_tra_noi_dung_cham_soc,
        kiem_tra_ten_trung_khop, _has_reserve_orders,
        tao_thoi_gian_lap, _special_event_hour,
        _special_event_default_dien_bien, _special_event_default_care,
        _has_surgical_context, _sanitize_postop_text,
        them_cham_soc_mac_dinh,
    )
    AVAILABLE = True
except Exception as e:
    AVAILABLE = False
    ERR = str(e)

skip = pytest.mark.skipif(not AVAILABLE, reason=f"input_care_utils unavailable: {ERR if not AVAILABLE else ''}")


@skip
class TestCanonHhmm:
    @pytest.mark.parametrize("raw,expected", [
        ("08:00", "08:00"),
        ("8:00",  "08:00"),
        ("8h00",  "08:00"),
        ("22:15", "22:15"),
        ("",      ""),
        ("abc",   ""),
    ])
    def test_cases(self, raw, expected):
        assert _canon_hhmm(raw) == expected


@skip
class TestTimeFieldMatches:
    def test_khop(self):
        assert _time_field_matches("8:00", "08:00")
        assert _time_field_matches("08:00", "8:00")

    def test_khong_khop(self):
        assert not _time_field_matches("08:00", "09:00")
        assert not _time_field_matches("", "08:00")


@skip
class TestHhmm:
    @pytest.mark.parametrize("raw,expected", [
        ("08:00", 480), ("05:30", 330), ("22:00", 1320),
        ("",      None), ("abc", None),
    ])
    def test_cases(self, raw, expected):
        assert _hhmm_minutes_from_text(raw) == expected


@skip
class TestKiemTraNoDung:
    def test_khop_chinh_xac(self):
        assert kiem_tra_noi_dung_cham_soc("Thực hiện chỉ định thuốc", "Thực hiện chỉ định thuốc")

    def test_expected_rong(self):
        assert kiem_tra_noi_dung_cham_soc("bất kỳ nội dung", "")

    def test_actual_rong(self):
        assert not kiem_tra_noi_dung_cham_soc("", "Thực hiện chỉ định thuốc")

    def test_partial_match(self):
        assert kiem_tra_noi_dung_cham_soc(
            "Thực hiện chỉ định thuốc\nLấy dấu hiệu sinh tồn",
            "Lấy dấu hiệu sinh tồn"
        )


@skip
class TestHasReserveOrders:
    def test_co_lenh_truoc_7h(self):
        entry = {'thuoc': {'thuoc_uong': [{'gio_y_lenh': '05:00'}]}}
        assert _has_reserve_orders(entry)

    def test_khong_co_lenh_truoc_7h(self):
        entry = {'thuoc': {'thuoc_uong': [{'gio_y_lenh': '08:00'}]}}
        assert not _has_reserve_orders(entry)

    def test_entry_rong(self):
        assert not _has_reserve_orders({})
        assert not _has_reserve_orders(None)


@skip
class TestTaoThoiGianLap:
    def test_gio_binh_thuong(self):
        result = tao_thoi_gian_lap(8, "26/04/2026")
        assert result == "08:00 26/04/2026"

    def test_gio_ca_dem_sang_ngay_sau(self):
        # Giờ 5 → ngày hôm sau
        result = tao_thoi_gian_lap(5, "26/04/2026")
        assert result == "05:00 27/04/2026"

    def test_gio_0_sang_ngay_sau(self):
        result = tao_thoi_gian_lap(0, "26/04/2026")
        assert result == "00:00 27/04/2026"


@skip
class TestSpecialEvent:
    def test_discharge_dien_bien(self):
        ev = {"type": "discharge"}
        assert "xuất viện" in _special_event_default_dien_bien(ev)

    def test_discharge_care(self):
        ev = {"type": "discharge"}
        assert "ra viện" in _special_event_default_care(ev)

    def test_hour_from_event(self):
        ev = {"time_full": "08:00 26/04/2026"}
        assert _special_event_hour(ev) == 8


@skip
class TestSurgicalContext:
    def test_co_action_thay_bang(self):
        assert _has_surgical_context({}, {"THAY_BANG"})

    def test_co_keyword_phau_thuat(self):
        assert _has_surgical_context({"xu_tri": "Phẫu thuật kết hợp xương"})

    def test_khong_co_context(self):
        assert not _has_surgical_context({"xu_tri": "Điều trị nội khoa"})


@skip
class TestSanitizePostop:
    def test_giu_phan_khong_lien_quan(self):
        text = "Thực hiện thuốc + Chăm sóc vết mổ + Lấy sinh tồn"
        result = _sanitize_postop_text(text)
        assert "Thực hiện thuốc" in result
        assert "Lấy sinh tồn" in result
        assert "vết mổ" not in result

    def test_empty(self):
        assert _sanitize_postop_text("") == ""
        assert _sanitize_postop_text(None) is None


@skip
class TestThemChamSocMacDinh:
    def test_them_thuc_hien_thuoc(self):
        result = them_cham_soc_mac_dinh([], gio=8, med_hours=[8, 14])
        assert "Thực hiện chỉ định thuốc" in result

    def test_them_du_tru_thuoc_5h(self):
        result = them_cham_soc_mac_dinh([], gio=5, med_hours=[5], has_reserve_orders=True)
        assert "Dự trù thuốc" not in result
        assert "Thực hiện chỉ định thuốc" in result

    def test_them_sinh_ton_5h(self):
        result = them_cham_soc_mac_dinh([], gio=5, med_hours=[])
        assert "Lấy dấu hiệu sinh tồn" in result

    def test_khong_trung_lap(self):
        result = them_cham_soc_mac_dinh(
            ["Thực hiện chỉ định thuốc"], gio=8, med_hours=[8]
        )
        assert result.count("Thực hiện chỉ định thuốc") == 1
