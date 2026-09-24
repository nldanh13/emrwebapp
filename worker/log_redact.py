"""Che thông tin định danh / mã phiên trong dòng log của worker.

Bản Python của server/utils/log_redact.js — hai bản phải cho cùng kết quả (kiểm bằng
scripts/log_redact_test.js). Muối lấy từ LOG_REDACT_SALT do server truyền vào, nên cùng
một Mã BN có cùng nhãn BN#xxxxxx ở console lẫn action_log.txt trong một lần chạy server.
Chỉ đổi phần hiển thị trong log; không đụng dữ liệu nghiên cứu.
"""

import hashlib
import os
import re
import secrets

_SALT = os.environ.get("LOG_REDACT_SALT") or secrets.token_hex(16)

_SAFE_URL_PARAMS = {"wpid", "wpre", "nextlink", "scope", "lang", "tt", "tg"}

_URL_RE = re.compile(r"https?://[^\s'\"<>]+", re.IGNORECASE)
_PARAM_RE = re.compile(r"\b(usid|noitruid|dieutriid|vaovienid|benhnhanid|keyword|kp)=([^\s&'\"]+)", re.IGNORECASE | re.ASCII)
# re.ASCII: \w/\d giống JavaScript (chỉ ký tự ASCII).
_CODE_RE = re.compile(r"(^|[^\w./-])(\d{7,10})(?![\w./-])(?!:\d)", re.ASCII)


def patient_tag(code: str) -> str:
    h = hashlib.sha256(f"{_SALT}|{code}".encode("utf-8")).hexdigest()[:6]
    return f"BN#{h}"


def _redact_url(m: "re.Match") -> str:
    url = m.group(0)
    if "?" not in url:
        return url
    base, query = url.split("?", 1)
    kept = []
    for pair in query.split("&"):
        if not pair:
            continue
        key = pair.split("=", 1)[0]
        kept.append(pair if key.lower() in _SAFE_URL_PARAMS else f"{key}=…")
    return f"{base}?{'&'.join(kept)}"


def redact_log_line(line) -> str:
    s = "" if line is None else str(line)
    if not s:
        return s
    s = _URL_RE.sub(_redact_url, s)
    s = _PARAM_RE.sub(lambda m: f"{m.group(1)}=…", s)
    s = _CODE_RE.sub(lambda m: f"{m.group(1)}{patient_tag(m.group(2))}", s)
    return s
