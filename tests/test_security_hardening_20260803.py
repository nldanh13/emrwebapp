# -*- coding: utf-8 -*-
import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run_node(source: str, *, env=None):
    merged = os.environ.copy()
    merged.update(env or {})
    proc = subprocess.run(
        ["node", "-e", source],
        cwd=ROOT,
        env=merged,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr or proc.stdout
    return proc.stdout.strip()


def test_durable_task_journal_marks_interrupted_after_restart(tmp_path):
    journal = json.dumps(str(ROOT / "server" / "services" / "task_journal.js"))
    env = {"EMR_RUNTIME_ROOT": str(tmp_path / "runtime")}
    task_id = run_node(
        f"const j=require({journal}); const id=j.createTask({{sid:'S1',task_type:'care'}}); j.updateTask(id,'running'); console.log(id);",
        env=env,
    )
    payload = json.loads(run_node(
        f"const j=require({journal}); console.log(JSON.stringify(j.getTask({json.dumps(task_id)})));",
        env=env,
    ))
    assert payload["status"] == "unknown_after_restart"
    assert payload["error_code"] == "PROCESS_RESTARTED"
    assert (tmp_path / "runtime" / "task_journal" / "task_events.jsonl").exists()


def test_multi_user_token_resolves_role_without_legacy_token(tmp_path):
    authz = json.dumps(str(ROOT / "server" / "services" / "authz.js"))
    users = [{
        "id": "operator01",
        "name": "Operator 01",
        "role": "operator",
        "token": "a-secure-token-with-more-than-16-chars",
        "sessions": ["ward-a"],
    }]
    source = f"""
      const auth=require({authz});
      const req={{method:'GET',path:'/health',query:{{}},get:(name)=>name==='x-app-token'?'a-secure-token-with-more-than-16-chars':''}};
      const res={{status:()=>res,json:(value)=>{{console.log(JSON.stringify(value)); process.exit(1);}}}};
      auth.authenticateRequest(req,res,()=>console.log(JSON.stringify(req.auth)));
    """
    payload = json.loads(run_node(source, env={
        "EMR_RUNTIME_ROOT": str(tmp_path / "runtime"),
        "EMR_USERS_JSON": json.dumps(users),
        "EMR_APP_TOKEN": "",
        "HOST": "127.0.0.1",
    }))
    assert payload["id"] == "operator01"
    assert payload["role"] == "operator"
    assert payload["sessions"] == ["ward-a"]


def test_critical_json_is_quarantined_instead_of_returning_empty(tmp_path):
    file_module = json.dumps(str(ROOT / "server" / "utils" / "file.js"))
    broken = tmp_path / "done_state.json"
    broken.write_text("{not-json", encoding="utf-8")
    source = f"""
      const f=require({file_module});
      try {{ f.readJsonCritical({json.dumps(str(broken))}, {{}}); process.exit(2); }}
      catch (err) {{ console.log(JSON.stringify({{code:err.code, quarantine:err.quarantinePath}})); }}
    """
    payload = json.loads(run_node(source))
    assert payload["code"] == "CRITICAL_JSON_CORRUPT"
    assert Path(payload["quarantine"]).exists()
    assert not broken.exists()


def test_session_retention_is_disabled_by_default(tmp_path):
    session_module = json.dumps(str(ROOT / "server" / "services" / "session.js"))
    payload = json.loads(run_node(
        f"const s=require({session_module}); console.log(JSON.stringify(s.cleanOldSessions()));",
        env={
            "EMR_RUNTIME_ROOT": str(tmp_path / "runtime"),
            "EMR_SESSION_RETENTION_MODE": "",
        },
    ))
    assert payload == {"mode": "disabled", "scanned": 0, "archived": 0, "deleted": 0}


def test_public_sheet_and_identified_export_are_opt_in():
    constants = (ROOT / "server" / "constants.js").read_text(encoding="utf-8")
    research = (ROOT / "server" / "routes" / "research.js").read_text(encoding="utf-8")
    sheet = (ROOT / "server" / "utils" / "google_sheet_records.js").read_text(encoding="utf-8")
    assert "EMR_ALLOW_PUBLIC_GOOGLE_SHEET" in constants
    assert "EMR_ALLOW_IDENTIFIED_RESEARCH_EXPORT" in constants
    assert "researchResponseShouldRedact" in research
    assert "ALLOW_IDENTIFIED_RESEARCH_EXPORT" in research
    assert "allow_public" in sheet


def test_legacy_get_routes_are_authorized_by_side_effect_not_http_verb(tmp_path):
    authz = json.dumps(str(ROOT / "server" / "services" / "authz.js"))
    result = json.loads(run_node(
        f"const a=require({authz}); const paths=['/run-scan','/run-postprocess','/run-report-infusion','/export-data','/get-raw']; console.log(JSON.stringify(Object.fromEntries(paths.map(path=>[path,a.requiredRoleForRequest({{method:'GET',path}})]))));",
        env={"EMR_RUNTIME_ROOT": str(tmp_path / "runtime")},
    ))
    assert result["/run-scan"] == "operator"
    assert result["/run-postprocess"] == "operator"
    assert result["/run-report-infusion"] == "operator"
    assert result["/get-raw"] == "operator"
    assert result["/export-data"] == "supervisor"
