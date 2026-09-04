# -*- coding: utf-8 -*-
"""xu_ly.py — Entry point xử lý phân loại thuốc / dịch truyền.

File này chỉ còn nhiệm vụ điều phối:
  1) đọc KetQua_YLenh.json
  2) gọi patient_day_builder để parse/gom dữ liệu
  3) chạy sanity_check để cảnh báo ca nghi rơi thuốc/chỉ định
  4) ghi DuLieu_PhanLoai.json

Logic nghiệp vụ chính đã tách vào worker/processing/*.py.
"""

import glob
import json
import os

from runtime_logging import get_worker_logger
from xu_ly_config import CONFIG_FILE, DEFAULT_INPUT_FILE, OUTPUT_FILE
from processing.patient_day_builder import build_patient_day_records
from processing.validators.sanity_check import run_sanity_checks, write_sanity_report, attach_warnings_to_records
from runtime_data_v2 import write_json_compact, generate_runtime_v2_files

LOG = get_worker_logger('xu_ly')


def process_all(INPUT_FILE, output_file: str = OUTPUT_FILE):
    if not os.path.exists(INPUT_FILE):
        LOG.error("Input file không tồn tại: %s", INPUT_FILE)
        return

    LOG.info("Bắt đầu xử lý phân loại: input=%s output=%s", INPUT_FILE, output_file)
    with open(INPUT_FILE, 'r', encoding='utf-8') as f:
        data = json.load(f)

    final_data = build_patient_day_records(data)
    warnings = run_sanity_checks(final_data)
    final_data = attach_warnings_to_records(final_data, warnings)
    warnings_file = write_sanity_report(warnings, output_file, input_file=INPUT_FILE)

    write_json_compact(output_file, final_data)
    try:
        generate_runtime_v2_files(
            os.getcwd(),
            orders_path=INPUT_FILE,
            classified_path=output_file,
            warnings_path=warnings_file,
        )
    except Exception as exc:
        LOG.warning("Không sinh được data v2 sau xử lý: %s", exc)

    LOG.info("Hoàn tất xử lý phân loại: %s records -> %s", len(final_data), output_file)
    if warnings:
        LOG.warning("Có %s cảnh báo sanity-check -> %s", len(warnings), warnings_file)
        print(f"⚠️ Có {len(warnings)} cảnh báo sau xử lý. Xem file: {warnings_file}")
    print(f"✅ Hoàn tất xử lý phân loại: {len(final_data)} hồ sơ -> {output_file}")


def tim_file_json_moi_nhat():
    danh_sach_file = glob.glob('*.json')
    if not danh_sach_file:
        return None

    exclude = {os.path.basename(CONFIG_FILE), OUTPUT_FILE, 'd_v2.json'}
    filtered = []
    for fp in danh_sach_file:
        if fp in exclude:
            continue
        if fp.startswith('data_phan_loai_chuan_'):
            continue
        if fp.endswith('_warnings.json'):
            continue
        filtered.append(fp)

    if not filtered:
        return None

    return max(filtered, key=os.path.getmtime)


if __name__ == "__main__":
    input_file = DEFAULT_INPUT_FILE

    if not os.path.exists(input_file):
        print(f"❌ Không tìm thấy file input: {input_file}")
        print("   (Hãy đặt KetQua_YLenh.json cùng thư mục với script hoặc chỉnh DEFAULT_INPUT_FILE)")
        input_file = tim_file_json_moi_nhat()
        if input_file:
            print(f"⚠️ Tạm dùng file JSON mới nhất: {input_file}")

    process_all(input_file)
