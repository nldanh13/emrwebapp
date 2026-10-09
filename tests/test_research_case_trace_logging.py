from pathlib import Path
import importlib.util

ROOT = Path(__file__).resolve().parents[1]
MOD_PATH = ROOT / "worker" / "hchanh_fetch.py"
spec = importlib.util.spec_from_file_location("hchanh_fetch_trace", MOD_PATH)
hchanh_fetch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hchanh_fetch)


def test_hchanh_trace_event_uses_precise_step_tag_and_fields():
    hchanh_fetch._TRACE_EVENTS.clear()
    hchanh_fetch.trace_event(
        "ORDER_HISTORY.HTTP_SELECT_SHOW_ALL",
        "Chọn Tất cả trong lịch sử y lệnh",
        screen="Lịch sử y lệnh / select#soLuongHienThi",
        sees="option value=1000",
        takes="HTML toàn bộ y lệnh",
        writes="rows y lệnh",
        target="output.order_history.rows",
    )
    events = hchanh_fetch.trace_events()
    assert len(events) == 1
    ev = events[0]
    assert ev["tag"] == "ORDER_HISTORY.HTTP_SELECT_SHOW_ALL"
    assert "select#soLuongHienThi" in ev["screen"]
    assert "option value=1000" in ev["sees"]
    assert "HTML" in ev["takes"]
    assert "rows y lệnh" in ev["writes"]


def test_research_case_trace_recent_endpoint_and_limit_exist(research_backend_src):
    src = research_backend_src
    assert "research_case_trace_recent.json" in src
    assert "CASE_TRACE_RECENT_LIMIT = 10" in src
    assert "/research/archive/case-trace" in src
    assert "/research/studies/:studyId/case-trace" in src
    assert "appendResearchCaseTrace" in src


def test_research_log_panel_is_removed_from_ui(research_ui_src):
    src = research_ui_src
    assert "[CASE_TRACE] 10 ca gần nhất" not in src
    assert "caseTraceRedact" not in src
    assert "Xem log chạy" not in src


def test_research_trace_has_new_diagnostic_tags():
    src = MOD_PATH.read_text(encoding="utf-8")
    for tag in [
        "EMR.PATIENT_LINKS_EMPTY",
        "EMR.PATIENT_LINKS_RECOVERED",
        "ERROR.NO_PATIENT_LINK",
        "ERROR.NO_URL_PROFILE",
        "ERROR.NO_URL_DISCHARGE",
        "ERROR.NO_URL_ORDER_HISTORY",
        "ERROR.NO_URL_SURGERY",
        "ORDER_HISTORY.PREFETCH_FOR_SURGERY",
        "ORDER_HISTORY.HTTP_SELECT_SHOW_ALL",
        "ORDER_HISTORY.MARKERS_DIRECT",
        "ORDER_HISTORY.FALLBACK_CLICK_OPEN",
        "ORDER_HISTORY.MARKERS_FALLBACK",
        "ORDER_HISTORY.REUSE_EXISTING",
        "SURGERY.GATE_DECISION",
    ]:
        assert tag in src


def test_research_case_trace_redaction_api_exists(research_backend_src, research_ui_src):
    src = research_backend_src
    ui = research_ui_src
    api = (ROOT / "src" / "api.js").read_text(encoding="utf-8")
    assert "redactCaseTracePayload" in src
    assert "req.query.redact" in src
    assert "caseTraceRedact" not in ui
    assert "Ẩn thông tin nhạy cảm" not in ui
    assert "Xem log chạy" not in ui
    assert "redact: redact ? '1' : '0'" in api
