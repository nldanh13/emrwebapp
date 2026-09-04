# -*- coding: utf-8 -*-
"""
tests/test_server_validation.py — Test validation logic phía server (Node.js).

Thay vì chạy Node, ta kiểm tra bằng Python các rule tương đương.
Mục tiêu: đảm bảo format bundle import, board data và done-key không thay đổi
âm thầm khi sửa code.

Chạy: python -m pytest tests/test_server_validation.py -v
"""
import pytest


# ── Helpers (re-implement logic từ server/utils/validation.js) ─────────────────

def is_valid_dmy(s: str) -> bool:
    """Port logic isValidDmy từ validation.js."""
    import re
    from datetime import date
    m = re.match(r'^(\d{1,2})/(\d{1,2})/(\d{4})$', str(s or '').strip())
    if not m:
        return False
    dd, mm, yyyy = int(m[1]), int(m[2]), int(m[3])
    if yyyy < 2000 or yyyy > 2100:
        return False
    if mm < 1 or mm > 12:
        return False
    try:
        date(yyyy, mm, dd)
        return True
    except ValueError:
        return False


def normalize_dmy(raw) -> str:
    import re
    text = str(raw or '').strip()
    if not text:
        return ''
    m = re.match(r'^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$', text)
    if m:
        return f"{int(m[3]):02d}/{int(m[2]):02d}/{int(m[1]):04d}"
    m = re.match(r'^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$', text)
    if m:
        y = int(m[3]) + (2000 if int(m[3]) < 100 else 0)
        return f"{int(m[1]):02d}/{int(m[2]):02d}/{y:04d}"
    return ''


def done_key(ma_bn: str, ngay_lam: str) -> str:
    """Port logic doneKey từ validation.js."""
    clean_id = str(ma_bn or '').strip()
    dmy = normalize_dmy(ngay_lam)
    if dmy:
        dd, mm, yyyy = dmy.split('/')
        return f"{clean_id}::{yyyy}-{mm}-{dd}"
    clean_date = str(ngay_lam or '').strip()
    return f"{clean_id}::{clean_date}" if clean_date else clean_id


def sanitize_session_id(raw) -> str:
    text = str(raw or '').strip()
    if not text:
        return 'default'
    if '/' in text or '\\' in text or '..' in text:
        return 'default'
    import re
    sanitized = re.sub(r'[^a-zA-Z0-9_-]', '', text)[:60]
    if not sanitized:
        return 'default'
    return sanitized


VALID_BUNDLE_KEYS = {'DuLieu_PhanLoai.json', 'KetQua_YLenh.json', 'data_sorted.json'}


def validate_bundle(bundle) -> str | None:
    """Port logic validateBundle từ data_transfer.js. Trả về chuỗi lỗi hoặc None."""
    if not isinstance(bundle, dict):
        return '"bundle" phải là object JSON.'
    if not bundle:
        return '"bundle" rỗng.'
    for k, v in bundle.items():
        if k not in VALID_BUNDLE_KEYS:
            return f'Khóa không hợp lệ: "{k}".'
        if v is None or not isinstance(v, (dict, list)):
            return f'"{k}" phải là object hoặc array.'
    return None


def validate_board_row(row, idx: int) -> str | None:
    """Port logic validate từ board.js."""
    if not isinstance(row, dict):
        return f"Dòng {idx}: không phải object hợp lệ."
    ma_bn = str(row.get('Mã BN') or row.get('ma_bn') or
                row.get('Mã YT') or row.get('ma_yt') or '').strip()
    if not ma_bn:
        return f"Dòng {idx}: thiếu mã bệnh nhân (ma_bn)."
    return None


# ── Test isValidDmy ────────────────────────────────────────────────────────────

