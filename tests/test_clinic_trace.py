# -*- coding: utf-8 -*-
"""worker/clinic_monitor.py — nhật ký quét: ghi từng bước (đọc trang, mở màn khám vì sao), không họ tên / mã BN."""
import json
import os
import sys
from datetime import date

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
WORKER = os.path.join(ROOT, 'worker')
if WORKER not in sys.path:
    sys.path.insert(0, WORKER)

import clinic_monitor as cm  # noqa: E402
from test_clinic_monitor import BHYT, FakeDriver, _row, _table_total  # noqa: E402


def _lines(path):
    files = sorted(p for p in os.listdir(path) if p.startswith('clinic_trace_'))
    assert len(files) == 1
    with open(os.path.join(path, files[0]), encoding='utf-8') as f:
        return [json.loads(line) for line in f]


def test_trace_records_pages_and_exam_opens_without_names(tmp_path):
    cm.set_trace_dir(str(tmp_path))
    try:
        a = _row('a', 1, '<a>NGUYEN VAN A</a>', BHYT, 'Đang thực hiện', '', 'Cho về')
        b = _row('b', 2, '<a>TRAN THI B</a>', BHYT, 'Đang thực hiện', '', 'Cho về')
        p1 = _table_total(a, pages=2, shown=1, total=2)
        p2 = _table_total(b, pages=2, shown=1, total=2)
        rows = cm.fetch_today_rows(FakeDriver([{'ok': True, 'html': p1}, {'ok': True, 'html': p1}, {'ok': True, 'html': p2}]))

        mon = cm.Monitor({}, 'https://emr/list', True)
        mon.driver = FakeDriver([])
        mon._on_exam_page = lambda row, action, need, now: {'status': 'no_drug', 'message': 'Chưa có thuốc'}

        def run_completions():
            return mon.on_exam_page(rows[0], lambda *a: {})
        run_completions()
        lines = _lines(str(tmp_path))
    finally:
        cm.set_trace_dir(None)

    read = lines[0]
    assert read['su_kien'] == 'doc_danh_sach' and read['tong_so_emr'] == 2 and read['doc_duoc'] == 2
    assert [(t['page'], t['so_dong'], t['moi']) for t in read['trang']] == [(0, 1, 1), (1, 1, 0), (2, 1, 1)]
    opened = lines[1]
    assert opened['su_kien'] == 'mo_man_kham' and opened['ly_do'] == 'chuẩn bị hoàn tất'
    assert opened['stt'] == '1' and opened['ket_qua'] == 'no_drug' and len(opened['ref']) == 8
    text = json.dumps(lines, ensure_ascii=False)
    assert 'NGUYEN' not in text and 'TRAN' not in text and '99000001' not in text


def test_trace_keeps_only_recent_days(tmp_path):
    for day in ('20261001', '20261006', '20261012'):
        (tmp_path / f'clinic_trace_{day}.jsonl').write_text('{}\n', encoding='utf-8')
    (tmp_path / 'other.jsonl').write_text('', encoding='utf-8')
    cm.set_trace_dir(str(tmp_path), today=date(2026, 10, 12))
    cm.set_trace_dir(None)
    assert sorted(os.listdir(tmp_path)) == ['clinic_trace_20261006.jsonl', 'clinic_trace_20261012.jsonl', 'other.jsonl']
