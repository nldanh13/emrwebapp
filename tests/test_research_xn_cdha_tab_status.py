"""Trạng thái riêng từng tab XN/CĐHA: phân biệt EMR không có dữ liệu với lỗi lấy dữ liệu.

Không dùng Selenium: các fetcher tab được thay bằng hàm giả.
"""
import importlib.util
import sys
import types
from pathlib import Path

import pytest

_selenium_module_names = [
    "selenium", "selenium.webdriver", "selenium.webdriver.common", "selenium.webdriver.common.by",
    "selenium.webdriver.support", "selenium.webdriver.support.ui", "selenium.webdriver.support.expected_conditions",
]
_saved_selenium_modules = {name: sys.modules.get(name) for name in _selenium_module_names}
if "selenium" not in sys.modules:
    selenium = types.ModuleType("selenium")
    webdriver_mod = types.ModuleType("selenium.webdriver")
    common_mod = types.ModuleType("selenium.webdriver.common")
    by_mod = types.ModuleType("selenium.webdriver.common.by")
    support_mod = types.ModuleType("selenium.webdriver.support")
    ui_mod = types.ModuleType("selenium.webdriver.support.ui")
    ec_mod = types.ModuleType("selenium.webdriver.support.expected_conditions")
    by_mod.By = object
    ui_mod.WebDriverWait = object
    selenium.webdriver = webdriver_mod
    webdriver_mod.common = common_mod
    webdriver_mod.support = support_mod
    common_mod.by = by_mod
    support_mod.ui = ui_mod
    support_mod.expected_conditions = ec_mod
    sys.modules.update({
        "selenium": selenium,
        "selenium.webdriver": webdriver_mod,
        "selenium.webdriver.common": common_mod,
        "selenium.webdriver.common.by": by_mod,
        "selenium.webdriver.support": support_mod,
        "selenium.webdriver.support.ui": ui_mod,
        "selenium.webdriver.support.expected_conditions": ec_mod,
    })

ROOT = Path(__file__).resolve().parents[1]
MOD_PATH = ROOT / "research" / "nghien_cuu_1" / "lay_lich_su_xn_cdha.py"
spec = importlib.util.spec_from_file_location("research_xn_cdha_tabs", MOD_PATH)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
for _name, _module in _saved_selenium_modules.items():
    if _module is None:
        sys.modules.pop(_name, None)
    else:
        sys.modules[_name] = _module


CTX = {"Mã NC": "NC0001", "Mã BN": "BN1"}


def _xn(value):
    return {"Mã NC": "NC0001", "Mã BN": "BN1", "Chỉ số": "Hb", "Kết quả": value}


def _cdha(name):
    return {"Mã NC": "NC0001", "Mã BN": "BN1", "Tên dịch vụ": name}


def _raise(exc):
    def _f():
        raise exc
    return _f


def _read(path):
    return mod.read_csv_rows(path) if Path(path).exists() else []


# ── Đọc bảng danh sách phiếu ─────────────────────────────────────────────────

XN_ROW = "<tr id='p{n}'><td>1</td><td>x</td><td>01/01/2026 08:00</td><td>BS</td><td>Huyết học</td><td>{st}</td></tr>"


def test_listing_without_rows_is_confirmed_empty():
    html = "<table><tr><th>STT</th><th>TG</th></tr></table>"
    assert mod.parse_history_listing(html, "XN", 5, 5, mod._xn_item_from_row) == []


def test_listing_with_empty_message_is_confirmed_empty():
    html = "<div>Không có dữ liệu</div>"
    assert mod.parse_history_listing(html, "XN", 5, 5, mod._xn_item_from_row) == []
    html_row = "<table><tr><td>Không tìm thấy dữ liệu</td></tr></table>"
    assert mod.parse_history_listing(html_row, "XN", 5, 5, mod._xn_item_from_row) == []


def test_listing_keeps_only_completed_orders():
    html = "<table>" + XN_ROW.format(n=1, st="Hoàn tất") + XN_ROW.format(n=2, st="Đang thực hiện") + "</table>"
    items = mod.parse_history_listing(html, "XN", 5, 5, mod._xn_item_from_row)
    assert [i["tr_id"] for i in items] == ["p1"]


def test_listing_with_unknown_layout_is_structure_error_not_empty():
    html = "<div><span>Bảng kết quả kiểu mới</span></div>"
    with pytest.raises(mod.TabStructureError):
        mod.parse_history_listing(html, "XN", 5, 5, mod._xn_item_from_row)
    html_table = "<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>"
    with pytest.raises(mod.TabStructureError):
        mod.parse_history_listing(html_table, "XN", 5, 5, mod._xn_item_from_row)


def test_unreadable_orders_are_partial_error():
    with pytest.raises(mod.TabPartialError):
        mod.ensure_tab_complete("XN", [{}, {}], 1, [_xn("1")])
    with pytest.raises(mod.TabPartialError):
        mod.ensure_tab_complete("CĐHA", [{}], 0, [])
    mod.ensure_tab_complete("XN", [], 0, [])  # không phiếu nào = EMR không có, không lỗi


