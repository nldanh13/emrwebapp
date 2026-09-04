import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
WORKER = os.path.join(ROOT, 'worker')
if WORKER not in sys.path:
    sys.path.insert(0, WORKER)


def _hang_1508_record():
    return {
        'ngay_lam': '15/08/2026',
        'ma_bn': '26066405',
        'ho_ten': 'NGUYỄN THỊ HẰNG',
        'nhap_cham_soc': {
            'dien_bien': 'ĐMMM\n---\nChuyển mổ',
            'y_lenh': '',
        },
        'thuoc': {
            'dich_truyen': [],
            'thuoc_tiem': [],
            'thuoc_uong': [],
        },
        'tong_hop_gio_dung': [],
        'chi_dinh_khac': {
            'duong_mau_mao_mach': [
                {'ten': 'Xét nghiệm đường máu mao mạch tại giường (một lần)[Nội trú]', 'gio': '05:00 15/08/2026'}
            ],
        },
        'chi_dinh_dvkt': [
            {'ten': 'Phẫu thuật lấy đĩa đệm cột sống thắt lưng qua da', 'gio': '07:00 15/08/2026'}
        ],
        'care_special_events': [],
    }


def test_hang_1508_chuyen_mo_plus_same_day_surgery_service_activates_guard():
    from surgery_guard import detect_surgery_out

    active, cutoff, reason = detect_surgery_out(_hang_1508_record())
    assert active is True
    assert cutoff is not None
    assert cutoff.strftime('%H:%M %d/%m/%Y') == '07:00 15/08/2026'
    assert 'chuyển/đi mổ' in reason


def test_surgery_plan_without_clinical_transfer_does_not_activate_guard():
    from surgery_guard import detect_surgery_out

    rec = _hang_1508_record()
    rec['nhap_cham_soc']['dien_bien'] = 'HỘI CHẨN KHOA\nDự kiến mổ'
    active, cutoff, reason = detect_surgery_out(rec)
    assert active is False
    assert cutoff is None
    assert reason == ''


def test_no_regular_signal_does_not_force_5_8_16():
    from input_care_utils import build_regular_care_hours

    hours, has_signal = build_regular_care_hours(set(), {}, {})
    assert has_signal is False
    assert hours == set()


def test_regular_medication_day_still_keeps_baseline_5_8_16():
    from input_care_utils import build_regular_care_hours

    hours, has_signal = build_regular_care_hours({20, 23}, {}, {})
    assert has_signal is True
    assert hours == {5, 8, 16, 20, 23}


def test_surgery_cleanup_removes_only_tool_rows_at_or_after_cutoff(monkeypatch):
    import care_cache

    deleted = []

    class DummyWait:
        def __init__(self, *_args, **_kwargs):
            pass
        def until(self, *_args, **_kwargs):
            return True

    class DummyEC:
        @staticmethod
        def visibility_of_element_located(_args):
            return True

    monkeypatch.setattr(care_cache, 'WebDriverWait', DummyWait)
    monkeypatch.setattr(care_cache, 'EC', DummyEC)
    monkeypatch.setattr(care_cache, 'By', type('DummyBy', (), {'ID': 'id'}))
    monkeypatch.setattr(care_cache, 'open_cham_soc_by_id', lambda driver, care_id: deleted.append(('open', care_id)))
    monkeypatch.setattr(care_cache, 'click_thu_hoi_va_xoa', lambda driver: deleted.append(('delete', None)))
    monkeypatch.setattr(care_cache, 'delete_cham_soc_new_by_id', lambda driver, care_id: deleted.append(('delete_new', care_id)))

    def row(time_full, care_id, care='Thực hiện chỉ định thuốc', creator='Lê Ngọc Diệu'):
        hhmm = time_full.split()[0]
        return {
            'time_full': time_full,
            'hhmm': hhmm,
            'status': 'Hoàn tất',
            'creator': creator,
            'dien_bien': 'Người bệnh tỉnh',
            'cham_soc': care,
            'id_edit': care_id,
            'id_delete': None,
        }

    before = row('05:00 15/08/2026', 'BEFORE')
    at_8 = row('08:00 15/08/2026', 'AT8')
    at_16 = row('16:00 15/08/2026', 'AT16', care='Lấy dấu hiệu sinh tồn')
    next_5 = row('05:00 16/08/2026', 'NEXT5', care='Lấy dấu hiệu sinh tồn')
    manual = row('10:00 15/08/2026', 'MANUAL', care='Theo dõi vết thương đặc biệt', creator='Bác Sĩ Khác')

    cache = {
        before['time_full']: [before],
        at_8['time_full']: [at_8],
        at_16['time_full']: [at_16],
        next_5['time_full']: [next_5],
        manual['time_full']: [manual],
    }

    care_cache.cleanup_cham_soc_cache(
        object(),
        cache,
        [],
        ['Lê Ngọc Diệu'],
        phase='TEST',
        remove_tool_rows_at_or_after_time_key='07:00 15/08/2026',
    )

    opened = [x[1] for x in deleted if x[0] == 'open']
    assert opened == ['AT8', 'AT16', 'NEXT5']
    assert '05:00 15/08/2026' in cache
    assert '10:00 15/08/2026' in cache
    assert '08:00 15/08/2026' not in cache
    assert '16:00 15/08/2026' not in cache
    assert '05:00 16/08/2026' not in cache


def test_final_verify_detects_tool_rows_still_left_after_surgery_cutoff():
    from care_cache import tool_rows_at_or_after

    cache = {
        '08:00 15/08/2026': [{
            'creator': 'Lê Ngọc Diệu',
            'cham_soc': 'Thực hiện chỉ định thuốc',
            'dien_bien': 'Người bệnh tỉnh',
            'id_edit': 'ROW8',
        }],
        '05:00 16/08/2026': [{
            'creator': 'Lê Ngọc Diệu',
            'cham_soc': 'Lấy dấu hiệu sinh tồn',
            'dien_bien': 'Người bệnh tỉnh',
            'id_edit': 'ROW5',
        }],
        '05:00 15/08/2026': [{
            'creator': 'Lê Ngọc Diệu',
            'cham_soc': 'Lấy dấu hiệu sinh tồn',
            'dien_bien': 'Người bệnh tỉnh',
            'id_edit': 'BEFORE',
        }],
    }
    leftovers = tool_rows_at_or_after(cache, '07:00 15/08/2026', ['Lê Ngọc Diệu'])
    assert {x['time_full'] for x in leftovers} == {'08:00 15/08/2026', '05:00 16/08/2026'}
