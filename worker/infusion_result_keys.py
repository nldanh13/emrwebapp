# -*- coding: utf-8 -*-
"""Pure helpers for infusion input result/progress keys."""
import re
from datetime import datetime


def result_keys_for_patient(ma_bn, med_list):
    """Return per-patient/day result keys for EMR input progress/done-state.

    Keys are stored as ``ma_bn::dd/mm/YYYY`` so selecting a single timeline day
    does not mark all days of the same patient as completed.
    """
    ma_bn = str(ma_bn or '').strip()
    dates = set()
    for med in med_list or []:
        if not isinstance(med, dict):
            continue
        d = str(med.get('Managed_Date') or '').strip()
        if not d:
            raw = str(med.get('Time_Start_Str') or '').strip()
            m = re.search(r"(\d{1,2}/\d{1,2}/\d{4})", raw)
            if m:
                try:
                    d = datetime.strptime(m.group(1), "%d/%m/%Y").strftime("%d/%m/%Y")
                except Exception:
                    d = m.group(1)
        if d:
            dates.add(d)
    if not ma_bn:
        return []
    if not dates:
        return [ma_bn]

    def _sort_key(x):
        try:
            return datetime.strptime(x, "%d/%m/%Y")
        except Exception:
            return datetime.max

    return ["{}::{}".format(ma_bn, d) for d in sorted(dates, key=_sort_key)]
