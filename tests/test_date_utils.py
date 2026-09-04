# -*- coding: utf-8 -*-
"""tests/test_date_utils.py — Test helper ngày dùng chung cho bridge ngày mai trước 07:00."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'worker'))

from date_utils import normalize_dmy, previous_day_dmy, work_date_for_timeline_date


class TestDateUtils:

    def test_normalize_dmy_full(self):
        assert normalize_dmy("1/2/2026") == "01/02/2026"
        assert normalize_dmy("01-02-2026") == "01/02/2026"

    def test_normalize_dmy_short_with_year(self):
        assert normalize_dmy("1/2", default_year=2026) == "01/02/2026"

    def test_normalize_dmy_accepts_iso(self):
        assert normalize_dmy("2026-05-09") == "09/05/2026"

    def test_previous_day(self):
        assert previous_day_dmy("01/05/2026") == "30/04/2026"

    def test_bridge_end_date_maps_to_previous_work_date(self):
        assert work_date_for_timeline_date("27/04/2026", "27/04/2026") == "26/04/2026"

    def test_non_bridge_date_keeps_same_work_date(self):
        assert work_date_for_timeline_date("26/04/2026", "27/04/2026") == "26/04/2026"
