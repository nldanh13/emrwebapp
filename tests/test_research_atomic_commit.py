import importlib.util
import sys
import types
from pathlib import Path

# Các test commit không dùng Selenium; stub import để test chạy được cả môi trường CI tối giản.
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
spec = importlib.util.spec_from_file_location("research_xn_cdha", MOD_PATH)
research_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(research_mod)
for _name, _module in _saved_selenium_modules.items():
    if _module is None:
        sys.modules.pop(_name, None)
    else:
        sys.modules[_name] = _module


def _row(code, patient, marker):
    return {"Mã NC": code, "Mã BN": patient, "Trạng thái": marker}


def test_prepare_does_not_delete_previous_good_snapshot(tmp_path):
    xn_path = tmp_path / "lich_su_xn.csv"
    cdha_path = tmp_path / "lich_su_cdha.csv"
    research_mod.write_csv_rows(xn_path, research_mod.COL_XN, [_row("NC1", "P1", "old-xn")])
    research_mod.write_csv_rows(cdha_path, research_mod.COL_CDHA, [_row("NC1", "P1", "old-cdha")])

    research_mod.prepare_patient_commit(tmp_path, {"Mã NC": "NC1", "Mã BN": "P1"})

    assert research_mod.read_csv_rows(xn_path)[0]["Trạng thái"] == "old-xn"
    assert research_mod.read_csv_rows(cdha_path)[0]["Trạng thái"] == "old-cdha"


def test_commit_replaces_only_target_encounter_after_both_tables_ready(tmp_path):
    xn_path = tmp_path / "lich_su_xn.csv"
    cdha_path = tmp_path / "lich_su_cdha.csv"
    research_mod.write_csv_rows(xn_path, research_mod.COL_XN, [
        _row("NC1", "P1", "old-xn"),
        _row("NC2", "P1", "other-xn"),
    ])
    research_mod.write_csv_rows(cdha_path, research_mod.COL_CDHA, [
        _row("NC1", "P1", "old-cdha"),
        _row("NC2", "P1", "other-cdha"),
    ])

    research_mod.commit_patient_outputs(
        tmp_path,
        {"xn": [_row("NC1", "P1", "new-xn")], "cdha": [_row("NC1", "P1", "new-cdha")]},
        {"Mã NC": "NC1", "Mã BN": "P1"},
    )

    xn = research_mod.read_csv_rows(xn_path)
    cdha = research_mod.read_csv_rows(cdha_path)
    assert {(r["Mã NC"], r["Trạng thái"]) for r in xn} == {("NC1", "new-xn"), ("NC2", "other-xn")}
    assert {(r["Mã NC"], r["Trạng thái"]) for r in cdha} == {("NC1", "new-cdha"), ("NC2", "other-cdha")}


def test_recover_interrupted_commit_restores_marked_targets(tmp_path):
    xn_path = tmp_path / "lich_su_xn.csv"
    cdha_path = tmp_path / "lich_su_cdha.csv"
    research_mod.write_csv_rows(xn_path, research_mod.COL_XN, [_row("NC1", "P1", "new-xn-half-committed")])
    research_mod.write_csv_rows(cdha_path, research_mod.COL_CDHA, [_row("NC1", "P1", "new-cdha-half-committed")])

    staging = tmp_path / ".commit_crash"
    staging.mkdir()
    research_mod.write_csv_rows(staging / "lich_su_xn.csv.backup", research_mod.COL_XN, [_row("NC1", "P1", "old-xn")])
    research_mod.write_csv_rows(staging / "lich_su_cdha.csv.backup", research_mod.COL_CDHA, [_row("NC1", "P1", "old-cdha")])
    assert research_mod._write_json_atomic(staging / "state.json", {
        "phase": "replacing",
        "replace_targets": ["lich_su_xn.csv", "lich_su_cdha.csv"],
    })

    research_mod.recover_interrupted_patient_commits(tmp_path)

    assert research_mod.read_csv_rows(xn_path)[0]["Trạng thái"] == "old-xn"
    assert research_mod.read_csv_rows(cdha_path)[0]["Trạng thái"] == "old-cdha"
    assert not staging.exists()
