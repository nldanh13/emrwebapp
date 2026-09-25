"""
shared/secret_store.py — Nơi DUY NHẤT worker đọc mật khẩu/token/khóa.

Bản Python của server/services/secret_store.js — cùng đọc danh mục
config/secrets_manifest.json và cùng thư mục secrets/:
  secrets/secrets.json            — mật khẩu EMR, token, API key...
  secrets/users.json              — tài khoản đăng nhập app
  secrets/nurse_emr_accounts.json — tài khoản EMR theo tên điều dưỡng

Thứ tự ưu tiên cho mỗi bí mật (cao → thấp):
  1. Biến môi trường (EMR_PASSWORD...) — server truyền tài khoản EMR riêng của
     người đang thao tác qua đây nên luôn phải thắng
  2. File chứa giá trị (EMR_PASSWORD_FILE=/đường/dẫn)
  3. secrets/secrets.json
  4. (Chỉ các khóa cũ) config/config.json — bị chặn khi EMR_REQUIRE_SECRET_ENV=1

Không đặt tên module là secrets.py để khỏi che module chuẩn `secrets`.
"""
from __future__ import annotations

import json
import os
import sys
from functools import lru_cache
from typing import Any, Dict, Optional, Tuple

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MANIFEST_PATH = os.path.join(ROOT_DIR, "config", "secrets_manifest.json")

SOURCE_ENV = "env"
SOURCE_ENV_FILE = "env_file"
SOURCE_SECRETS_FILE = "secrets_file"
SOURCE_LEGACY_CONFIG = "legacy_config"
SOURCE_NONE = ""


@lru_cache(maxsize=1)
def load_manifest() -> Dict[str, Any]:
    with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
        raw = json.load(f)
    secrets = [s for s in (raw.get("secrets") or []) if isinstance(s, dict) and s.get("key")]
    files = [f for f in (raw.get("files") or []) if isinstance(f, dict) and f.get("name")]
    return {
        "secrets": secrets,
        "files": files,
        "by_key": {s["key"]: s for s in secrets},
        "file_by_name": {f["name"]: f for f in files},
    }


def _from_root(path: str) -> str:
    return path if os.path.isabs(path) else os.path.join(ROOT_DIR, path)


def secrets_dir() -> str:
    configured = str(os.environ.get("EMR_SECRETS_DIR", "") or "").strip()
    return _from_root(configured) if configured else os.path.join(ROOT_DIR, "secrets")


def secrets_file_path() -> str:
    return os.path.join(secrets_dir(), "secrets.json")


def _read_json_object(path: str) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return {}
    except Exception as exc:
        print(f"[secret_store] {path} không đọc được JSON — bỏ qua: {exc}", file=sys.stderr)
        return {}
    return data if isinstance(data, dict) else {}


def read_secrets_file() -> Dict[str, Any]:
    return _read_json_object(secrets_file_path())


def _get_path(obj: Any, dotted: str) -> Any:
    cur = obj
    for part in str(dotted or "").split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def _text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _read_env_file(env_name: str) -> str:
    path = _text(os.environ.get(f"{env_name}_FILE"))
    if not path:
        return ""
    try:
        with open(_from_root(path), "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception as exc:
        print(f"[secret_store] Không đọc được {env_name}_FILE: {exc}", file=sys.stderr)
        return ""


def resolve_secret(
    key: str,
    legacy_config: Optional[Dict[str, Any]] = None,
    secrets_data: Optional[Dict[str, Any]] = None,
) -> Tuple[str, str]:
    """Trả về (giá trị, nguồn). Không bao giờ log giá trị."""
    spec = load_manifest()["by_key"].get(key)
    if spec is None:
        raise KeyError(f"Bí mật chưa khai báo trong config/secrets_manifest.json: {key}")

    value = _text(os.environ.get(spec["env"]))
    if value:
        return value, SOURCE_ENV
    value = _read_env_file(spec["env"])
    if value:
        return value, SOURCE_ENV_FILE
    data = secrets_data if secrets_data is not None else read_secrets_file()
    value = _text(_get_path(data, spec.get("path", "")))
    if value:
        return value, SOURCE_SECRETS_FILE
    legacy_key = spec.get("legacy_config_key")
    if legacy_key and isinstance(legacy_config, dict):
        value = _text(legacy_config.get(legacy_key))
        if value:
            return value, SOURCE_LEGACY_CONFIG
    return "", SOURCE_NONE


def get_secret(key: str, default: str = "") -> str:
    value, _ = resolve_secret(key)
    return value or default


def apply_secrets_to_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """Điền các khóa tài khoản EMR (username/password/hchanh_*/infusion_*) vào
    config đã merge, theo đúng thứ tự ưu tiên ở trên — code worker cũ vẫn đọc
    config["password"]... như trước, không phải sửa từng nơi."""
    out = dict(config or {})
    secrets_data = read_secrets_file()
    require_env = _text(os.environ.get("EMR_REQUIRE_SECRET_ENV")).lower() in {"1", "true", "yes", "on"}
    from_legacy = []
    for spec in load_manifest()["secrets"]:
        legacy_key = spec.get("legacy_config_key")
        if not legacy_key:
            continue
        value, source = resolve_secret(spec["key"], legacy_config=out, secrets_data=secrets_data)
        if source == SOURCE_LEGACY_CONFIG:
            from_legacy.append(legacy_key)
        elif value:
            out[legacy_key] = value
    if require_env and from_legacy:
        raise RuntimeError(
            "Mật khẩu dạng rõ trong config/config.json đã bị chặn bởi EMR_REQUIRE_SECRET_ENV. "
            f"Hãy chuyển các khóa sau sang secrets/secrets.json (npm run secrets:migrate) "
            f"hoặc biến môi trường: {', '.join(from_legacy)}"
        )
    return out


def resolve_secret_file(name: str) -> Tuple[str, str]:
    """Đường dẫn users.json / nurse_emr_accounts.json. Trả về (path, mode) với mode
    'env' | 'secrets' | 'legacy' — cùng quy tắc với secret_store.js."""
    spec = load_manifest()["file_by_name"].get(name)
    if spec is None:
        raise KeyError(f"File bí mật chưa khai báo trong config/secrets_manifest.json: {name}")
    configured = _text(os.environ.get(spec["env"]))
    if configured:
        return _from_root(configured), "env"
    in_secrets = os.path.join(secrets_dir(), name)
    if os.path.exists(in_secrets):
        return in_secrets, "secrets"
    legacy = _from_root(spec["legacy"]) if spec.get("legacy") else ""
    if legacy and os.path.exists(legacy):
        return legacy, "legacy"
    return in_secrets, "secrets"
