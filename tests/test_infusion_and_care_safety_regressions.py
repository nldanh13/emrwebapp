import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
WORKER = os.path.join(ROOT, 'worker')
if WORKER not in sys.path:
    sys.path.insert(0, WORKER)


def test_care_creator_only_mismatch_updates():
    from care_cache import kiem_tra_bang_cached

    time_key = '20:00 14/08/2026'
    row = {
        'status': 'Hoàn tất',
        'creator': 'Điều Dưỡng Ca Trước',
        'nt': '18',
        'temp': '37',
        'mach': '80',
        'ha': '120/80',
        'dien_bien': 'Người bệnh tỉnh, tiếp xúc tốt',
        'cham_soc': 'Thực hiện chỉ định thuốc',
        'id_edit': 'CARE_1',
    }
    status, care_id = kiem_tra_bang_cached(
        {time_key: [row]},
        time_key,
        20,
        'Thực hiện chỉ định thuốc',
        ['Điều Dưỡng Hiện Tại'],
        'Người bệnh tỉnh',
        expected_creator='Điều Dưỡng Hiện Tại',
    )
    assert (status, care_id) == ('UPDATE', 'CARE_1')


def test_care_content_mismatch_still_updates_even_when_creator_differs():
    from care_cache import kiem_tra_bang_cached

    time_key = '20:00 14/08/2026'
    row = {
        'status': 'Hoàn tất',
        'creator': 'Điều Dưỡng Ca Trước',
        'nt': '18',
        'temp': '37',
        'mach': '80',
        'ha': '120/80',
        'dien_bien': 'Người bệnh tỉnh, tiếp xúc tốt',
        'cham_soc': 'Nội dung cũ',
        'id_edit': 'CARE_2',
    }
    status, care_id = kiem_tra_bang_cached(
        {time_key: [row]},
        time_key,
        20,
        'Thực hiện chỉ định thuốc',
        ['Điều Dưỡng Hiện Tại'],
        'Người bệnh tỉnh',
        expected_creator='Điều Dưỡng Hiện Tại',
    )
    assert (status, care_id) == ('UPDATE', 'CARE_2')


def test_norm_med_key_equates_trasolu_nacl_spellings():
    from infusion_cleanup import _norm_med_key

    expected = 'TRASOLU 100mg/2ml + Natri clorid 0.9%'
    web = 'trasolu 100mg/2ml + natriclorid 0.9% 100ml'
    assert _norm_med_key(expected) == _norm_med_key(web)


def test_norm_med_key_equates_sodium_chloride_and_nacl():
    from infusion_cleanup import _norm_med_key

    assert _norm_med_key('Sodium chloride 0.9% 100ml') == _norm_med_key('NaCl 0.9%')


def test_orphan_cleanup_is_report_only_by_default(monkeypatch):
    import infusion_cleanup

    deleted_ids = []
    monkeypatch.setattr(
        infusion_cleanup,
        '_delete_record_by_id',
        lambda driver, wait, rec_id: deleted_ids.append(rec_id) or True,
    )

    records = {
        ('other drug', '10:00 14/08/2026'): [
            {
                'id': 'ROW_OLD',
                'ten': 'Thuốc do người khác nhập',
                'ten_key': 'other drug',
                'tg_bat_dau': '10:00 14/08/2026',
            }
        ]
    }
    expected = [
        {
            'Full_Name': 'PARACETAMOL 10MG/ML',
            'Search_Name': 'PARACETAMOL',
            'Time_Start_Str': '08:00 14/08/2026',
        }
    ]

    count = infusion_cleanup.xoa_dich_truyen_thua_ngoai_du_lieu(
        object(), object(), records, {'14/08/2026'}, expected
    )
    assert count == 0
    assert deleted_ids == []


def test_drug_select2_never_falls_back_to_unmatched_first_option():
    from infusion_select2 import _pick_drug_option

    dummy = object()
    rows = [
        (
            dummy,
            {
                'ten': 'BEROXIB',
                'hoat_chat': 'Celecoxib',
                'ham_luong': '200mg',
                'raw_text': '01 BEROXIB viên Celecoxib 200mg LOT123',
            },
        )
    ]
    chosen, info, score = _pick_drug_option(rows, ['Pha natriclorid'])
    assert chosen is None
    assert info == {}
    assert score == 0


def test_drug_select2_alias_matches_pha_natriclorid_to_natri_clorid():
    from infusion_select2 import _pick_drug_option

    dummy = object()
    rows = [
        (
            dummy,
            {
                'ten': 'Natri clorid 0,9%',
                'hoat_chat': 'Natri clorid',
                'ham_luong': '0,9%',
                'raw_text': 'Natri clorid 0,9% chai 100ml',
            },
        )
    ]
    chosen, info, score = _pick_drug_option(rows, ['Pha natriclorid'])
    assert chosen is dummy
    assert info['ten'] == 'Natri clorid 0,9%'
    assert score >= 70


