# -*- coding: utf-8 -*-
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_analysis_ready_excludes_explicitly_outside_results_and_prefers_timed_lab():
    src = (ROOT / "server" / "research" / "normalize.js").read_text(encoding="utf-8")
    assert "lab.is_within_encounter !== '1'" in src
    assert "img.is_within_encounter !== '1'" in src
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
    assert "function hasPreciseClock" in src
    assert "dischargeHasTime ? discharge.getTime() : dayEnd(discharge)" in src


def test_age_is_calculated_for_each_encounter_from_birth_and_admission_dates():
    src = (ROOT / "server" / "research" / "normalize.js").read_text(encoding="utf-8")
    assert "function ageAtEncounter" in src
    assert "ageAtEncounter(p.birth_date, enc.admission_date)" in src


def test_patient_day_uses_only_in_encounter_rows_and_earliest_timed_lab():
    src = (ROOT / "server" / "research" / "normalize.js").read_text(encoding="utf-8")
    assert "row.encounter_match_status && row.encounter_match_status !== 'matched'" in src
    assert "row.is_within_encounter !== '1'" in src
    assert "const timeKey = `_${col}_time`" in src
    assert "newTime.localeCompare(oldTime) < 0" in src


def test_variable_selection_excludes_explicitly_outside_or_unmatched_rows():
    src = (ROOT / "server" / "research" / "variable_selection.js").read_text(encoding="utf-8")
    assert "matchStatus && matchStatus !== 'matched'" in src
    assert "hasOwnProperty.call(row, 'is_within_encounter')" in src
    assert "trim() !== '1'" in src


def test_medication_day_summary_uses_only_matched_in_encounter_orders():
    src = (ROOT / "server" / "research" / "normalize.js").read_text(encoding="utf-8")
    assert "med.encounter_match_status !== 'matched'" in src
    assert "med.is_within_encounter !== '1'" in src


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


def test_lab_unit_normalization_is_conservative_and_keeps_raw_values():
    norm = (ROOT / "server" / "research" / "normalize.js").read_text(encoding="utf-8")
    values = (ROOT / "server" / "research" / "value_normalizers.js").read_text(encoding="utf-8")
    schema = (ROOT / "server" / "research" / "normalized_schema.js").read_text(encoding="utf-8")
    assert "normalizeLabMeasurement" in norm
    assert "result_raw: result" in norm
    assert "unit: unitRaw" in norm
    assert "result_num_norm" in norm
    assert "unit_conversion_status" in norm
    assert "creatinine" in values and "88.4" in values
    assert "glucose" in values and "/ 18" in values
    assert "hemoglobin" in values and "* 10" in values
    for field in ["result_num_norm", "unit_norm", "unit_conversion_status"]:
        assert field in schema


def test_normalized_detail_rows_keep_provenance():
    norm = (ROOT / "server" / "research" / "normalize.js").read_text(encoding="utf-8")
    schema = (ROOT / "server" / "research" / "normalized_schema.js").read_text(encoding="utf-8")
    assert "function provenanceFromRaw" in norm
    assert "derived_parser" in norm
    assert "patient_db" in norm
    for field in ["source_type", "source_quality", "source_file"]:
        assert field in schema


def test_encounter_matching_is_auditable_and_strong_keys_fail_closed():
    ctx = (ROOT / "server" / "research" / "encounter_context.js").read_text(encoding="utf-8")
    norm = (ROOT / "server" / "research" / "normalize.js").read_text(encoding="utf-8")
    schema = (ROOT / "server" / "research" / "normalized_schema.js").read_text(encoding="utf-8")
    assert "function resolveStrongEncounterKey" in ctx
    assert "encounter_match_identity_conflict" in ctx
    assert "encounter_match_strong_key_not_found" in ctx
    assert "encounter_match_missing_event_time" in ctx
    assert "encounter_match_method: encounterMatchMethod(ctx)" in norm
    assert "encounter_match_reason: ctx.needs_manual_review || ''" in norm
    assert "encounter_match_method" in schema
    assert "encounter_match_reason" in schema


