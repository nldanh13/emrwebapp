import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'worker'))

from infusion_result_keys import result_keys_for_patient


def test_result_keys_use_managed_date_and_time_start_date():
    keys = result_keys_for_patient('BN001', [
        {'Managed_Date': '27/04/2026'},
        {'Time_Start_Str': '06:00 28/04/2026'},
        {'Time_Start_Str': '20:00 27/04/2026'},
    ])
    assert keys == ['BN001::27/04/2026', 'BN001::28/04/2026']


def test_result_keys_fallback_patient_only_when_no_date():
    assert result_keys_for_patient('BN002', [{'Full_Name': 'NaCl'}]) == ['BN002']


def test_result_keys_skip_empty_patient():
    assert result_keys_for_patient('', [{'Managed_Date': '27/04/2026'}]) == []