def test_drug_selection_committed_accepts_select2_data_when_native_value_blank():
    from infusion_select2 import _drug_selection_committed

    class FakeDriver:
        def execute_script(self, *_args, **_kwargs):
            return {
                'ok': False,
                'value': '',
                'tagged': False,
                'selectedText': '',
                'dataText': 'PARACETAMOL 10MG/ML',
                'containerText': 'PARACETAMOL 10MG/ML',
            }

    assert _drug_selection_committed(FakeDriver(), 'cbbThuoc', ['PARACETAMOL']) is True


def test_drug_selection_committed_rejects_wrong_text_when_native_value_blank():
    from infusion_select2 import _drug_selection_committed

    class FakeDriver:
        def execute_script(self, *_args, **_kwargs):
            return {
                'ok': False,
                'value': '',
                'tagged': False,
                'selectedText': '',
                'dataText': 'BEROXIB',
                'containerText': 'BEROXIB',
            }

    assert _drug_selection_committed(FakeDriver(), 'cbbThuoc', ['PARACETAMOL']) is False


def test_legacy_pha_natriclorid_deleted_only_when_correct_vancomycin_exists(monkeypatch):
    import infusion_cleanup

    deleted_ids = []
    monkeypatch.setattr(
        infusion_cleanup,
        '_delete_record_by_id',
        lambda driver, wait, rec_id: deleted_ids.append(rec_id) or True,
    )
    monkeypatch.setattr(infusion_cleanup.time, 'sleep', lambda *_args, **_kwargs: None)

    legacy = {
        'id': 'OLD_PHA_NACL',
        'ten': 'Pha natriclorid 0.9% 100ml',
        'ten_key': infusion_cleanup._norm_med_key('Pha natriclorid 0.9% 100ml'),
        'tg_bat_dau': '08:00 14/08/2026',
        'the_tich': 100,
        'toc_do': 30,
    }
    correct = {
        'id': 'NEW_VANCO',
        'ten': 'VANCOMYCIN + Natri clorid 0.9%',
        'ten_key': infusion_cleanup._norm_med_key('VANCOMYCIN + Natri clorid 0.9%'),
        'tg_bat_dau': '08:00 14/08/2026',
        'the_tich': 100,
        'toc_do': 30,
    }
    expected = [{
        'Full_Name': 'VANCOMYCIN + Natri clorid 0.9%',
        'Search_Name': 'VANCOMYCIN',
        'Time_Start_Str': '08:00 14/08/2026',
        'The_Tich': 100,
        'Toc_Do': '30',
    }]
    records = {
        (legacy['ten_key'], legacy['tg_bat_dau']): [legacy],
        (correct['ten_key'], correct['tg_bat_dau']): [correct],
    }

    count = infusion_cleanup.xoa_dich_truyen_legacy_parser_cu(
        object(), object(), records, expected
    )
    assert count == 1
    assert deleted_ids == ['OLD_PHA_NACL']


def test_legacy_pha_natriclorid_kept_until_correct_replacement_exists(monkeypatch):
    import infusion_cleanup

    deleted_ids = []
    monkeypatch.setattr(
        infusion_cleanup,
        '_delete_record_by_id',
        lambda driver, wait, rec_id: deleted_ids.append(rec_id) or True,
    )
    legacy = {
        'id': 'OLD_PHA_NACL',
        'ten': 'Pha NaCl 0.9% 100ml',
        'ten_key': infusion_cleanup._norm_med_key('Pha NaCl 0.9% 100ml'),
        'tg_bat_dau': '20:00 15/08/2026',
        'the_tich': 100,
        'toc_do': 30,
    }
    expected = [{
        'Full_Name': 'VANCOMYCIN 500mg + Natri clorid 0.9%',
        'Time_Start_Str': '20:00 15/08/2026',
        'The_Tich': 100,
        'Toc_Do': 30,
    }]
    records = {(legacy['ten_key'], legacy['tg_bat_dau']): [legacy]}

    count = infusion_cleanup.xoa_dich_truyen_legacy_parser_cu(
        object(), object(), records, expected
    )
    assert count == 0
    assert deleted_ids == []


