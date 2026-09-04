# -*- coding: utf-8 -*-
"""
tests/conftest.py — Fixtures dùng chung cho toàn bộ test suite.
Chạy: python -m pytest tests/ -v
"""
import sys
import os
import pytest

# Đảm bảo cả project root và worker/ importable khi chạy bằng `python -m pytest` lẫn `pytest`.
ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
WORKER_DIR = os.path.join(ROOT_DIR, 'worker')
for path_item in (ROOT_DIR, WORKER_DIR):
    if path_item not in sys.path:
        sys.path.insert(0, path_item)


# ── Helpers tạo record Y lệnh thô ────────────────────────────────────────────

def make_record(ma_bn="TEST001", ngay_lam="26/04/2026", y_lenh="", dien_bien="", **kwargs):
    """Tạo record KetQua_YLenh đơn giản để dùng trong test."""
    return {
        "Mã BN":         ma_bn,
        "Họ tên":        kwargs.get("ho_ten", "BỆNH NHÂN TEST"),
        "Bác sĩ":        kwargs.get("bac_si", "Bác Sĩ Test"),
        "Chẩn đoán":     kwargs.get("chan_doan", "Chẩn đoán test"),
        "T/G vào":       kwargs.get("tg_vao", "08:00 24/04/2026"),
        "Khoa chuyển đến": kwargs.get("khoa", ""),
        "Xử trí":        kwargs.get("xu_tri", ""),
        "Vi_Tri":        kwargs.get("vi_tri", "P01-G1"),
        "ngay_lam":      ngay_lam,
        "Y lệnh":        y_lenh,
        "Diễn biến":     dien_bien,
    }


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture
def record_empty():
    """BN không có Y lệnh."""
    return make_record(y_lenh="", dien_bien="")


@pytest.fixture
def record_thuoc_uong():
    """BN có thuốc uống đơn giản."""
    return make_record(
        ma_bn="TEST001",
        y_lenh=(
            "08:00 | Bác sĩ: Bác Sĩ Test\n"
            "+ Thuốc:\n"
            "AMOXICILLIN 500MG (Amoxicillin) x 2 (Viên)\n"
            "Uống, 2 lần/ngày, sáng 1 viên, chiều 1 viên (8 giờ, 14 giờ).\n"
        ),
        dien_bien="08:00 | Bác sĩ: Bác Sĩ Test\nBệnh nhân tỉnh\nTiếp xúc tốt\n",
    )


@pytest.fixture
def record_dich_truyen():
    """BN có dịch truyền TTM."""
    return make_record(
        ma_bn="TEST002",
        y_lenh=(
            "08:00 | Bác sĩ: Bác Sĩ Test\n"
            "+ Thuốc:\n"
            "NATRI CLORID 0.9% 500ML (Sodium chloride) x 2 (Chai)\n"
            "Truyền tĩnh mạch, 40 giọt/phút, sáng 1 chai, chiều 1 chai (8 giờ, 14 giờ).\n"
        ),
        dien_bien="08:00 | Bác sĩ: Bác Sĩ Test\nBệnh nhân tỉnh\n",
    )


@pytest.fixture
def record_thuoc_tiem():
    """BN có thuốc tiêm."""
    return make_record(
        ma_bn="TEST003",
        y_lenh=(
            "08:00 | Bác sĩ: Bác Sĩ Test\n"
            "+ Thuốc:\n"
            "CEFTRIAXONE 1G (Ceftriaxone) x 2 (Lọ)\n"
            "Tiêm mạch chậm, 1 ngày, sáng 1 lọ, tối 1 lọ (8 giờ, 20 giờ).\n"
        ),
        dien_bien="08:00 | Bác sĩ: Bác Sĩ Test\nBệnh nhân tỉnh\n",
    )


@pytest.fixture
def record_thuoc_them():
    """BN có Y lệnh thêm (thêm thuốc sau ca trực, mốc giờ >= 07:00)."""
    return make_record(
        ma_bn="TEST004",
        y_lenh=(
            "05:30 | Bác sĩ: Bác Sĩ Đêm\n"           # dự trù — trước 07:00
            "+ Thuốc:\n"
            "PARACETAMOL 500MG x 1 (Viên)\n"
            "Uống, sáng 1 viên (8 giờ).\n"
            "---\n"
            "09:15 | Bác sĩ: Bác Sĩ Test\n"           # thêm — sau 07:00
            "+ Thuốc:\n"
            "IBUPROFEN 400MG x 1 (Viên)\n"
            "Uống, trưa 1 viên (12 giờ).\n"
        ),
        dien_bien="",
    )


@pytest.fixture
def record_ngay_mai_truoc_7h():
    """
    BN có Y lệnh dự trù ngày mai trước 07:00 (thuộc ca đêm hiện tại).
    ngay_lam = ngày mai, giờ y lệnh 05:00 → nên GIỮ lại.
    """
    return make_record(
        ma_bn="TEST005",
        ngay_lam="29/04/2026",   # ngày mai
        y_lenh=(
            "05:00 | Bác sĩ: Bác Sĩ Đêm\n"
            "+ Thuốc:\n"
            "MORPHIN 10MG x 1 (Ống)\n"
            "Tiêm dưới da, 1 lần (5 giờ).\n"
        ),
        dien_bien="",
    )


@pytest.fixture
def record_ngay_mai_sau_7h():
    """
    BN có Y lệnh ngày mai sau 07:00 (không thuộc ca đêm hiện tại).
    ngay_lam = ngày mai, giờ y lệnh 09:00 → nên LOẠI ra.
    """
    return make_record(
        ma_bn="TEST006",
        ngay_lam="29/04/2026",
        y_lenh=(
            "09:00 | Bác sĩ: Bác Sĩ Sáng\n"
            "+ Thuốc:\n"
            "VITAMIN C 500MG x 1 (Viên)\n"
            "Uống, sáng 1 viên (9 giờ).\n"
        ),
        dien_bien="",
    )


@pytest.fixture
def record_nhieu_ngay():
    """Nhiều record của cùng 1 BN, qua 3 ngày."""
    return [
        make_record(
            ma_bn="TEST007", ngay_lam="26/04/2026",
            y_lenh=(
                "08:00 | Bác sĩ: BS Test\n+ Thuốc:\n"
                "CEFTRIAXONE 1G x 2 (Lọ)\nTiêm, 2 lần, sáng 1 lọ, tối 1 lọ.\n"
            ),
        ),
        make_record(
            ma_bn="TEST007", ngay_lam="27/04/2026",
            y_lenh=(
                "08:00 | Bác sĩ: BS Test\n+ Thuốc:\n"
                "CEFTRIAXONE 1G x 2 (Lọ)\nTiêm, 2 lần, sáng 1 lọ, tối 1 lọ.\n"
                "METRONIDAZOL 500MG/100ML x 1 (Chai)\nTruyền TM, 1 lần, sáng 1 chai (8 giờ).\n"
            ),
        ),
        make_record(
            ma_bn="TEST007", ngay_lam="28/04/2026",
            y_lenh=(
                "08:00 | Bác sĩ: BS Test\n+ Thuốc:\n"
                "CEFTRIAXONE 1G x 2 (Lọ)\nTiêm, 2 lần, sáng 1 lọ, tối 1 lọ.\n"
            ),
        ),
    ]
