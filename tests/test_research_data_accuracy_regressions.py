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


def test_age_is_calculated_for_each_encounter_from_birth_and_admission_dates():
    src = (ROOT / "server" / "research" / "normalize.js").read_text(encoding="utf-8")
    assert "function ageAtEncounter" in src
    assert "ageAtEncounter(p.birth_date, enc.admission_date)" in src


def test_patient_day_uses_only_in_encounter_rows_and_earliest_timed_lab():
    src = (ROOT / "server" / "research" / "normalize.js").read_text(encoding="utf-8")
    assert "row.encounter_match_status && row.encounter_match_status !== 'matched'" in src
    assert "row.is_within_encounter === '0'" in src
    assert "const timeKey = `_${col}_time`" in src
    assert "newTime.localeCompare(oldTime) < 0" in src


def test_variable_selection_excludes_explicitly_outside_or_unmatched_rows():
    src = (ROOT / "server" / "research" / "variable_selection.js").read_text(encoding="utf-8")
    assert "matchStatus && matchStatus !== 'matched'" in src
    assert "is_within_encounter || '').trim() === '0'" in src


def test_medication_day_summary_uses_only_matched_in_encounter_orders():
    src = (ROOT / "server" / "research" / "normalize.js").read_text(encoding="utf-8")
    assert "med.encounter_match_status !== 'matched'" in src
    assert "med.is_within_encounter === '0'" in src


def test_repeated_lab_results_are_preserved_losslessly():
    normalize = (ROOT / "server" / "research" / "normalize.js").read_text(encoding="utf-8")
    schema = (ROOT / "server" / "research" / "normalized_schema.js").read_text(encoding="utf-8")
    quality = (ROOT / "server" / "research" / "quality.js").read_text(encoding="utf-8")
    assert "const labResults = labResultsAll.map" in normalize
    assert "labOccurrence" in normalize
    assert "lab_order_id" in normalize
    assert "'lab_order_id'" in schema
    assert "possible_duplicate_lab_rows" in quality


def test_list_aggregation_keeps_repeated_values_instead_of_using_set():
    src = (ROOT / "server" / "research" / "variable_selection.js").read_text(encoding="utf-8")
    assert "new Set(items.map" not in src
    assert "ordered.map(item => String(item.value)).join('; ')" in src


def test_lab_conflict_key_uses_order_id():
    src = (ROOT / "server" / "research" / "quality.js").read_text(encoding="utf-8")
    assert "text(r.lab_order_id) || '(không mã phiếu)'" in src