def test_legacy_cleanup_does_not_touch_unrelated_or_wrong_shape(monkeypatch):
    import infusion_cleanup

    deleted_ids = []
    monkeypatch.setattr(
        infusion_cleanup,
        '_delete_record_by_id',
        lambda driver, wait, rec_id: deleted_ids.append(rec_id) or True,
    )
    legacy_wrong_volume = {
        'id': 'OLD_WRONG_SHAPE',
        'ten': 'Pha natriclorid 0.9% 250ml',
        'ten_key': infusion_cleanup._norm_med_key('Pha natriclorid 0.9% 250ml'),
        'tg_bat_dau': '08:00 16/08/2026',
        'the_tich': 250,
        'toc_do': 30,
    }
    unrelated = {
        'id': 'MANUAL_OTHER',
        'ten': 'Natri clorid 0.9%',
        'ten_key': infusion_cleanup._norm_med_key('Natri clorid 0.9%'),
        'tg_bat_dau': '08:00 16/08/2026',
        'the_tich': 100,
        'toc_do': 30,
    }
    correct = {
        'id': 'NEW_VANCO',
        'ten': 'VANCOMYCIN 500mg + Natri clorid 0.9%',
        'ten_key': infusion_cleanup._norm_med_key('VANCOMYCIN 500mg + Natri clorid 0.9%'),
        'tg_bat_dau': '08:00 16/08/2026',
        'the_tich': 100,
        'toc_do': 30,
    }
    expected = [{
        'Full_Name': 'VANCOMYCIN 500mg + Natri clorid 0.9%',
        'Time_Start_Str': '08:00 16/08/2026',
        'The_Tich': 100,
        'Toc_Do': 30,
    }]
    records = {
        (legacy_wrong_volume['ten_key'], legacy_wrong_volume['tg_bat_dau']): [legacy_wrong_volume],
        (unrelated['ten_key'], unrelated['tg_bat_dau']): [unrelated],
        (correct['ten_key'], correct['tg_bat_dau']): [correct],
    }

    count = infusion_cleanup.xoa_dich_truyen_legacy_parser_cu(
        object(), object(), records, expected
    )
    assert count == 0
    assert deleted_ids == []


def test_premixed_ciprofloxacin_100ml_does_not_infer_nacl_diluent():
    from processing.diluent_resolver import infer_and_reclassify_diluents

    cipro = {
        'ten_thuoc': 'CIPROFLOXACIN KABI',
        'hoat_chat': 'Ciprofloxacin',
        'the_tich': 100.0,
        'dang': 'Chai/Lọ/Ống/Túi',
        'so_luong': '4',
        'toc_do': '30',
        'gio_dung': '8 giờ, 20 giờ',
        'duong_dung_goc': 'Tiêm truyền TM 30 giọt/phút, sáng 2 chai/lọ/ống/túi, tối 2 chai/lọ/ống/túi(8 giờ, 20 giờ).',
        'raw_text': '(3) CIPROFLOXACIN KABI (Ciprofloxacin) 200mg/100ml x 4 (Chai/Lọ/Ống/Túi)',
        'raw_drug_part': '(3) CIPROFLOXACIN KABI (Ciprofloxacin) 200mg/100ml x 4 (Chai/Lọ/Ống/Túi)',
        'so_luong_moi_gio': {'8': 2.0, '20': 2.0},
        'duong_dung': 'TTM',
    }

    infusions, injections = infer_and_reclassify_diluents([cipro], [])
    assert injections == []
    assert len(infusions) == 1
    out = infusions[0]
    assert out.get('dung_moi') in (None, '')
    assert out.get('suy_luan_dung_moi') is not True
    assert '+ Natri clorid' not in str(out.get('ten_hien_thi') or '')
    assert float(out.get('the_tich') or 0) == 100.0


def test_select2_lot_value_sanitizes_literal_nulls():
    from infusion_select2 import _clean_lot_value

    for value in (None, '', 'null', 'NULL', 'None', 'undefined', 'N/A', '-'):
        assert _clean_lot_value(value) == ''
    assert _clean_lot_value(' PA7270726 ') == 'PA7270726'


def test_legacy_cipro_plus_nacl_deleted_only_after_correct_premix_exists(monkeypatch):
    import infusion_cleanup

    deleted_ids = []
    monkeypatch.setattr(
        infusion_cleanup,
        '_delete_record_by_id',
        lambda driver, wait, rec_id: deleted_ids.append(rec_id) or True,
    )
    monkeypatch.setattr(infusion_cleanup.time, 'sleep', lambda *_args, **_kwargs: None)

    legacy = {
        'id': 'OLD_CIPRO_NACL',
        'ten': 'CIPROFLOXACIN KABI + Natri clorid 0.9%',
        'ten_key': infusion_cleanup._norm_med_key('CIPROFLOXACIN KABI + Natri clorid 0.9%'),
        'tg_bat_dau': '12:10 16/08/2026',
        'the_tich': 100,
        'toc_do': 30,
    }
    correct = {
        'id': 'NEW_CIPRO',
        'ten': 'Ciprofloxacin Kabi',
        'ten_key': infusion_cleanup._norm_med_key('Ciprofloxacin Kabi'),
        'tg_bat_dau': '12:10 16/08/2026',
        'the_tich': 100,
        'toc_do': 30,
    }
    expected = [{
        'Full_Name': 'CIPROFLOXACIN KABI',
        'Search_Name': 'CIPROFLOXACIN KABI',
        'Time_Start_Str': '12:10 16/08/2026',
        'The_Tich': 100,
        'Toc_Do': '30',
    }]
    records = {
        (legacy['ten_key'], legacy['tg_bat_dau']): [legacy],
        (correct['ten_key'], correct['tg_bat_dau']): [correct],
    }

    leftovers = infusion_cleanup.tim_dich_truyen_legacy_parser_cu(records, expected)
    assert [(x[0]['id'], x[1]['Full_Name']) for x in leftovers] == [
        ('OLD_CIPRO_NACL', 'CIPROFLOXACIN KABI')
    ]

    count = infusion_cleanup.xoa_dich_truyen_legacy_parser_cu(
        object(), object(), records, expected
    )
    assert count == 1
    assert deleted_ids == ['OLD_CIPRO_NACL']