def test_research_code_is_not_an_identity_blocker_and_matching_quality_is_reported():
    qa = (ROOT / "server" / "research" / "quality.js").read_text(encoding="utf-8")
    assert "research_code_reused" in qa
    assert "duplicate_research_code" not in qa
    assert "matching_quality: matchingQuality" in qa
    assert "strong_key" in qa
    assert "outside_treatment_time" in qa
    assert "missing_event_time" in qa
    assert "identity_conflict" in qa
    assert "encounter_match_identity_conflict" in qa


def test_sqlite_update_retries_windows_lock_and_surfaces_root_cause():
    py = (ROOT / "research" / "sqlite_store.py").read_text(encoding="utf-8")
    js = (ROOT / "server" / "research" / "sqlite_store.js").read_text(encoding="utf-8")
    qa = (ROOT / "server" / "research" / "quality.js").read_text(encoding="utf-8")
    assert "for attempt in range(6)" in py
    assert "time.sleep(0.35 * (attempt + 1))" in py
    assert "sau 6 lần thử" in py
    assert "function sqlitePythonError" in js
    assert "const root = [...lines].reverse().find" in js
    assert "sqlitePythonError(result.stderr)" in js
    assert "slice(0, 400)" in qa


def test_analysis_outputs_require_positive_temporal_membership():
    norm = (ROOT / "server" / "research" / "normalize.js").read_text(encoding="utf-8")
    sel = (ROOT / "server" / "research" / "variable_selection.js").read_text(encoding="utf-8")
    assert "row.is_within_encounter !== '1'" in norm
    assert "lab.is_within_encounter !== '1'" in norm
    assert "img.is_within_encounter !== '1'" in norm
    assert "row.encounter_match_status === 'matched' && row.is_within_encounter === '1'" in norm
    assert "hasOwnProperty.call(row, 'is_within_encounter')" in sel
    assert "trim() !== '1'" in sel


def test_patient_lookup_falls_back_to_raw_xn_cdha_by_patient_code():
    src = (ROOT / "server" / "research" / "patient_history.js").read_text(encoding="utf-8")
    assert "table: 'raw_lab_results'" in src
    assert "table: 'raw_imaging_results'" in src
    assert "where_any: { ma_bn:" in src
    assert "raw_patient_lookup_unassigned" in src
    assert "rawLabRowForLookup" in src
    assert "rawImagingRowForLookup" in src
    assert "mergeLookupRows('labs'" in src
    assert "mergeLookupRows('imaging'" in src
    assert "canonicalLookupTime" in src


def test_analysis_ready_uses_long_form_detail_tables_instead_of_large_json_cells():
    norm = (ROOT / "server" / "research" / "normalize.js").read_text(encoding="utf-8")
    schema = (ROOT / "server" / "research" / "normalized_schema.js").read_text(encoding="utf-8")
    dictionary = (ROOT / "server" / "research" / "data_dictionary.js").read_text(encoding="utf-8")

    assert "lab_results_json" not in norm
    assert "imaging_results_json" not in norm
    assert "imaging_summary:" not in norm
    assert "'lab_results_json'" not in schema
    assert "'imaging_results_json'" not in schema
    assert "'imaging_summary'" not in schema
    version = re.search(r"const NORMALIZED_SCHEMA_VERSION = (\d+)", schema)
    assert version and int(version.group(1)) >= 21
    assert "lab_result_count: labByEncounter.get(enc.encounter_id)?.total || 0" in norm
    assert "imaging_result_count: imagingByEncounter.get(enc.encounter_id)?.total || 0" in norm
    assert "Chi tiết từng kết quả nằm ở lab_results.csv" in dictionary
    assert "Chi tiết từng kết quả nằm ở imaging_results.csv" in dictionary


def test_order_history_window_filter_change_forces_one_time_refetch_of_old_progress():
    src = (ROOT / "server" / "research" / "hchanh_fetch.js").read_text(encoding="utf-8")
    assert "const VERIFIED_FETCH_WINDOW_VERSION = 3" in src
    assert "const windowFilterMigrationNeeded" in src
    assert "previousWindowVersion < VERIFIED_FETCH_WINDOW_VERSION" in src
    assert re.search(r"windowFilterMigrationNeeded\s*\|\|", src)
