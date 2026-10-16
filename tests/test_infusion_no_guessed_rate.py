# -*- coding: utf-8 -*-
"""A drip rate absent from physician order must not become 30 by default."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'worker'))
from processing.infusion_scheduler import calculate_infusion_times


def _item(**patch):
    return {
        'ten_thuoc': 'TEST_INFUSION 0,5g',
        'gio_dung': '8 giờ',
        'the_tich': 100,
        'toc_do': '',
        'tui_dich_truyen_ml': 100,
        'duong_dung_goc': 'Truyền tĩnh mạch',
        **patch,
    }


def test_no_unverified_30_drops_per_minute_default():
    result = calculate_infusion_times([_item()], '15/10/2026')
    assert len(result) == 1
    assert result[0]['missing_infusion_rate'] is True
    assert result[0].get('toc_do') in ('', None)
    assert not result[0].get('tg_bat_dau')
    assert not result[0].get('tg_ket_thuc')


def test_rate_explicit_preserves_real_order_time():
    result = calculate_infusion_times([_item(toc_do='30')], '15/10/2026')
    assert len(result) == 1
    assert result[0].get('missing_infusion_rate') is not True
    assert result[0]['tg_bat_dau'] == '08:00 15/10/2026'
    assert result[0]['tg_ket_thuc']


def test_previously_inferred_rate_is_not_considered_verified():
    result = calculate_infusion_times([_item(toc_do='30', toc_do_inferred=True)], '15/10/2026')
    assert result[0]['missing_infusion_rate'] is True
    assert not result[0].get('tg_bat_dau')