def test_legacy_cipro_plus_nacl_kept_without_correct_premix_replacement(monkeypatch):
    import infusion_cleanup

    deleted_ids = []
    monkeypatch.setattr(
        infusion_cleanup,
        '_delete_record_by_id',
        lambda driver, wait, rec_id: deleted_ids.append(rec_id) or True,
    )
    legacy = {
        'id': 'OLD_CIPRO_NACL',
        'ten': 'ciprofloxacin kabi + natri clorid 0.9%',
        'ten_key': infusion_cleanup._norm_med_key('ciprofloxacin kabi + natri clorid 0.9%'),
        'tg_bat_dau': '20:00 16/08/2026',
        'the_tich': 100,
        'toc_do': 30,
    }
    expected = [{
        'Full_Name': 'CIPROFLOXACIN KABI',
        'Time_Start_Str': '20:00 16/08/2026',
        'The_Tich': 100,
        'Toc_Do': 30,
    }]
    records = {(legacy['ten_key'], legacy['tg_bat_dau']): [legacy]}

    assert len(infusion_cleanup.tim_dich_truyen_legacy_parser_cu(records, expected)) == 1
    count = infusion_cleanup.xoa_dich_truyen_legacy_parser_cu(
        object(), object(), records, expected
    )
    assert count == 0
    assert deleted_ids == []


def test_legacy_cipro_cleanup_does_not_touch_real_nacl_or_wrong_shape(monkeypatch):
    import infusion_cleanup

    deleted_ids = []
    monkeypatch.setattr(
        infusion_cleanup,
        '_delete_record_by_id',
        lambda driver, wait, rec_id: deleted_ids.append(rec_id) or True,
    )
    monkeypatch.setattr(infusion_cleanup.time, 'sleep', lambda *_args, **_kwargs: None)

    wrong_shape = {
        'id': 'OLD_CIPRO_WRONG_VOLUME',
        'ten': 'CIPROFLOXACIN KABI + Natri clorid 0.9%',
        'ten_key': infusion_cleanup._norm_med_key('CIPROFLOXACIN KABI + Natri clorid 0.9%'),
        'tg_bat_dau': '20:00 16/08/2026',
        'the_tich': 250,
        'toc_do': 30,
    }
    real_nacl = {
        'id': 'REAL_NACL',
        'ten': 'NATRI CLORID 0,9%',
        'ten_key': infusion_cleanup._norm_med_key('NATRI CLORID 0,9%'),
        'tg_bat_dau': '20:00 16/08/2026',
        'the_tich': 100,
        'toc_do': 30,
    }
    correct = {
        'id': 'NEW_CIPRO',
        'ten': 'Ciprofloxacin Kabi',
        'ten_key': infusion_cleanup._norm_med_key('Ciprofloxacin Kabi'),
        'tg_bat_dau': '20:00 16/08/2026',
        'the_tich': 100,
        'toc_do': 30,
    }
    expected = [{
        'Full_Name': 'CIPROFLOXACIN KABI',
        'Time_Start_Str': '20:00 16/08/2026',
        'The_Tich': 100,
        'Toc_Do': 30,
    }]
    records = {
        (wrong_shape['ten_key'], wrong_shape['tg_bat_dau']): [wrong_shape],
        (real_nacl['ten_key'], real_nacl['tg_bat_dau']): [real_nacl],
        (correct['ten_key'], correct['tg_bat_dau']): [correct],
    }

    assert infusion_cleanup.tim_dich_truyen_legacy_parser_cu(records, expected) == []
    count = infusion_cleanup.xoa_dich_truyen_legacy_parser_cu(
        object(), object(), records, expected
    )
    assert count == 0
    assert deleted_ids == []
