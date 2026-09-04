# -*- coding: utf-8 -*-
"""
tests/test_parsers.py — Test logic parse ngày giờ trong emr_parsers.py.

Đây là các test quan trọng nhất vì lỗi parse giờ → mất thuốc hoặc lấy
nhầm y lệnh của ca khác.

Chạy: python -m pytest tests/test_parsers.py -v
"""
import pytest

try:
    from emr_parsers import (
        _parse_time_to_minutes,
        _keep_bridge_block,
        PLAN_START_HOUR,
        BRIDGE_KEEP_BEFORE_HOUR,
    )
    PARSERS_AVAILABLE = True
except Exception as e:
    PARSERS_AVAILABLE = False
    PARSERS_ERROR = str(e)

try:
    from xu_ly_config import _norm_upper
    XU_LY_CONFIG_AVAILABLE = True
except Exception as e:
    XU_LY_CONFIG_AVAILABLE = False


skip_parsers = pytest.mark.skipif(
    not PARSERS_AVAILABLE,
    reason=f"emr_parsers không import được: {PARSERS_ERROR if not PARSERS_AVAILABLE else ''}",
)
skip_config = pytest.mark.skipif(
    not XU_LY_CONFIG_AVAILABLE,
    reason="xu_ly_config không import được",
)


# ── Test parse giờ ────────────────────────────────────────────────────────────

@skip_parsers
class TestParseTime:

    @pytest.mark.parametrize("raw,expected_h,expected_m", [
        ("08:00",   8,   0),
        ("8:30",    8,  30),
        ("22:15",  22,  15),
        ("05:00",   5,   0),
        ("00:00",   0,   0),
        ("23:59",  23,  59),
        ("6h30",    6,  30),
        ("6 giờ",   6,   0),
        ("6giờ30",  6,  30),
    ])
    def test_parse_gio_hop_le(self, raw, expected_h, expected_m):
        result = _parse_time_to_minutes(raw)
        assert result is not None, f"Không parse được: {raw!r}"
        assert result == expected_h * 60 + expected_m, \
            f"Sai: {raw!r} → {result} phút, mong đợi {expected_h * 60 + expected_m}"

    @pytest.mark.parametrize("raw", [
        "", None, "abc", "25:00", "08:60", "không có giờ",
    ])
    def test_parse_gio_khong_hop_le(self, raw):
        result = _parse_time_to_minutes(raw)
        assert result is None, f"Phải trả None cho: {raw!r}, nhưng nhận: {result}"


# ── Test hằng số nghiệp vụ ────────────────────────────────────────────────────

@skip_parsers
class TestHangSoNghiepVu:

    def test_plan_start_hour(self):
        """Dự trù bắt đầu từ 05:00 — nếu thay đổi phải có lý do rõ ràng."""
        assert PLAN_START_HOUR == 5, \
            f"PLAN_START_HOUR thay đổi thành {PLAN_START_HOUR}, kiểm tra lại logic lọc y lệnh đêm"

    def test_bridge_keep_before_hour(self):
        """Ca bridge giữ y lệnh trước 07:00 của ngày sau."""
        assert BRIDGE_KEEP_BEFORE_HOUR == 7, \
            f"BRIDGE_KEEP_BEFORE_HOUR = {BRIDGE_KEEP_BEFORE_HOUR}, kiểm tra lại logic ngày tiếp theo"


# ── Test logic ngày bridge (ngày mai trước 07:00) ─────────────────────────────

@skip_parsers
class TestNgayBridge:

    def test_5h_thuoc_ngay_mai_nen_giu(self):
        """
        Y lệnh 05:00 ngày mai = thuộc ca đêm hiện tại → phải GIỮ.
        Kiểm tra bằng hằng số: 5*60 < BRIDGE_KEEP_BEFORE_HOUR*60
        """
        gio_minutes = 5 * 60  # 05:00
        bridge_limit = BRIDGE_KEEP_BEFORE_HOUR * 60
        assert gio_minutes < bridge_limit, \
            "05:00 phải nhỏ hơn giới hạn bridge (07:00)"

    def test_9h_thuoc_ngay_mai_nen_loai(self):
        """
        Y lệnh 09:00 ngày mai = không thuộc ca đêm → phải LOẠI.
        """
        gio_minutes = 9 * 60  # 09:00
        bridge_limit = BRIDGE_KEEP_BEFORE_HOUR * 60
        assert gio_minutes >= bridge_limit, \
            "09:00 phải lớn hơn hoặc bằng giới hạn bridge (07:00)"

    def test_7h_chinh_xac_la_ranh_gioi(self):
        """07:00 chính xác là ranh giới — nên LOẠI (không thuộc ca đêm)."""
        gio_minutes = 7 * 60
        bridge_limit = BRIDGE_KEEP_BEFORE_HOUR * 60
        assert gio_minutes >= bridge_limit, \
            "07:00 phải được coi là không thuộc ca đêm (loại khỏi bridge)"

    def test_659_thuoc_ca_dem(self):
        """06:59 vẫn thuộc ca đêm — phải GIỮ."""
        gio_minutes = 6 * 60 + 59
        bridge_limit = BRIDGE_KEEP_BEFORE_HOUR * 60
        assert gio_minutes < bridge_limit, "06:59 phải thuộc ca đêm (giữ lại)"


# ── Test normalize text ───────────────────────────────────────────────────────

@skip_config
class TestNormUpper:

    @pytest.mark.parametrize("inp,expected_contains", [
        ("natri clorid",        "NATRI CLORID"),
        ("NATRI CLORID",        "NATRI CLORID"),
        ("Paracetamol 500mg",   "PARACETAMOL 500MG"),
        # _norm_upper chỉ uppercase + chuẩn hoá unicode, KHÔNG bỏ dấu tiếng Việt.
        # "nước cất pha tiêm" → "NƯỚC CẤT PHA TIÊM" (giữ nguyên dấu)
        ("nước cất pha tiêm",   "NƯỚC CẤT PHA TIÊM"),
    ])
    def test_norm_upper_co_ban(self, inp, expected_contains):
        result = _norm_upper(inp)
        assert expected_contains in result, \
            f"_norm_upper({inp!r}) = {result!r}, không chứa {expected_contains!r}"


@skip_parsers
class TestBridgeBlockFiltering:

    def test_header_5h_thuc_hien_5h_giu(self):
        assert _keep_bridge_block(
            "05:00",
            "PARACETAMOL 1G x 1\nTruyền tĩnh mạch (5 giờ).",
            "",
        )

    def test_header_5h_nhung_thuc_hien_8h_loai(self):
        assert not _keep_bridge_block(
            "05:00",
            "PARACETAMOL 1G x 1\nTruyền tĩnh mạch (8 giờ).",
            "",
        )

    def test_header_8h_ngay_mai_loai(self):
        assert not _keep_bridge_block(
            "08:00",
            "PARACETAMOL 1G x 1\nTruyền tĩnh mạch.",
            "",
        )

    def test_header_6h_khong_co_gio_ro_giu(self):
        assert _keep_bridge_block(
            "06:00",
            "Dự trù thuốc theo y lệnh.",
            "",
        )
