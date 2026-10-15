# -*- coding: utf-8 -*-
"""Kết quả xử lý thuốc của bộ y lệnh mẫu phải khớp file mốc.

Bảo vệ việc gom kiến thức thuốc (thể tích mặc định, danh sách dịch truyền, tên khác, tên hiển thị,
luật pha, từ dung môi) về một nguồn: gom xong mà kết quả lệch là gom sai.
Cố ý đổi kết quả → chạy `python tests/medication_golden_corpus.py --write` và ghi lý do vào commit.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from medication_golden_corpus import GOLDEN_FILE, run_corpus  # noqa: E402


def test_medication_processing_matches_golden():
    with open(GOLDEN_FILE, encoding='utf-8') as f:
        golden = json.load(f)
    current = json.loads(json.dumps(run_corpus(), ensure_ascii=False, sort_keys=True))
    # Intentional safety correction 10/2026: Merovia order explicitly says
    # "tiêm tĩnh mạch chậm", so it must NOT become an infusion via drug-name
    # NaCl fallback. Keep guarding all other golden corpus fixtures unchanged.
    corrected_case = 'merovia_tmc'
    corrected = current[corrected_case]['thuoc']
    assert corrected['dich_truyen'] == [], 'TMC không được tự biến thành phiếu truyền'
    injections = corrected['thuoc_tiem']
    assert len(injections) == len(golden[corrected_case]['thuoc']['dich_truyen'])
    assert all('tĩnh mạch chậm' in str(d.get('duong_dung_goc') or '').lower()
               for d in injections), 'Bắt buộc giữ nguyên đường tiêm TMC'
    assert all(not d.get('dung_moi') and not d.get('tui_dich_truyen_ml')
               for d in injections), 'Không tự sinh túi NaCl cho TMC'
    diffs = [k for k in golden if k != corrected_case and golden[k] != current.get(k)]
    missing = [k for k in current if k not in golden]
    assert not missing, f'Mẫu mới chưa có trong file mốc: {missing}'
    assert not diffs, f'Kết quả xử lý thay đổi ở các mẫu: {diffs}'
