# -*- coding: utf-8 -*-
"""
worker/post_process.py
Wrapper gọi xu_ly.process_all với đường dẫn I/O đúng.
Logic xử lý thực tế nằm trong worker/xu_ly.py.
"""
import json
import os
import re
import sys

_HERE    = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
try:
    from data_contract import CANONICAL_RUNTIME_FILES, first_existing_runtime_file, build_manifest
    from runtime_data_v2 import write_json_compact, generate_runtime_v2_files
except Exception:  # pragma: no cover
    CANONICAL_RUNTIME_FILES = {"orders": "KetQua_YLenh.json", "classified": "DuLieu_PhanLoai.json"}
    def first_existing_runtime_file(root_dir, logical_name):
        fallback = "KetQua_YLenh.json" if logical_name == "orders" else "DuLieu_PhanLoai.json"
        p = os.path.join(root_dir, fallback)
        return p if os.path.exists(p) else None
    def build_manifest(root_dir):
        return {"schema": "legacy", "files": {}}
    def write_json_compact(path, value):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(value, f, ensure_ascii=False, separators=(",", ":"))
    def generate_runtime_v2_files(*args, **kwargs):
        return {}

IN_PATH  = os.environ.get("INPUT_PATH") or first_existing_runtime_file(os.getcwd(), "orders") or os.path.join(os.getcwd(), "KetQua_YLenh.json")
OUT_PATH = os.environ.get("OUTPUT_PATH") or os.path.join(os.getcwd(), CANONICAL_RUNTIME_FILES.get("classified", "DuLieu_PhanLoai.json"))

# ── Các chuỗi thay thế display-text cho data cũ ──────────────────────────────

_TEXT_FIXES = [
    # "phúth" → "phút": lỗi thừa 'h' do regex cũ xử lý "g/ph" → "giọt/phút" + h thừa
    (re.compile(r'phúth\b'), 'phút'),
]

def _fix_string(s: str) -> str:
    for pattern, replacement in _TEXT_FIXES:
        s = pattern.sub(replacement, s)
    return s

def _fix_record(obj):
    """Đệ quy qua toàn bộ record và sửa chuỗi văn bản."""
    if isinstance(obj, str):
        return _fix_string(obj)
    if isinstance(obj, list):
        return [_fix_record(x) for x in obj]
    if isinstance(obj, dict):
        return {k: _fix_record(v) for k, v in obj.items()}
    return obj

def cleanup_display_text(data: list) -> tuple[list, int]:
    """Sửa lỗi display-text trong data đã xử lý. Trả về (data đã sửa, số record bị ảnh hưởng)."""
    fixed = 0
    result = []
    for record in data:
        original = json.dumps(record, ensure_ascii=False)
        cleaned  = _fix_record(record)
        if json.dumps(cleaned, ensure_ascii=False) != original:
            fixed += 1
        result.append(cleaned)
    return result, fixed

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    if not os.path.exists(IN_PATH):
        print(f"ERROR: Không tìm thấy {IN_PATH}"); return 2

    if _HERE not in sys.path:
        sys.path.insert(0, _HERE)

    try:
        from xu_ly import process_all
    except ImportError as e:
        print(f"ERROR: Không import được xu_ly: {e}"); return 2

    # 1. Phân loại thuốc / dịch truyền (logic chính)
    os.makedirs(os.path.dirname(OUT_PATH) or '.', exist_ok=True)
    process_all(IN_PATH, output_file=OUT_PATH)

    # 2. Cleanup display-text trong output (sửa lỗi đánh máy tích lũy từ data cũ)
    if os.path.exists(OUT_PATH):
        try:
            with open(OUT_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, list):
                data, fixed = cleanup_display_text(data)
                if fixed:
                    write_json_compact(OUT_PATH, data)
                    print(f"[CLEANUP] Đã sửa lỗi display-text trong {fixed} record(s).")
        except Exception as e:
            print(f"[WARN] Không cleanup được display-text: {e}")

    try:
        warnings_path = os.path.splitext(OUT_PATH)[0] + '_warnings.json'
        generate_runtime_v2_files(os.getcwd(), orders_path=IN_PATH, classified_path=OUT_PATH, warnings_path=warnings_path)
    except Exception as e:
        print(f"[WARN] Không sinh được data v2: {e}")

    return 0

if __name__ == "__main__":
    raise SystemExit(main())