# ── Lấy và commit riêng từng tab ─────────────────────────────────────────────

def test_xn_error_keeps_cdha_and_next_run_fetches_only_xn(tmp_path):
    item = {}
    out = mod.collect_visit_tabs(tmp_path, CTX, item, {
        "xn": _raise(mod.TabLoadError("Tab XN không tải xong nội dung")),
        "cdha": lambda: [_cdha("CT sọ não")],
    })
    assert out == {"xn": "error", "cdha": "done"}
    assert item["xn"] == "error" and item["tab_reason"]["xn"].startswith("tab_load")
    assert item["cdha"] == "done" and item["status"] == "incomplete" and item["committed"] is False
    assert [r["Tên dịch vụ"] for r in _read(tmp_path / "lich_su_cdha.csv")] == ["CT sọ não"]
    assert _read(tmp_path / "lich_su_xn.csv") == []

    calls = []

    def cdha_again():
        calls.append("cdha")
        return []

    out2 = mod.collect_visit_tabs(tmp_path, CTX, item, {"xn": lambda: [_xn("12")], "cdha": cdha_again})
    assert calls == [], "CĐHA đã lấy xong không được mở lại"
    assert out2 == {"xn": "done", "cdha": "done"}
    assert item["status"] == "done" and item["committed"] is True
    assert [r["Kết quả"] for r in _read(tmp_path / "lich_su_xn.csv")] == ["12"]
    assert len(_read(tmp_path / "lich_su_cdha.csv")) == 1


def test_confirmed_empty_is_recorded_as_empty_not_error(tmp_path):
    item = {}
    out = mod.collect_visit_tabs(tmp_path, CTX, item, {"xn": lambda: [], "cdha": lambda: []})
    assert out == {"xn": "empty", "cdha": "empty"}
    assert item["status"] == "done" and item["counts"] == {"xn": 0, "cdha": 0}


def test_structure_change_is_blocked_with_reason(tmp_path):
    item = {}
    out = mod.collect_visit_tabs(tmp_path, CTX, item, {
        "xn": _raise(mod.TabStructureError("Tab XN có nội dung nhưng không có bảng")),
        "cdha": lambda: [],
    })
    assert out["xn"] == "blocked"
    assert item["tab_reason"]["xn"].startswith("emr_ui_changed")
    assert item["status"] == "incomplete"


def test_now_empty_but_previously_had_data_is_not_overwritten(tmp_path):
    mod.write_csv_rows(tmp_path / "lich_su_xn.csv", mod.COL_XN, [_xn("12")])
    item = {"xn": "done", "cdha": "done", "committed": True, "popup": "done", "status": "done"}
    out = mod.collect_visit_tabs(tmp_path, CTX, item, {"xn": lambda: [], "cdha": lambda: []}, requested={"xn"})
    assert out["xn"] == "blocked"
    assert item["tab_reason"]["xn"] == "emr_now_empty_previously_had_data"
    assert [r["Kết quả"] for r in _read(tmp_path / "lich_su_xn.csv")] == ["12"], "không được xóa dữ liệu cũ"
    assert out["cdha"] == "done", "tab không được yêu cầu thì giữ nguyên"


def test_session_loss_is_raised_to_stop_run(tmp_path):
    item = {}
    with pytest.raises(RuntimeError):
        mod.collect_visit_tabs(tmp_path, CTX, item, {
            "xn": _raise(RuntimeError("invalid session id")),
            "cdha": lambda: [],
        })
    assert item["xn"] == "error"


def test_legacy_done_without_commit_is_not_trusted():
    # Progress cũ: XN "done" nhưng CĐHA lỗi → trước đây cả lượt KHÔNG commit, XN chưa hề vào CSV.
    legacy = {"popup": "done", "xn": "done", "cdha": "error", "committed": False, "status": "incomplete"}
    assert mod.tab_is_final(legacy, "xn") is False
    assert mod.visit_needs_fetch(legacy, None) is True
    committed = {"popup": "done", "xn": "done", "cdha": "done", "committed": True, "status": "done"}
    assert mod.is_patient_done({"k": committed}, "k") is True
    assert mod.visit_needs_fetch(committed, None) is False
    assert mod.visit_needs_fetch(committed, {"cdha"}) is True


def test_refetch_parts_and_source_outcome():
    assert mod.parse_refetch_parts({"refetch_parts": "xn;cdha"}) == {"xn", "cdha"}
    assert mod.parse_refetch_parts({"refetch_parts": "profile"}) == set()
    assert mod.parse_refetch_parts({}) is None
    progress = {}
    key = mod.mark_source_outcome(progress, {"Research key": "enc_1", "Mã NC": "NC0001", "Mã BN": "BN1"},
                                  "blocked", "encounter_not_identified: x")
    assert key == "source:enc_1"
    entry = progress[key]
    assert entry["xn"] == "blocked" and entry["cdha"] == "blocked" and entry["Research key"] == "enc_1"
    assert mod.mark_source_outcome(progress, {"Mã BN": "BN1"}, "blocked", "x") is None
