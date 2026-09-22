# -*- coding: utf-8 -*-
"""Ảnh chữ ký theo điều dưỡng/bác sĩ (server/utils/nurse_signatures.js) — dùng
để tự động chèn chữ ký vào bộ phiếu "IN RA VIỆN" (worker/sign_discharge_bundle.py)."""
import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# 1x1 PNG trong suốt hợp lệ, base64.
TINY_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)
TINY_PNG_DATA_URL = f"data:image/png;base64,{TINY_PNG_B64}"


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


def _env(tmp_path):
    return {
        "EMR_NURSE_ACCOUNTS_FILE": str(tmp_path / "nurse_emr_accounts.json"),
        "EMR_NURSE_SIGNATURES_DIR": str(tmp_path / "signatures"),
    }


def test_save_signature_creates_file_and_row(tmp_path):
    module = json.dumps(str(ROOT / "server" / "utils" / "nurse_signatures.js"))
    source = f"""
      const m=require({module});
      const accounts = m.saveSignatureImage('Lê Ngọc Diệu', '{TINY_PNG_DATA_URL}');
      console.log(JSON.stringify(accounts));
    """
    accounts = json.loads(run_node(source, env=_env(tmp_path)))
    assert len(accounts) == 1
    assert accounts[0]["name"] == "Lê Ngọc Diệu"
    assert accounts[0]["signature_file"].endswith(".png")

    sig_dir = tmp_path / "signatures"
    files = list(sig_dir.glob("*.png"))
    assert len(files) == 1
    assert files[0].name == accounts[0]["signature_file"]


def test_save_signature_reupload_replaces_old_file(tmp_path):
    module = json.dumps(str(ROOT / "server" / "utils" / "nurse_signatures.js"))
    source = f"""
      const m=require({module});
      m.saveSignatureImage('Lê Ngọc Diệu', '{TINY_PNG_DATA_URL}');
      const accounts = m.saveSignatureImage('Lê Ngọc Diệu', '{TINY_PNG_DATA_URL}');
      console.log(JSON.stringify(accounts));
    """
    accounts = json.loads(run_node(source, env=_env(tmp_path)))
    assert len(accounts) == 1

    sig_dir = tmp_path / "signatures"
    files = list(sig_dir.glob("*.png"))
    # Ảnh cũ đã bị xóa khi tải ảnh mới — chỉ còn đúng 1 file trên đĩa.
    assert len(files) == 1
    assert files[0].name == accounts[0]["signature_file"]


def test_save_signature_keeps_existing_emr_account_fields(tmp_path):
    module = json.dumps(str(ROOT / "server" / "utils" / "nurse_signatures.js"))
    nea_module = json.dumps(str(ROOT / "server" / "utils" / "nurse_emr_accounts.js"))
    source = f"""
      const nea=require({nea_module});
      nea.writeNurseEmrAccounts([{{name:'Lê Ngọc Diệu', emr_username:'dieu.emr', emr_password:'secret1'}}]);
      const m=require({module});
      const accounts = m.saveSignatureImage('Lê Ngọc Diệu', '{TINY_PNG_DATA_URL}');
      console.log(JSON.stringify(accounts));
    """
    accounts = json.loads(run_node(source, env=_env(tmp_path)))
    assert len(accounts) == 1
    assert accounts[0]["emr_username"] == "dieu.emr"
    assert accounts[0]["emr_password"] == "secret1"
    assert accounts[0]["signature_file"].endswith(".png")


def test_remove_signature_deletes_file_and_field_but_keeps_emr_account(tmp_path):
    module = json.dumps(str(ROOT / "server" / "utils" / "nurse_signatures.js"))
    source = f"""
      const m=require({module});
      m.saveSignatureImage('Lê Ngọc Diệu', '{TINY_PNG_DATA_URL}');
      const before = m.saveSignatureImage.name; // no-op reference to avoid lint unused
      const accounts = m.removeSignatureImage('Lê Ngọc Diệu');
      console.log(JSON.stringify(accounts));
    """
    accounts = json.loads(run_node(source, env=_env(tmp_path)))
    assert len(accounts) == 1
    assert "signature_file" not in accounts[0]

    sig_dir = tmp_path / "signatures"
    assert list(sig_dir.glob("*.png")) == []


def test_read_signature_data_url_round_trip(tmp_path):
    module = json.dumps(str(ROOT / "server" / "utils" / "nurse_signatures.js"))
    source = f"""
      const m=require({module});
      const accounts = m.saveSignatureImage('Lê Ngọc Diệu', '{TINY_PNG_DATA_URL}');
      const dataUrl = m.readSignatureDataUrl(accounts[0].signature_file);
      console.log(JSON.stringify({{dataUrl}}));
    """
    result = json.loads(run_node(source, env=_env(tmp_path)))
    assert result["dataUrl"] == TINY_PNG_DATA_URL


def test_with_signature_data_urls_attaches_null_when_no_signature(tmp_path):
    module = json.dumps(str(ROOT / "server" / "utils" / "nurse_signatures.js"))
    source = f"""
      const m=require({module});
      const rows = m.withSignatureDataUrls([{{name: 'Người Chưa Có Chữ Ký'}}]);
      console.log(JSON.stringify(rows));
    """
    rows = json.loads(run_node(source, env=_env(tmp_path)))
    assert rows == [{"name": "Người Chưa Có Chữ Ký", "signature_data_url": None}]


def test_save_signature_rejects_non_image_data_url(tmp_path):
    module = json.dumps(str(ROOT / "server" / "utils" / "nurse_signatures.js"))
    source = f"""
      const m=require({module});
      try {{
        m.saveSignatureImage('Lê Ngọc Diệu', 'data:text/plain;base64,aGVsbG8=');
        console.log(JSON.stringify({{threw: false}}));
      }} catch (e) {{
        console.log(JSON.stringify({{threw: true, message: String(e.message)}}));
      }}
    """
    result = json.loads(run_node(source, env=_env(tmp_path)))
    assert result["threw"] is True


def test_save_signature_rejects_empty_name(tmp_path):
    module = json.dumps(str(ROOT / "server" / "utils" / "nurse_signatures.js"))
    source = f"""
      const m=require({module});
      try {{
        m.saveSignatureImage('', '{TINY_PNG_DATA_URL}');
        console.log(JSON.stringify({{threw: false}}));
      }} catch (e) {{
        console.log(JSON.stringify({{threw: true}}));
      }}
    """
    result = json.loads(run_node(source, env=_env(tmp_path)))
    assert result["threw"] is True


def test_nurse_emr_accounts_signature_routes_require_admin_role():
    authz = json.dumps(str(ROOT / "server" / "services" / "authz.js"))
    result = json.loads(run_node(
        f"const a=require({authz}); "
        "const paths=[['POST','/nurse-emr-accounts/signature'],"
        "['DELETE','/nurse-emr-accounts/signature/Le%20Ngoc%20Dieu']]; "
        "console.log(JSON.stringify(paths.map(([method,path])=>a.requiredRoleForRequest({method,path}))));"
    ))
    assert result == ["admin", "admin"]
