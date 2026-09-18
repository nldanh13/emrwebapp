# -*- coding: utf-8 -*-
"""parse_bhxh_sick_leave_list.py — Đọc file .xlsx BHXH gửi để rà soát nghỉ ốm/ra viện.

File nguồn có 2 sheet cố định:
  - "Ngoại trú": GIẤY NGHỈ HƯỞNG BHXH, lọc theo cột "Người hành nghề".
  - "Nội trú":   GIẤY RA VIỆN, lọc theo cột "Trưởng khoa".

Không giả định số cột/thứ tự cột cố định — dò dòng tiêu đề bằng cách tìm dòng
có ô đầu tiên là "Dòng nguồn" (đúng cấu trúc cả 2 sheet đang dùng), rồi map
tên cột tiếng Việt sang key ascii ổn định. Cột lạ không có trong map vẫn được
giữ lại (không rớt dữ liệu), chỉ tự sinh key từ tên cột.

Đọc bằng xlsx_utils (stdlib zipfile + XML), không cần cài thêm thư viện.

Dùng: python parse_bhxh_sick_leave_list.py <input.xlsx> <output.json>
"""
from __future__ import annotations

import json
import re
import sys
import unicodedata

from xlsx_utils import read_xlsx_sheets_by_name

HEADER_ANCHOR = "dong nguon"

# Tên cột tiếng Việt (đã chuẩn hoá: bỏ dấu, thường, gộp khoảng trắng) -> key ascii ổn định.
COLUMN_KEY_MAP = {
    "dong nguon": "dong_nguon",
    "bac si trong danh sach": "bac_si_trong_danh_sach",
    "so seri": "so_seri",
    "ma so bh": "ma_so_bh",
    "ma the": "ma_the",
    "ho ten": "ho_ten",
    "ngay sinh": "ngay_sinh",
    "gioi tinh": "gioi_tinh",
    "chan doan": "chan_doan",
    "ma chung tu": "ma_chung_tu",
    "mau so": "mau_so",
    "don vi": "don_vi",
    "dieu tri tu ngay": "dieu_tri_tu_ngay",
    "dieu tri den ngay": "dieu_tri_den_ngay",
    "nguoi hanh nghe": "nguoi_hanh_nghe",
    "ho ten cha": "ho_ten_cha",
    "ho ten me": "ho_ten_me",
    "ho ten me / nguoi nuoi duong": "ho_ten_me",
    "thu truong": "thu_truong",
    "ngay chung tu": "ngay_chung_tu",
    "tre em khong the": "tre_em_khong_the",
    "trang thai": "trang_thai",
    "trang thai khoa": "trang_thai_khoa",
    "trang thai yeu cau": "trang_thai_yeu_cau",
    "ghi chu bo sung": "ghi_chu_bo_sung",
    "so loi ra soat": "so_loi_ra_soat",
    "stt": "stt",
    "ma y te": "ma_y_te",
    "ma co so": "ma_co_so",
    "so luu tru": "so_luu_tru",
    "nghe nghiep": "nghe_nghiep",
    "khoa": "khoa",
    "dan toc": "dan_toc",
    "dia chi": "dia_chi",
    "phuong phap dieu tri": "phuong_phap_dieu_tri",
    "ghi chu": "ghi_chu",
    "ngay vao vien": "ngay_vao_vien",
    "ngay ra vien": "ngay_ra_vien",
    "dinh chi thai nghen": "dinh_chi_thai_nghen",
    "tuoi thai": "tuoi_thai",
    "dieu tri ngoai tru tu ngay": "dieu_tri_ngoai_tru_tu_ngay",
    "dieu tri ngoai tru den ngay": "dieu_tri_ngoai_tru_den_ngay",
    "truong khoa": "truong_khoa",
    "thu truong don vi": "thu_truong_don_vi",
}


def strip_diacritics(value: str) -> str:
    text = unicodedata.normalize("NFD", str(value or ""))
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    return text.replace("đ", "d").replace("Đ", "D")


def normalize_header(value: str) -> str:
    text = strip_diacritics(str(value or "")).lower()
    text = re.sub(r"\s+", " ", text).strip()
    return text


def slugify_unknown(value: str) -> str:
    text = normalize_header(value)
    text = re.sub(r"[^a-z0-9]+", "_", text).strip("_")
    return text or "col"


def find_header_row(matrix, max_scan=15):
    for i, row in enumerate(matrix[:max_scan]):
        first = normalize_header(row[0] if row else "")
        if first == HEADER_ANCHOR:
            return i
    return None


def parse_matrix(matrix):
    header_idx = find_header_row(matrix)
    if header_idx is None:
        return []

    header_row = matrix[header_idx]
    columns = []
    for c, raw in enumerate(header_row):
        raw = str(raw or "").strip()
        if not raw:
            continue
        norm = normalize_header(raw)
        key = COLUMN_KEY_MAP.get(norm) or slugify_unknown(raw)
        columns.append((c, key))
    if not columns:
        return []

    rows = []
    for row in matrix[header_idx + 1:]:
        if not row or not str(row[0] or "").strip():
            continue
        row_obj = {}
        for c, key in columns:
            value = row[c] if c < len(row) else ""
            value = str(value or "").strip()
            if value:
                row_obj[key] = value
        if row_obj:
            rows.append(row_obj)
    return rows


def sheet_matches(name, target):
    return normalize_header(name) == normalize_header(target)


def main():
    if len(sys.argv) < 3:
        print("Dùng: python parse_bhxh_sick_leave_list.py <input.xlsx> <output.json>", file=sys.stderr)
        sys.exit(2)
    input_path, output_path = sys.argv[1], sys.argv[2]

    try:
        sheets = read_xlsx_sheets_by_name(input_path)
    except Exception as err:  # noqa: BLE001
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump({"status": "error", "message": f"Không đọc được file Excel: {err}"}, f, ensure_ascii=False)
        sys.exit(1)

    outpatient = []
    inpatient = []
    unknown_sheets = []
    for name, matrix in sheets.items():
        if sheet_matches(name, "Ngoại trú"):
            outpatient = parse_matrix(matrix)
        elif sheet_matches(name, "Nội trú"):
            inpatient = parse_matrix(matrix)
        else:
            unknown_sheets.append(name)

    result = {
        "status": "ok",
        "outpatient": outpatient,
        "inpatient": inpatient,
        "unknown_sheets": unknown_sheets,
        "message": f"Đã đọc {len(outpatient)} dòng Ngoại trú, {len(inpatient)} dòng Nội trú.",
    }
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)


if __name__ == "__main__":
    main()
