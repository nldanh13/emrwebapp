# -*- coding: utf-8 -*-
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_analysis_ready_excludes_explicitly_outside_results_and_prefers_timed_lab():
    src = (ROOT / "server" / "research" / "normalize.js").read_text(encoding="utf-8")
    assert "lab.is_within_encounter === '0'" in src
    assert "img.is_within_encounter === '0'" in src
    assert "(!oldTime && Boolean(newTime))" in src
    assert "newTime.localeCompare(oldTime) < 0" in src


def test_clinical_events_are_qa_checked_and_cleaned_as_derived_data():
    qa = (ROOT / "server" / "research" / "quality.js").read_text(encoding="utf-8")
    ds = (ROOT / "server" / "research" / "dataset_store.js").read_text(encoding="utf-8")
    assert "['clinical_events', 'clinical_event_id']" in qa
    assert "'clinical_events.csv'" in ds


def test_final_dataset_blocked_when_patient_db_data_is_provisional():
    src = (ROOT / "server" / "research" / "progress_snapshot.js").read_text(encoding="utf-8")
    assert "normalized_outputs?.kho_nguoi_benh?.provisional" in src
    assert "dữ liệu tạm thời" in src


def test_date_only_discharge_uses_end_of_day_for_temporal_membership():
    src = (ROOT / "server" / "research" / "encounter_context.js").read_text(encoding="utf-8")
    assert "hasPreciseDischargeTime" in src
    assert "dayEnd(dischargeDt)" in src