class TestIsValidDmy:

    @pytest.mark.parametrize("s", [
        "01/01/2026", "28/04/2026", "29/02/2028",  # năm nhuận
        "31/12/2025", "1/1/2026",
    ])
    def test_hop_le(self, s):
        assert is_valid_dmy(s), f"Phải hợp lệ: {s!r}"

    @pytest.mark.parametrize("s", [
        "", None, "32/01/2026", "00/01/2026", "29/02/2026",  # 2026 không nhuận
        "01/13/2026", "01-01-2026", "2026/01/01", "abc",
        "01/01/1999",  # năm < 2000
        "01/01/2101",  # năm > 2100
    ])
    def test_khong_hop_le(self, s):
        assert not is_valid_dmy(s), f"Phải không hợp lệ: {s!r}"


# ── Test doneKey ───────────────────────────────────────────────────────────────

class TestDoneKey:

    def test_format_chuan(self):
        assert done_key("99049739", "26/04/2026") == "99049739::2026-04-26"

    def test_khong_co_ngay(self):
        """Nếu không có ngày → chỉ trả ma_bn."""
        assert done_key("99049739", "") == "99049739"
        assert done_key("99049739", None) == "99049739"

    def test_strip_spaces(self):
        """Khoảng trắng thừa phải bị strip."""
        assert done_key("  99049739  ", "  26/04/2026  ") == "99049739::2026-04-26"

    def test_khong_duoc_nham_key(self):
        """Hai BN khác ngày phải có key khác nhau."""
        k1 = done_key("99049739", "26/04/2026")
        k2 = done_key("99049739", "27/04/2026")
        assert k1 != k2

    def test_khong_duoc_nham_bn(self):
        """Hai BN khác nhau cùng ngày phải có key khác nhau."""
        k1 = done_key("99049739", "26/04/2026")
        k2 = done_key("99049740", "26/04/2026")
        assert k1 != k2


# ── Test validateBundle ────────────────────────────────────────────────────────

class TestValidateBundle:

    def test_bundle_hop_le(self):
        bundle = {
            'DuLieu_PhanLoai.json': [{'ma_bn': '001'}],
            'data_sorted.json':     [{'ma_bn': '001'}],
        }
        assert validate_bundle(bundle) is None

    def test_bundle_rong(self):
        assert validate_bundle({}) is not None

    def test_bundle_khong_phai_dict(self):
        assert validate_bundle([]) is not None
        assert validate_bundle("string") is not None
        assert validate_bundle(None) is not None

    def test_bundle_key_khong_hop_le(self):
        bundle = {'file_la.json': []}
        err = validate_bundle(bundle)
        assert err is not None
        assert 'file_la.json' in err

    def test_bundle_value_khong_phai_object(self):
        bundle = {'DuLieu_PhanLoai.json': "string không hợp lệ"}
        err = validate_bundle(bundle)
        assert err is not None


# ── Test validateBoardRow ──────────────────────────────────────────────────────

class TestValidateBoardRow:

    def test_row_hop_le_ma_bn(self):
        assert validate_board_row({'ma_bn': '001', 'Vi_Tri': 'P01-G1'}, 0) is None

    def test_row_hop_le_Ma_BN(self):
        assert validate_board_row({'Mã BN': '001'}, 0) is None

    def test_row_thieu_ma_bn(self):
        err = validate_board_row({'Vi_Tri': 'P01-G1'}, 0)
        assert err is not None
        assert 'ma_bn' in err

    def test_row_khong_phai_dict(self):
        err = validate_board_row("string", 0)
        assert err is not None

    def test_row_ma_bn_rong(self):
        err = validate_board_row({'ma_bn': '   '}, 0)
        assert err is not None


class TestSanitizeSessionId:

    def test_empty_default(self):
        assert sanitize_session_id("") == "default"

    def test_valid_session_id(self):
        assert sanitize_session_id("shift_2026_A") == "shift_2026_A"

    def test_path_traversal_removed_to_default(self):
        assert sanitize_session_id("../../secret") == "default"
        assert sanitize_session_id("..") == "default"

    def test_slashes_are_rejected(self):
        assert sanitize_session_id("abc/def") == "default"
