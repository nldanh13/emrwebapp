import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REGISTRY_PATH = ROOT / "config" / "feature_registry.json"


def load_registry():
    return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))


def test_feature_registry_has_unique_navigation_and_function_ids():
    registry = load_registry()
    navigation = registry.get("navigation") or []
    functions = registry.get("functions") or []
    workflows = registry.get("workflows") or []

    nav_ids = [item.get("id") for item in navigation]
    function_ids = [item.get("id") for item in functions]
    workflow_ids = [item.get("id") for item in workflows]

    assert nav_ids and len(nav_ids) == len(set(nav_ids))
    assert function_ids and len(function_ids) == len(set(function_ids))
    assert workflow_ids and len(workflow_ids) == len(set(workflow_ids))


def test_every_feature_and_workflow_resolves_to_existing_tab_and_steps():
    registry = load_registry()
    nav_ids = {item["id"] for item in registry["navigation"]}
    function_ids = {item["id"] for item in registry["functions"]}

    for feature in registry["functions"]:
        assert feature["entryTab"] in nav_ids
        assert feature.get("label")
        assert feature.get("description")
        assert isinstance(feature.get("requires", []), list)
        assert isinstance(feature.get("provides", []), list)
        assert isinstance(feature.get("actions", []), list)

    for workflow in registry["workflows"]:
        assert workflow["entryTab"] in nav_ids
        assert workflow.get("steps")
        step_features = {step if isinstance(step, str) else step.get("feature", step.get("id")) for step in workflow["steps"]}
        assert step_features.issubset(function_ids)
        step_ids = [step if isinstance(step, str) else step.get("id") for step in workflow["steps"]]
        assert len(step_ids) == len(set(step_ids))


def test_core_requested_functions_are_registered():
    registry = load_registry()
    function_ids = {item["id"] for item in registry["functions"]}
    expected = {
        "patient.fetch-list",
        "orders.fetch",
        "orders.classify",
        "care.input",
        "infusion.input",
        "procedure.input",
        "billing.fetch",
        "billing.print",
        "input.verify",
    }
    assert expected.issubset(function_ids)


def test_frontend_and_backend_mount_shared_feature_registry():
    app_source = (ROOT / "src" / "App.jsx").read_text(encoding="utf-8")
    route_index = (ROOT / "server" / "routes" / "index.js").read_text(encoding="utf-8")
    feature_route = (ROOT / "server" / "routes" / "features.js").read_text(encoding="utf-8")

    assert "NAV_ENTRIES" in app_source
    assert "FunctionHubTab" in app_source
    assert "require('./features')" in route_index
    assert "feature_registry" in feature_route
    assert "require('./workflows')" in route_index
    assert "featureGate" in route_index
    assert "require('./report')" in route_index
    assert "require('./care_baseline')" in route_index


def test_frontend_registry_initializes_before_react_render(tmp_path):
    """Regression: sorting a frozen navigation array crashed the module and caused a white screen."""
    import subprocess

    registry = load_registry()
    source = (ROOT / "src" / "features" / "registry.js").read_text(encoding="utf-8")
    source = source.replace(
        "import registry from '../../config/feature_registry.json';",
        f"const registry = {json.dumps(registry, ensure_ascii=False)};",
        1,
    )
    source += "\nif (!Object.isFrozen(NAV_ENTRIES)) throw new Error('NAV_ENTRIES must be frozen');"
    source += "\nif (NAV_ENTRIES[0]?.id !== 'functions') throw new Error('navigation order is invalid');\n"

    module_path = tmp_path / "registry-runtime.mjs"
    module_path.write_text(source, encoding="utf-8")
    result = subprocess.run(
        ["node", str(module_path)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stderr or result.stdout


def test_bootstrap_guard_prevents_blank_screen_on_module_failure():
    index_source = (ROOT / "index.html").read_text(encoding="utf-8")
    guard_source = (ROOT / "src" / "bootstrapGuard.js").read_text(encoding="utf-8")
    boundary_source = (ROOT / "src" / "components" / "AppErrorBoundary.jsx").read_text(encoding="utf-8")

    assert "Đang tải giao diện EMR" in index_source
    assert "/src/bootstrapGuard.js" in index_source
    assert "unhandledrejection" in guard_source
    assert "Lỗi khởi tạo giao diện" in guard_source
    assert "emr_active_tab_v2" in guard_source
    assert "emr_active_tab_v2" in boundary_source


def test_registry_v2_has_runtime_policies_and_executors():
    registry = load_registry()
    assert registry["version"] >= 2
    assert registry.get("defaults", {}).get("feature", {}).get("disabledPolicy") == "skip"
    by_id = {item["id"]: item for item in registry["functions"]}
    for feature_id in ["care.input", "infusion.input", "procedure.input", "orders.fetch"]:
        feature = by_id[feature_id]
        assert isinstance(feature.get("executor"), dict)
        assert feature["executor"].get("type") in {"http", "virtual", "manual"}
        assert feature.get("enabled") is True
    assert by_id["input.precheck"].get("protected") is True
    assert by_id["care.input"]["requires"][0] == "care.precheck-token"


def test_ward_workflow_prechecks_are_split_by_input_branch():
    registry = load_registry()
    ward = next(item for item in registry["workflows"] if item["id"] == "ward-input")
    steps = {step["id"]: step for step in ward["steps"]}
    assert steps["care.precheck"]["inject"]["taskName"] == "input_care"
    assert steps["infusion.precheck"]["inject"]["taskName"] == "input_infusions"
    assert steps["procedure.precheck"]["inject"]["taskName"] == "input_procedures"
    assert steps["care.input"]["requires"] == ["care.precheck-token", "nurse.schedule"]
