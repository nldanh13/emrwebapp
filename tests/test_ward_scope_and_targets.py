# -*- coding: utf-8 -*-
"""Regression tests cho luồng nhập bệnh phòng / trực.

Các test này khóa các lỗi an toàn vận hành:
- luồng chăm sóc hợp nhất vẫn đưa ngày đã done vào để kiểm tra trực tiếp trên EMR;
- ca thiếu dữ liệu phân luồng không tự rơi vào bệnh phòng;
- lọc phòng backend phải lọc theo BN + ngày + phòng;
- worker result phải phân biệt skipped hợp lệ.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
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
    stdout = completed.stdout.strip()
    return json.loads(stdout or "{}")


def test_build_input_targets_unified_care_includes_done_date(tmp_path):
    src = (ROOT / "src/components/shift/shiftUtils.js").read_text(encoding="utf-8")
    src = src.replace(
        "import { useEffect, useState } from 'react';",
        "const useEffect = () => {}; const useState = (init) => [typeof init === 'function' ? init() : init, () => {}];",
    )
    mod = tmp_path / "shiftUtils.mjs"
    mod.write_text(src, encoding="utf-8")
    script = textwrap.dedent(f"""
        import {{ buildInputTargets }} from {json.dumps(mod.as_uri())};
        const donePatient = {{
          ma_bn: 'BN1',
          available_dates: ['01/06/2026'],
          day_map: {{ '01/06/2026': {{ care_done: true, care_stale: false }} }},
        }};
        const legacy = buildInputTargets([donePatient], ['01/06/2026'], 'care');
        const unified = buildInputTargets([donePatient], ['01/06/2026'], 'care', {{ includeDone: true, repairExisting: true }});
        console.log(JSON.stringify({{
          legacyCount: legacy.patientIds.length,
          unifiedCount: unified.patientIds.length,
          repairExisting: unified.repairExisting,
          hasCutoff: Object.prototype.hasOwnProperty.call(unified, 'careCutoffByPatientDate'),
        }}));
    """)
    result = run_node(script)
    assert result == {
        "legacyCount": 0,
        "unifiedCount": 1,
        "repairExisting": True,
        "hasCutoff": False,
    }


def test_patient_scope_unknown_is_not_ward_or_duty(tmp_path):
    src = (ROOT / "src/utils/patientScope.js").read_text(encoding="utf-8")
    mod = tmp_path / "patientScope.mjs"
    mod.write_text(src, encoding="utf-8")
    script = textwrap.dedent(f"""
        import {{ getPatientWorkflowScope, filterPatientsByWorkflow }} from {json.dumps(mod.as_uri())};
        const range = {{ from: '2026-06-01', to: '2026-06-01' }};
        const unknown = {{ ma_bn: 'UNKNOWN' }};
        const ward = {{ ma_bn: 'WARD', thoi_gian_vao_khoa: '10:00 31/05/2026' }};
        const duty = {{ ma_bn: 'DUTY', thoi_gian_vao_khoa: '18:00 01/06/2026' }};
        const patients = [unknown, ward, duty];
        console.log(JSON.stringify({{
          unknownScope: getPatientWorkflowScope(unknown, range),
          wardIds: filterPatientsByWorkflow(patients, 'ward', range).map(p => p.ma_bn),
          dutyIds: filterPatientsByWorkflow(patients, 'duty', range).map(p => p.ma_bn),
          unknownIds: filterPatientsByWorkflow(patients, 'unknown', range).map(p => p.ma_bn),
        }}));
    """)
    result = run_node(script)
    assert result["unknownScope"] == "unknown"
    assert result["wardIds"] == ["WARD"]
    assert result["dutyIds"] == ["DUTY"]
    assert result["unknownIds"] == ["UNKNOWN"]


def test_normalize_input_targets_filters_room_by_patient_date():
    script = textwrap.dedent("""
        import { createRequire } from 'node:module';
        const require = createRequire(import.meta.url);
        const { normalizeInputTargets } = require('./server/utils/patient_helpers/targets.js');
        const processedRows = [
          { ma_bn: 'A', ngay_lam: '01/06/2026', so_phong: 'P01' },
          { ma_bn: 'A', ngay_lam: '02/06/2026', so_phong: 'P02' },
          { ma_bn: 'B', ngay_lam: '01/06/2026', Vi_Tri: 'P01-G1' },
        ];
        const result = normalizeInputTargets({
          patientIds: ['A', 'B'],
          patientDates: {
            A: ['01/06/2026', '02/06/2026'],
            B: ['01/06/2026'],
          },
          targetRooms: ['P01'],
        }, processedRows);
        console.log(JSON.stringify(result));
    """)
    result = run_node(script)
    assert result["patientIds"] == ["A", "B"]
    assert result["patientDates"]["A"] == ["01/06/2026"]
    assert result["patientDates"]["B"] == ["01/06/2026"]


def test_shift_tab_blood_time_uses_patient_date_key():
    source = (ROOT / "src/components/ShiftTab.jsx").read_text(encoding="utf-8")
    assert "truyen_mau_times[date ? `${id}::${date}` : id]" in source
    assert "targets.patientDates?.[id]" in source


def test_worker_result_keeps_skipped_separate_from_success():
    sys.path.insert(0, str(ROOT / "worker"))
    from result_schema import build_worker_result

    result = build_worker_result({
        "BN1::2026-06-01": {"success": True, "skipped": True, "reason": "không còn ở khoa", "error": None},
        "BN2::2026-06-01": {"success": True, "error": None},
    })
    assert result["succeeded"] == ["BN2::2026-06-01"]
    assert result["skipped"] == {"BN1::2026-06-01": "không còn ở khoa"}
    assert result["summary"]["skipped_count"] == 1


def test_patient_detail_refresh_orders_has_all_dates_button():
    source = (ROOT / "src/components/PatientDetail.jsx").read_text(encoding="utf-8")
    assert "onRefreshDetails?.(patient, availableDates)" in source
    assert "Cập nhật YL tất cả" in source
    assert "YL ngày" in source


def test_shift_tab_refresh_details_one_accepts_multiple_dates():
    source = (ROOT / "src/components/ShiftTab.jsx").read_text(encoding="utf-8")
    assert "function refreshDateOptions(selectedDate, fallbackRange)" in source
    assert "Array.isArray(selectedDate)" in source
    assert "selectedDates: dates" in source
    assert "api.runDetailsOne(patient, dateOptions)" in source


def test_care_cache_unified_decision_missing_perfect_and_wrong_existing():
    sys.path.insert(0, str(ROOT / "worker"))
    from care_cache import kiem_tra_bang_cached

    time_key = "08:00 01/06/2026"
    expected_care = "Thực hiện chỉ định thuốc"
    expected_db = "Người bệnh tỉnh"

    assert kiem_tra_bang_cached({}, time_key, 8, expected_care, ["Điều Dưỡng A"], expected_db) == ("MISSING", None)

    perfect = {
        "status": "Hoàn tất",
        "creator": "Điều Dưỡng A",
        "nt": "18",
        "temp": "37",
        "mach": "80",
        "ha": "120/80",
        "dien_bien": "Người bệnh tỉnh, tiếp xúc tốt",
        "cham_soc": "Thực hiện chỉ định thuốc",
        "id_edit": "CARE_OK",
    }
    assert kiem_tra_bang_cached(
        {time_key: [perfect]}, time_key, 8, expected_care, ["Điều Dưỡng A"], expected_db,
        expected_creator="Điều Dưỡng A",
    ) == ("PERFECT", "CARE_OK")

    wrong_external = {
        **perfect,
        "creator": "Người Khác",
        "cham_soc": "Nội dung sai",
        "id_edit": "CARE_WRONG",
    }
    assert kiem_tra_bang_cached(
        {time_key: [wrong_external]}, time_key, 8, expected_care, ["Điều Dưỡng A"], expected_db,
        expected_creator="Điều Dưỡng A",
    ) == ("UPDATE", "CARE_WRONG")

    no_edit_id = {**wrong_external, "id_edit": None}
    assert kiem_tra_bang_cached(
        {time_key: [no_edit_id]}, time_key, 8, expected_care, ["Điều Dưỡng A"], expected_db,
        expected_creator="Điều Dưỡng A",
    )[0] == "SKIP"
