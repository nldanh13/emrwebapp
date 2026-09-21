# -*- coding: utf-8 -*-
"""Tài khoản EMR theo điều dưỡng (server/utils/nurse_emr_accounts.js) và phân
quyền admin cho /api/nurse-emr-accounts (server/services/authz.js)."""
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


def test_nurse_emr_accounts_route_requires_admin_role():
    authz = json.dumps(str(ROOT / "server" / "services" / "authz.js"))
    result = json.loads(run_node(
        f"const a=require({authz}); "
        "const paths=[['GET','/nurse-emr-accounts'],['POST','/nurse-emr-accounts']]; "
        "console.log(JSON.stringify(paths.map(([method,path])=>a.requiredRoleForRequest({method,path}))));"
    ))
    assert result == ["admin", "admin"]


def test_write_then_read_round_trip(tmp_path):
    module = json.dumps(str(ROOT / "server" / "utils" / "nurse_emr_accounts.js"))
    accounts_file = tmp_path / "nurse_emr_accounts.json"
    source = f"""
      const m=require({module});
      m.writeNurseEmrAccounts([
        {{name:'  Lê Ngọc Diệu  ', emr_username:'dieu.emr', emr_password:'secret1'}},
        {{name:'Lê Thị Tuyết Đoan', emr_username:'doan.emr', emr_password:'secret2'}},
      ]);
      console.log(JSON.stringify(m.readNurseEmrAccounts()));
    """
    result = json.loads(run_node(source, env={"EMR_NURSE_ACCOUNTS_FILE": str(accounts_file)}))
    assert result == [
        {"name": "Lê Ngọc Diệu", "emr_username": "dieu.emr", "emr_password": "secret1"},
        {"name": "Lê Thị Tuyết Đoan", "emr_username": "doan.emr", "emr_password": "secret2"},
    ]
    assert accounts_file.exists()
    on_disk = json.loads(accounts_file.read_text(encoding="utf-8"))
    assert on_disk == result


def test_write_dedupes_by_normalized_name_last_one_wins(tmp_path):
    module = json.dumps(str(ROOT / "server" / "utils" / "nurse_emr_accounts.js"))
    accounts_file = tmp_path / "nurse_emr_accounts.json"
    source = f"""
      const m=require({module});
      const result = m.writeNurseEmrAccounts([
        {{name:'Lê Ngọc Diệu', emr_username:'old', emr_password:'old-pass'}},
        {{name:'', emr_username:'ignored', emr_password:'ignored'}},
        {{name:'Lê Ngọc Diệu', emr_username:'new', emr_password:'new-pass'}},
      ]);
      console.log(JSON.stringify(result));
    """
    result = json.loads(run_node(source, env={"EMR_NURSE_ACCOUNTS_FILE": str(accounts_file)}))
    assert result == [{"name": "Lê Ngọc Diệu", "emr_username": "new", "emr_password": "new-pass"}]


def test_read_missing_file_returns_empty_list(tmp_path):
    module = json.dumps(str(ROOT / "server" / "utils" / "nurse_emr_accounts.js"))
    missing_file = tmp_path / "does_not_exist.json"
    result = json.loads(run_node(
        f"const m=require({module}); console.log(JSON.stringify(m.readNurseEmrAccounts()));",
        env={"EMR_NURSE_ACCOUNTS_FILE": str(missing_file)},
    ))
    assert result == []
