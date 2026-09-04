# -*- coding: utf-8 -*-
"""Regression tests cho luồng hợp nhất dịch truyền và thủ thuật."""
from __future__ import annotations

import json
import subprocess
import sys
import textwrap
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run_node(script: str) -> dict:
    completed = subprocess.run(
        ["node", "--input-type=module", "-"],
        input=script,
        text=True,
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    return json.loads(completed.stdout.strip() or "{}")


def test_build_input_targets_unified_dt_tt_include_done_days(tmp_path):
    src = (ROOT / "src/components/shift/shiftUtils.js").read_text(encoding="utf-8")
    src = src.replace(
        "import { useEffect, useState } from 'react';",
        "const useEffect = () => {}; const useState = (init) => [typeof init === 'function' ? init() : init, () => {}];",
    )
    mod = tmp_path / "shiftUtils.mjs"
    mod.write_text(src, encoding="utf-8")
    script = textwrap.dedent(f"""
        import {{ buildInputTargets }} from {json.dumps(mod.as_uri())};
        const patient = {{
          ma_bn: 'BN1',
          available_dates: ['15/07/2026'],
          day_map: {{
            '15/07/2026': {{
              has_infusion: false,
              infus_done: true,
              has_procedure: false,
              procedure_done: true,
            }},
          }},
        }};
        const dtLegacy = buildInputTargets([patient], ['15/07/2026'], 'infusion');
        const dtUnified = buildInputTargets([patient], ['15/07/2026'], 'infusion', {{ includeDone: true, repairExisting: true }});
        const ttLegacy = buildInputTargets([patient], ['15/07/2026'], 'procedure');
        const ttUnified = buildInputTargets([patient], ['15/07/2026'], 'procedure', {{ includeDone: true, repairExisting: true }});
        console.log(JSON.stringify({{
          dtLegacy: dtLegacy.patientIds.length,
          dtUnified: dtUnified.patientIds.length,
          ttLegacy: ttLegacy.patientIds.length,
          ttUnified: ttUnified.patientIds.length,
        }}));
    """)
    assert run_node(script) == {
        "dtLegacy": 0,
        "dtUnified": 1,
        "ttLegacy": 0,
        "ttUnified": 1,
    }


def test_shift_tab_has_one_unified_infusion_path_without_force_reinput():
    source = (ROOT / "src/components/ShiftTab.jsx").read_text(encoding="utf-8")
    assert "targets.unifiedInfusions = true" in source
    assert "targets.repairExisting = true" in source
    assert "targets.forceReinputInfusions" not in source
    assert "forceReinputInfusions" not in source


class _FakeElement:
    def __init__(self, value: str = "", text: str = "", title: str = ""):
        self._value = value
        self.text = text
        self._title = title

    def get_attribute(self, name: str):
        if name == "value":
            return self._value
        if name == "title":
            return self._title
        return ""


class _FakeDriver:
    def __init__(self, values):
        self.values = values

    def find_element(self, _by, field_id):
        if field_id not in self.values:
            raise RuntimeError(field_id)
        return self.values[field_id]

    def execute_script(self, _script, element):
        return element.text or element.get_attribute("value") or ""


def _expected_procedure():
    return {
        "start_dt": datetime(2026, 7, 15, 7, 0),
        "end_dt": datetime(2026, 7, 15, 7, 10),
        "start_text": "07:00 15/07/2026",
        "end_text": "07:10 15/07/2026",
        "anesthesia": "Không",
        "staff_name": "Nhân Viên Thử",
        "template_name": "CTCH-thay băng",
    }


def test_procedure_compare_perfect_form_returns_no_error():
    sys.path.insert(0, str(ROOT / "worker"))
    import input_procedures as procedures
    procedures.By = type("ByStub", (), {"ID": "id"})

    driver = _FakeDriver({
        "txtTgBatDau": _FakeElement(value="07:00 15/07/2026"),
        "txtTgKetThuc": _FakeElement(value="07:10 15/07/2026"),
        "select2-cbbPhuongPhapVoCam-container": _FakeElement(text="Không", title="Không"),
        "select2-cbbTTChinh-container": _FakeElement(text="Nhân Viên Thử", title="Nhân Viên Thử"),
        "select2-cbbMauTuongTrinh-container": _FakeElement(text="CTCH-thay băng", title="CTCH-thay băng"),
    })
    assert procedures._compare_procedure_form(driver, _expected_procedure()) == []


def test_procedure_compare_wrong_form_reports_fields_to_update():
    sys.path.insert(0, str(ROOT / "worker"))
    import input_procedures as procedures
    procedures.By = type("ByStub", (), {"ID": "id"})

    driver = _FakeDriver({
        "txtTgBatDau": _FakeElement(value="08:00 15/07/2026"),
        "txtTgKetThuc": _FakeElement(value="08:10 15/07/2026"),
        "select2-cbbPhuongPhapVoCam-container": _FakeElement(text="Gây tê", title="Gây tê"),
        "select2-cbbTTChinh-container": _FakeElement(text="Người khác", title="Người khác"),
        "select2-cbbMauTuongTrinh-container": _FakeElement(text="Mẫu khác", title="Mẫu khác"),
    })
    errors = procedures._compare_procedure_form(driver, _expected_procedure())
    assert any("giờ bắt đầu" in error for error in errors)
    assert any("giờ kết thúc" in error for error in errors)
    assert any("phương pháp vô cảm" in error for error in errors)
    assert any("thủ thuật viên" in error for error in errors)
    assert any("mẫu tường trình" in error for error in errors)


def test_infusion_worker_only_marks_done_after_final_verification():
    source = (ROOT / "worker/input_infusions.py").read_text(encoding="utf-8")
    assert "return _final_check_and_fix_once()" in source
    assert "if verified_ok is False:" in source
    assert "không đánh dấu hoàn thành" in source
