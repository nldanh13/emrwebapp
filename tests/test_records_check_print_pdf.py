# -*- coding: utf-8 -*-
"""Trả HSBA: PDF danh sách nộp hồ sơ không được hỏng khi ghi chú/tên có ký tự < > &."""

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))

import records_check_print_pdf as mod  # noqa: E402


def _make(tmp_path, rows):
    inp = tmp_path / "in.json"
    out = tmp_path / "out.pdf"
    inp.write_text(json.dumps({"title": "DANH SÁCH NỘP HỒ SƠ", "rows": rows}, ensure_ascii=False), encoding="utf-8")
    mod.make_pdf(str(inp), str(out))
    return out


@pytest.mark.parametrize("note", ["<i>", "Nợ KQ <b chưa có", "KSĐ & GPB <br", "<para>"])
def test_ky_tu_dac_biet_trong_ghi_chu_khong_lam_hong_pdf(tmp_path, note):
    out = _make(tmp_path, [{"ho_ten": "Bệnh nhân <A> & B", "so_luu_tru": "26/9370/BT", "cover_note": note, "delivered_by": "Lan <ĐD>"}])
    assert out.read_bytes().startswith(b"%PDF")


def test_hang_binh_thuong_van_in_duoc(tmp_path):
    out = _make(tmp_path, [{"ho_ten": "Nguyễn Văn A", "so_luu_tru": "26/9370/BT", "xq": 1, "cover_note": "Nợ KQ CT"}])
    assert out.read_bytes().startswith(b"%PDF")
