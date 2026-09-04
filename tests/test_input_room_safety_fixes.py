# -*- coding: utf-8 -*-
"""Regression tests cho các chốt an toàn nhập bệnh phòng."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "worker"
if str(WORKER) not in sys.path:
    sys.path.insert(0, str(WORKER))


def test_care_form_rejects_invalid_creator(monkeypatch):
    import care_form_actions as actions

    class DummyDriver:
        def find_element(self, *args, **kwargs):
            raise RuntimeError("field unavailable in unit test")

        def execute_script(self, *args, **kwargs):
            return None

    monkeypatch.setattr(actions, "get_nurse_by_shift", lambda *_args, **_kwargs: "Điều Dưỡng A")
    monkeypatch.setattr(actions, "_chon_nguoi_lap_select2", lambda *_args, **_kwargs: False)

    assert actions.dien_thong_tin(
        DummyDriver(),
        8,
        "08:00 03/08/2026",
        "Thực hiện chỉ định thuốc",
        ["Điều Dưỡng A"],
        "Người bệnh tỉnh",
        config_ten_goc={"Default": {}},
    ) is False


def test_care_form_log_context_contains_patient_date():
    import care_form_actions as actions

    actions.set_log_context("BN_TEST_01", "NGUYỄN VĂN A", "03/08/2026")
    prefix = actions._ctx_prefix()
    assert "BN=BN_TEST_01" in prefix
    assert "NAME=NGUYỄN VĂN A" in prefix
    assert "DATE=03/08/2026" in prefix


def test_worker_sets_context_before_discharge_rules():
    source = (WORKER / "input_care.py").read_text(encoding="utf-8")
    context_pos = source.index("set_care_form_log_context(ma_bn")
    discharge_pos = source.index("discharge_cutoff_dt = _discharge_cutoff_from_entry", context_pos)
    warning_pos = source.index("[CẢNH BÁO][Y_LENH_SAU_RA_VIEN]", discharge_pos)
    assert context_pos < discharge_pos < warning_pos
    assert "if not form_ok:" in source
    assert "[Sai Người lập] -> Retry." in source


def test_frontend_confirmation_lists_targets_and_exclusions():
    source = (ROOT / "src/components/ShiftTab.jsx").read_text(encoding="utf-8")
    assert "DANH SÁCH SẼ NHẬP" in source
    assert "ĐÃ LOẠI KHỎI PHẠM VI" in source
    assert "targets.excludedPatientIds" in source
    assert "excludedPatientsForAudit" in source


def test_server_persists_input_scope_audit():
    source = (ROOT / "server/routes/patients.js").read_text(encoding="utf-8")
    assert "function createInputScopeAudit" in source
    assert "excluded_patient_ids" in source
    assert "normalized_out_patient_ids" in source
    assert "target_patient_ids" in source
    assert "input_scope_${safeFilePart" in source
    assert "updateInputScopeAudit(auditPath, {" in source
    assert "delete workerTargets.patientSummaries" in source
