# -*- coding: utf-8 -*-
"""Nơi quản lý bí mật chung phía worker (shared/secret_store.py) và cách
load_config() điền tài khoản EMR từ đó. Mọi mật khẩu dưới đây là giả."""
import json

import pytest

import utils
from shared import secret_store


@pytest.fixture
def secrets_dir(tmp_path, monkeypatch):
    for spec in secret_store.load_manifest()["secrets"]:
        monkeypatch.delenv(spec["env"], raising=False)
        monkeypatch.delenv(spec["env"] + "_FILE", raising=False)
    for spec in secret_store.load_manifest()["files"]:
        monkeypatch.delenv(spec["env"], raising=False)
    monkeypatch.delenv("EMR_REQUIRE_SECRET_ENV", raising=False)
    d = tmp_path / "secrets"
    d.mkdir()
    monkeypatch.setenv("EMR_SECRETS_DIR", str(d))
    return d


def _write(path, data):
    path.write_text(json.dumps(data), encoding="utf-8")


def test_secrets_file_ghi_de_config_cu(secrets_dir):
    _write(secrets_dir / "secrets.json", {"emr": {"password": "p-file"}, "hchanh": {"username": "hc", "password": "p-hc"}})
    out = secret_store.apply_secrets_to_config({"username": "dd01", "password": "p-cu", "headless": True})
    assert out["password"] == "p-file"
    assert out["username"] == "dd01"  # chưa chuyển thì vẫn dùng config cũ
    assert out["hchanh_username"] == "hc"
    assert out["hchanh_password"] == "p-hc"
    assert out["headless"] is True


def test_env_luon_thang_de_server_truyen_tai_khoan_rieng(secrets_dir, monkeypatch):
    _write(secrets_dir / "secrets.json", {"emr": {"username": "chung", "password": "p-chung"}})
    monkeypatch.setenv("EMR_USERNAME", "rieng")
    monkeypatch.setenv("EMR_PASSWORD", "p-rieng")
    out = secret_store.apply_secrets_to_config({})
    assert (out["username"], out["password"]) == ("rieng", "p-rieng")


def test_env_file(secrets_dir, tmp_path, monkeypatch):
    value_file = tmp_path / "pw.txt"
    value_file.write_text("p-tu-file\n", encoding="utf-8")
    monkeypatch.setenv("EMR_HCHANH_PASSWORD_FILE", str(value_file))
    assert secret_store.resolve_secret("hchanh_password") == ("p-tu-file", "env_file")


def test_require_secret_env_chan_mat_khau_trong_config_cu(secrets_dir, monkeypatch):
    monkeypatch.setenv("EMR_REQUIRE_SECRET_ENV", "1")
    with pytest.raises(RuntimeError, match="password"):
        secret_store.apply_secrets_to_config({"password": "p-cu"})
    _write(secrets_dir / "secrets.json", {"emr": {"password": "p-file"}})
    assert secret_store.apply_secrets_to_config({"password": "p-cu"})["password"] == "p-file"


def test_load_config_dung_secret_store(secrets_dir, monkeypatch):
    _write(secrets_dir / "secrets.json", {"infusion": {"username": "dt", "password": "p-dt"}})
    monkeypatch.setattr(utils.os.path, "isfile", lambda p: False)
    cfg = utils.load_config()
    assert cfg["infusion_username"] == "dt"
    assert cfg["infusion_password"] == "p-dt"


def test_resolve_secret_file(secrets_dir, monkeypatch):
    path, mode = secret_store.resolve_secret_file("nurse_emr_accounts.json")
    assert mode in {"secrets", "legacy"}
    _write(secrets_dir / "nurse_emr_accounts.json", [])
    assert secret_store.resolve_secret_file("nurse_emr_accounts.json") == (str(secrets_dir / "nurse_emr_accounts.json"), "secrets")
    monkeypatch.setenv("EMR_NURSE_ACCOUNTS_FILE", "/tmp/khac.json")
    assert secret_store.resolve_secret_file("nurse_emr_accounts.json") == ("/tmp/khac.json", "env")


def test_hchanh_khong_con_mat_khau_mac_dinh():
    import hchanh_fetch

    with pytest.raises(RuntimeError, match="secrets"):
        hchanh_fetch._build_hchanh_config({"username": "chung", "password": "p"})
    cfg = hchanh_fetch._build_hchanh_config({"hchanh_username": "hc", "hchanh_password": "p-hc"})
    assert (cfg["username"], cfg["password"]) == ("hc", "p-hc")
