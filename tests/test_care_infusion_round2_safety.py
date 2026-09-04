# -*- coding: utf-8 -*-
"""Regression cho các lỗi thấy trong log chăm sóc + dịch truyền 28/08/2026."""
from __future__ import annotations

import json
import subprocess
import sys
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "worker"
if str(WORKER) not in sys.path:
    sys.path.insert(0, str(WORKER))


def run_node(script: str):
    out = subprocess.run(
        ["node", "--input-type=module", "-"],
        cwd=ROOT,
        input=script,
        text=True,
        capture_output=True,
        check=True,
    )
    return json.loads(out.stdout.strip() or "{}")


def test_precheck_endpoint_never_runs_input_worker():
    source = (ROOT / "server/routes/patients.js").read_text(encoding="utf-8")
    start = source.index("router.post('/check-input-changes'")
    end = source.index("router.post('/run-input-infusions'", start)
    block = source[start:end]

    assert "await runInputTask(" not in block
    assert "continueCareAfterPrecheck" not in block
    assert "continueInfusionsAfterPrecheck" not in block
    assert "issueInputPrecheckToken" in block
    assert "tuyệt đối không chạy worker ghi EMR" in source


def test_frontend_precheck_changed_waits_for_final_confirmation_only():
    source = (ROOT / "src/components/ShiftTab.jsx").read_text(encoding="utf-8")
    start = source.index("const ensureInputDataFresh")
    end = source.index("const resolveInputDates", start)
    block = source[start:end]

    # Nhánh changed chỉ refresh dữ liệu + trả token. confirmInputAction ở handler
    # chăm sóc/dịch truyền là điểm xác nhận duy nhất trước khi ghi EMR.
    assert "window.confirm(" not in block
    assert "return r;" in block
    assert "confirmInputAction(targets, 'chăm sóc" in source
    assert "confirmInputAction(targets, 'dịch truyền" in source


def test_blood_receive_time_is_strict_and_normalized(tmp_path):
    src = (ROOT / "src/components/shift/shiftUtils.js").read_text(encoding="utf-8")
    src = src.replace(
        "import { useEffect, useState } from 'react';",
        "const useEffect = () => {}; const useState = (init) => [init, () => {}];",
    )
    mod = tmp_path / "shiftUtils.mjs"
    mod.write_text(src, encoding="utf-8")
    result = run_node(textwrap.dedent(f"""
        import {{ normalizeClockTime }} from {json.dumps(mod.as_uri())};
        console.log(JSON.stringify({{
          t1: normalizeClockTime('8:05'),
          t2: normalizeClockTime('23:59'),
          badHour: normalizeClockTime('25:00'),
          badMinute: normalizeClockTime('12:99'),
          badShape: normalizeClockTime('8h05'),
          empty: normalizeClockTime(''),
        }}));
    """))
    assert result == {
        "t1": "08:05",
        "t2": "23:59",
        "badHour": None,
        "badMinute": None,
        "badShape": None,
        "empty": "",
    }


def test_patient_scope_does_not_leak_discharge_or_surgery_from_other_day(tmp_path):
    mod = tmp_path / "patientScope.mjs"
    mod.write_text((ROOT / "src/utils/patientScope.js").read_text(encoding="utf-8"), encoding="utf-8")
    result = run_node(textwrap.dedent(f"""
        import {{ scopePatientToDates, parseAdmissionDateTime }} from {json.dumps(mod.as_uri())};
        const p = {{
          ma_bn: 'A',
          available_dates: ['23/08/2026', '24/08/2026'],
          day_map: {{
            '23/08/2026': {{ care_required: false, surgery_out: false }},
            '24/08/2026': {{
              care_required: true,
              surgery_out: true,
              surgery_out_time: '10:00 24/08/2026',
              ngay_ra_vien: '24/08/2026',
              gio_ra_vien: '13:00',
              ra_vien_hom_nay: true,
            }},
          }},
          surgery_out: true,
          surgery_out_time: '10:00 24/08/2026',
          ngay_ra_vien: '24/08/2026',
          gio_ra_vien: '13:00',
          ra_vien_hom_nay: true,
        }};
        const scoped = scopePatientToDates(p, ['23/08/2026']);
        console.log(JSON.stringify({{
          surgeryOut: scoped.surgery_out,
          surgeryTime: scoped.surgery_out_time,
          dischargeDate: scoped.ngay_ra_vien,
          dischargeTime: scoped.gio_ra_vien,
          dischargeToday: scoped.ra_vien_hom_nay,
          careDone: scoped.care_done,
          status: scoped.status,
          invalidDate: parseAdmissionDateTime('10:00 31/02/2026'),
          invalidTime: parseAdmissionDateTime('25:00 28/02/2026'),
          validDate: Boolean(parseAdmissionDateTime('10:00 28/02/2026')),
        }}));
    """))
    assert result == {
        "surgeryOut": False,
        "surgeryTime": "",
        "dischargeDate": "",
        "dischargeTime": "",
        "dischargeToday": False,
        "careDone": True,
        "status": "green",
        "invalidDate": None,
        "invalidTime": None,
        "validDate": True,
    }


def test_current_room_enrichment_never_overwrites_patient_day_room():
    source = (ROOT / "server/routes/patients.js").read_text(encoding="utf-8")
    start = source.index("function enrichRowsWithCurrentRooms")
    end = source.index("function extractDmyForCompare", start)
    block = source[start:end]
    assert "if (roomFromRow(row)) return row;" in block


def test_care_creator_selector_reuses_robust_infusion_staff_selector(monkeypatch):
    import care_form_actions as care

    calls = []

    class FakeWait:
        def __init__(self, driver, timeout):
            self.driver = driver
            self.timeout = timeout

        def until(self, fn):
            assert fn(self.driver) is True
            return True

    class FakeDriver:
        def execute_script(self, *_args, **_kwargs):
            return True

    monkeypatch.setattr(care, "WebDriverWait", FakeWait)
    monkeypatch.setattr(care.time, "sleep", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        care,
        "chon_select2_bac_si_y_ta",
        lambda driver, field_id, target, timeout=0: calls.append((field_id, target, timeout)) or True,
    )

    assert care._chon_nguoi_lap_select2(FakeDriver(), "Lê Thị Tuyết Đoan", timeout=7) is True
    assert calls == [("cbbNguoiLap", "Lê Thị Tuyết Đoan", 7)]


def test_care_form_does_not_change_time_field_twice():
    source = (ROOT / "worker/care_form_actions.py").read_text(encoding="utf-8")
    start = source.index("def dien_thong_tin(")
    block = source[start:]
    assert 'driver.find_element(By.ID, "txtThoiGianLap")' not in block
    assert "set/change lần hai" in block
