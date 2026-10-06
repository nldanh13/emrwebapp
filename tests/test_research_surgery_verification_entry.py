from pathlib import Path
import importlib
import sys

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "worker"
if str(WORKER) not in sys.path:
    sys.path.insert(0, str(WORKER))

entry = importlib.import_module("hchanh_fetch_entry")


def test_research_entry_turns_missing_marker_into_full_stay_verification(monkeypatch):
    core = entry.core

    monkeypatch.setattr(core, "_surgery_gate_from_order_history", lambda order_history, date_from, date_to: {
        "markers": [], "history_from": date_from, "history_to": date_to, "ward_admissions": [], "total_rows": 10,
    })
    monkeypatch.setattr(core, "_surgery_marker_search_ranges", lambda *args, **kwargs: [("old", "old")])
    monkeypatch.setattr(core, "_date_to_dmy", lambda value: {
        "2026-06-01": "01/06/2026", "2026-06-10": "10/06/2026"
    }.get(value, value))
    monkeypatch.setattr(core, "fetch_surgery", lambda *args, **kwargs: {
        "surgeries": [], "total": 0, "_fetch_status": "ok"
    })

    entry._install_research_surgery_verification()

    gate = core._surgery_gate_from_order_history({"rows": []}, "2026-06-01", "2026-06-10")
    assert gate["markers"] == ["01/06/2026"]
    assert gate["research_verification_fallback"] is True

    ranges = core._surgery_marker_search_ranges(gate["markers"], "2026-06-01", "2026-06-10")
    assert ranges == [("01/06/2026", "10/06/2026")]

    result = core.fetch_surgery(None, "X", "2026-06-01", "2026-06-10", {}, {}, existing_order_history={"rows": []})
    assert result["_verified_lookup"] is True
    assert result["_verified_empty"] is True
    assert result["_fetch_status"] == "empty"
    assert result["_reason"] == "verified_surgery_list_empty"


def test_research_entry_keeps_unverified_skip_as_partial(monkeypatch):
    core = entry.core

    # Reload entry/core functions so this test does not depend on prior monkeypatch installation.
    importlib.reload(core)
    importlib.reload(entry)
    core = entry.core

    monkeypatch.setattr(core, "fetch_surgery", lambda *args, **kwargs: {
        "surgeries": [], "total": 0, "_fetch_status": "ok",
        "_skip_surgery_lookup_reason": "no_date_range",
    })
    entry._install_research_surgery_verification()
    result = core.fetch_surgery(None, "X", "", "", {}, {}, existing_order_history={"rows": []})
    assert result["_fetch_status"] == "partial"
    assert result["_verified_lookup"] is False
    assert "unverified" in result["_reason"]
