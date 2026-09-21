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


class _FakeWS:
    """WorkerSession giả cho test: mọi lần đổi tài khoản người tạo đều thành công."""

    def __init__(self, username='acct.hientai'):
        self.config = {'username': username, 'password': 'pw'}
        self.driver = object()
        self.switch_calls = []
        self.open_care_form_calls = []

    def switch_to_creator_account(self, creator, ma_bn, allow_completed=False):
        self.switch_calls.append(('creator', creator, ma_bn, allow_completed))
        self.config = dict(self.config, username=f'acct.{creator}')
        self.driver = object()
        return True

    def switch_account(self, username, password):
        self.switch_calls.append(('account', username, password))
        self.config = dict(self.config, username=username, password=password)
        self.driver = object()
        return True

    def open_care_form(self, ma_bn, allow_completed=False):
        self.open_care_form_calls.append((ma_bn, allow_completed))

    def restore_account(self, original_username, original_password, ma_bn, allow_completed=False):
        if not original_username or self.config.get('username') == original_username:
            return
        if self.switch_account(original_username, original_password):
            self.open_care_form(ma_bn, allow_completed=allow_completed)


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

    ws = _FakeWS()
    care_cache.cleanup_cham_soc_cache(
        ws,
        'BN_TEST',
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


def test_cleanup_switches_to_creator_account_before_deleting_and_restores_after(monkeypatch):
    """EMR hiện chỉ cho đúng tài khoản người tạo phiếu tự sửa/xóa phiếu của họ.
    cleanup_cham_soc_cache phải đổi sang tài khoản người tạo của TỪNG phiếu
    trước khi xóa, rồi khôi phục lại đúng tài khoản ban đầu sau khi dọn xong."""
    import care_cache

    deleted = []
    monkeypatch.setattr(care_cache, 'delete_cham_soc_new_by_id', lambda driver, care_id: deleted.append(care_id))

    def row(time_full, care_id, creator):
        return {
            'time_full': time_full,
            'hhmm': time_full.split()[0],
            'status': 'Mới',
            'creator': creator,
            'dien_bien': 'Người bệnh tỉnh',
            'cham_soc': 'Thực hiện chỉ định thuốc',
            'id_edit': care_id,
            'id_delete': care_id,
        }

    cache = {
        '08:00 15/08/2026': [row('08:00 15/08/2026', 'A1', 'Lê Ngọc Diệu')],
        '09:00 15/08/2026': [row('09:00 15/08/2026', 'B1', 'Nguyễn Văn Bình')],
    }

    ws = _FakeWS(username='acct.goc')
    care_cache.cleanup_cham_soc_cache(
        ws, 'BN_TEST', cache, [], ['Lê Ngọc Diệu', 'Nguyễn Văn Bình'], phase='TEST',
    )

    assert set(deleted) == {'A1', 'B1'}
    creator_switches = [c[1] for c in ws.switch_calls if c[0] == 'creator']
    assert creator_switches == ['Lê Ngọc Diệu', 'Nguyễn Văn Bình']
    # Khôi phục lại đúng tài khoản gốc sau khi dọn xong.
    account_switches = [c for c in ws.switch_calls if c[0] == 'account']
    assert account_switches[-1] == ('account', 'acct.goc', 'pw')
    assert ws.open_care_form_calls[-1] == ('BN_TEST', False)


def test_cleanup_skips_delete_but_still_clears_cache_when_no_account_for_creator(monkeypatch):
    """Không tra được tài khoản EMR cho người tạo -> không xóa được trên EMR
    (bỏ qua, in cảnh báo) nhưng vẫn dọn khỏi cache nội bộ (giữ hành vi cũ)."""
    import care_cache

    deleted = []
    monkeypatch.setattr(care_cache, 'delete_cham_soc_new_by_id', lambda driver, care_id: deleted.append(care_id))

    row = {
        'time_full': '08:00 15/08/2026',
        'hhmm': '08:00',
        'status': 'Mới',
        'creator': 'Người Không Có Tài Khoản',
        'dien_bien': 'Người bệnh tỉnh',
        'cham_soc': 'Thực hiện chỉ định thuốc',
        'id_edit': 'X1',
        'id_delete': 'X1',
    }
    cache = {'08:00 15/08/2026': [row]}

    class _NoAccountWS(_FakeWS):
        def switch_to_creator_account(self, creator, ma_bn, allow_completed=False):
            self.switch_calls.append(('creator', creator, ma_bn, allow_completed))
            return False

    ws = _NoAccountWS()
    care_cache.cleanup_cham_soc_cache(
        ws, 'BN_TEST', cache, [], ['Người Không Có Tài Khoản'], phase='TEST',
    )

    assert deleted == []
    assert '08:00 15/08/2026' not in cache
