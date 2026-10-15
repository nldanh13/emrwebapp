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
    # TMC giữ một y lệnh có ba giờ; chuyển thành ba phiếu truyền từng giờ
    # chính là hồi quy cần loại bỏ, không phải điều kiện đúng của thuốc tiêm.
    assert len(injections) == 1
    assert all(hour in str(injections[0].get('duong_dung_goc') or '')
               for hour in ('8 giờ', '16 giờ', '23 giờ')), 'Không được mất lịch giờ TMC'
    assert all('tĩnh mạch chậm' in str(d.get('duong_dung_goc') or '').lower()
               for d in injections), 'Bắt buộc giữ nguyên đường tiêm TMC'
    assert all(not d.get('dung_moi') and not d.get('tui_dich_truyen_ml')
               for d in injections), 'Không tự sinh túi NaCl cho TMC'
    # Explicit safety correction: ten historical golden cases relied on an
    # invented 30 drops/minute, subsequently fabricating scheduled timestamps.
    # Preserve the medicine identity/diluent/volume and all other categories,
    # but require the new results to remain UNSCHEDULED pending real order rate.
    cases_without_verified_rate = {
        'acupan', 'albumin', 'colistimed', 'colistin', 'levo_no_vol',
        'merovia', 'nacl_pha_two', 'tazobactam_only', 'tazocin', 'vecmid',
    }
    for case in cases_without_verified_rate:
        old = golden[case]
        actual = current[case]
        assert {k: v for k, v in actual.items() if k != 'thuoc'} == {
            k: v for k, v in old.items() if k != 'thuoc'
        }, f'{case}: changed data beyond medication schedule'
        assert {k: v for k, v in actual['thuoc'].items() if k != 'dich_truyen'} == {
            k: v for k, v in old['thuoc'].items() if k != 'dich_truyen'
        }, f'{case}: unexpectedly changed non-infusion medication'
        previous = old['thuoc']['dich_truyen']
        updated = actual['thuoc']['dich_truyen']
        assert previous and updated, f'{case}: accidentally dropped an infusion'
        for field in ('ten_thuoc', 'the_tich', 'dung_moi', 'duong_dung'):
            old_values = {str(row.get(field, '')) for row in previous}
            new_values = {str(row.get(field, '')) for row in updated}
            assert old_values == new_values, f'{case}: changed {field} instead of only removing guessed rate'
        assert all(row.get('missing_infusion_rate') is True for row in updated), (
            f'{case}: missing-rate infusions must require review'
        )
        assert all(not row.get('tg_bat_dau') and not row.get('tg_ket_thuc') for row in updated), (
            f'{case}: never invent start/end times without verified rate'
        )
        assert all(str(row.get('toc_do') or '') in ('', '0') for row in updated), (
            f'{case}: invalid old 30 drops/minute fallback still present'
        )
    allowed = cases_without_verified_rate | {corrected_case}
    diffs = [k for k in golden if k not in allowed and golden[k] != current.get(k)]
    missing = [k for k in current if k not in golden]
    assert not missing, f'Mẫu mới chưa có trong file mốc: {missing}'
    assert not diffs, f'Kết quả xử lý thay đổi ở các mẫu ngoài phạm vi an toàn: {diffs}'
