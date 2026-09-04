# -*- coding: utf-8 -*-
"""llm_parser.py — LLM fallback để bổ sung field bị thiếu sau khi regex parse xong.

Thiết kế:
- KHÔNG thay thế regex parser hiện tại. Chỉ chạy khi có field quan trọng bị thiếu.
- Cache kết quả theo hash của raw text → mỗi y lệnh chỉ gọi LLM 1 lần duy nhất.
- Nếu LLM không trả lời được hoặc lỗi → giữ nguyên kết quả regex, không crash.
- Ghi log parse failures để theo dõi theo thời gian.

Field được LLM bổ sung:
  - toc_do        : tốc độ truyền (giọt/phút)
  - gio_dung      : giờ dùng thuốc
  - the_tich      : thể tích (ml) của túi dịch
  - duong_dung    : đường dùng (TTM/TMC/TB/TDD/U)
  - dung_moi      : dung môi pha (NACL_0.9/NUOC_CAT)

Cách dùng:
    from processing.llm_parser import enrich_drug_with_llm
    drug = enrich_drug_with_llm(drug, raw_order_text)
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
import urllib.request
import urllib.error
from functools import lru_cache
from typing import Any

try:
    from runtime_logging import get_worker_logger
    LOG = get_worker_logger("llm_parser")
except Exception:
    import logging
    LOG = logging.getLogger("llm_parser")

# ─── Cấu hình ────────────────────────────────────────────────────────────────
ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_MODEL   = "claude-haiku-4-5-20251001"   # nhanh + rẻ, đủ cho task nhỏ này
MAX_TOKENS        = 256
API_TIMEOUT_S     = 12   # timeout mỗi call
CACHE_MAX_SIZE    = 512  # số entry cache trong memory

# Đọc API key từ biến môi trường (đặt trong .env hoặc env hệ thống)
def _get_api_key() -> str:
    return os.environ.get("ANTHROPIC_API_KEY", "").strip()

# ─── Kiểm tra khi nào cần gọi LLM ───────────────────────────────────────────
_CRITICAL_FIELDS = {
    "dich_truyen": ["toc_do", "gio_dung", "the_tich"],
    "thuoc_tiem":  ["gio_dung"],
    "thuoc_uong":  ["gio_dung"],
}

def needs_llm(drug: dict, category: str = "dich_truyen") -> bool:
    """Kiểm tra drug có thiếu field quan trọng không.

    Với dich_truyen: cần cả toc_do + the_tich để tính thời gian truyền.
    Không gọi LLM cho các thuốc đã đủ thông tin.
    """
    critical = _CRITICAL_FIELDS.get(category, [])
    missing = [f for f in critical if not drug.get(f)]
    if not missing:
        return False
    # Chỉ gọi nếu có raw text để LLM phân tích
    return bool(drug.get("duong_dung_goc") or drug.get("raw_usage_line") or drug.get("raw_text"))


# ─── Cache ───────────────────────────────────────────────────────────────────
_cache: dict[str, dict] = {}

def _cache_key(drug_name: str, raw_text: str) -> str:
    content = f"{drug_name}|||{raw_text}"
    return hashlib.md5(content.encode("utf-8")).hexdigest()


# ─── Prompt ──────────────────────────────────────────────────────────────────
_SYSTEM_PROMPT = """Bạn là trợ lý phân tích y lệnh thuốc tại bệnh viện Việt Nam.
Nhiệm vụ: từ dòng y lệnh thuốc, trích xuất đúng các trường còn thiếu.
Trả về JSON thuần túy, không giải thích, không markdown.

Quy tắc:
- toc_do: số nguyên giọt/phút (30, 60, 100...). Nếu ghi "XXX" = 30, "C" = 100, "XL" = 40.
- gio_dung: list số nguyên giờ [8, 16, 22]. "sáng"=8, "trưa"=12, "chiều"=16, "tối"=20, "đêm/khuya"=22.
- the_tich: số ml của túi/chai dịch. Mặc định NaCl 0.9% = 100, NaCl 0.9% 500ml = 500.
- duong_dung: "TTM" (truyền tĩnh mạch), "TMC" (tiêm mạch chậm), "TB" (tiêm bắp), "TDD" (tiêm dưới da), "U" (uống).
- dung_moi: "NACL_0.9" (Natri clorid/NaCl 0.9%), "NUOC_CAT" (nước cất), null nếu không có pha.

Chỉ trả về các trường được hỏi. Nếu không xác định được, dùng null."""

def _build_user_prompt(drug_name: str, raw_text: str, missing_fields: list[str]) -> str:
    fields_desc = ", ".join(missing_fields)
    return (
        f"Tên thuốc: {drug_name}\n"
        f"Y lệnh: {raw_text}\n\n"
        f"Hãy trích xuất các trường còn thiếu: {fields_desc}\n"
        f"Trả về JSON với đúng các key: {{{', '.join(repr(f) for f in missing_fields)}}}"
    )


# ─── API call ────────────────────────────────────────────────────────────────
def _call_anthropic(user_prompt: str) -> dict | None:
    """Gọi Anthropic API, trả về dict kết quả hoặc None nếu lỗi."""
    api_key = _get_api_key()
    if not api_key:
        LOG.debug("[llm_parser] ANTHROPIC_API_KEY chưa được cấu hình, bỏ qua LLM.")
        return None

    payload = json.dumps({
        "model": ANTHROPIC_MODEL,
        "max_tokens": MAX_TOKENS,
        "system": _SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": user_prompt}],
    }).encode("utf-8")

    req = urllib.request.Request(
        ANTHROPIC_API_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )

    try:
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=API_TIMEOUT_S) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        elapsed = round(time.time() - t0, 2)

        text = ""
        for block in body.get("content", []):
            if block.get("type") == "text":
                text += block.get("text", "")

        # Strip markdown fences nếu có
        text = re.sub(r"```(?:json)?", "", text).strip()

        result = json.loads(text)
        LOG.info("[llm_parser] OK (%.2fs): %s", elapsed, text[:120])
        return result

    except urllib.error.HTTPError as e:
        LOG.warning("[llm_parser] HTTP %s: %s", e.code, e.read()[:200])
    except Exception as exc:
        LOG.warning("[llm_parser] Lỗi: %s", exc)
    return None


# ─── Parse failure logger ────────────────────────────────────────────────────
_failure_log_path: str | None = None

def set_failure_log_path(path: str) -> None:
    """Gọi từ main worker để chỉ định nơi lưu parse failures."""
    global _failure_log_path
    _failure_log_path = path

def _log_parse_failure(drug: dict, missing: list[str], llm_filled: list[str]) -> None:
    """Ghi vào JSONL để theo dõi theo thời gian."""
    if not _failure_log_path:
        return
    try:
        entry = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "drug": drug.get("ten_thuoc", ""),
            "raw": (drug.get("duong_dung_goc") or drug.get("raw_usage_line") or "")[:120],
            "missing_before_llm": missing,
            "filled_by_llm": llm_filled,
        }
        with open(_failure_log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass


# ─── Normalize LLM output ────────────────────────────────────────────────────
def _apply_llm_result(drug: dict, llm_result: dict, missing_fields: list[str]) -> tuple[dict, list[str]]:
    """Áp dụng kết quả LLM vào drug dict. Trả về (drug đã cập nhật, list field đã fill)."""
    filled = []
    drug = drug.copy()

    for field in missing_fields:
        val = llm_result.get(field)
        if val is None:
            continue

        if field == "toc_do":
            try:
                toc_do = int(float(str(val)))
                if 5 <= toc_do <= 500:   # sanity check: giọt/phút hợp lý
                    drug["toc_do"] = str(toc_do)
                    drug["toc_do_llm"] = True
                    filled.append("toc_do")
            except Exception:
                pass

        elif field == "gio_dung":
            if isinstance(val, list):
                hours = []
                for h in val:
                    try:
                        hi = int(h)
                        if 0 <= hi <= 23:
                            hours.append(hi)
                    except Exception:
                        pass
                if hours:
                    drug["gio_dung"] = ", ".join(f"{h} giờ" for h in sorted(set(hours)))
                    drug["gio_dung_llm"] = True
                    filled.append("gio_dung")
            elif isinstance(val, str) and val.strip():
                drug["gio_dung"] = val.strip()
                drug["gio_dung_llm"] = True
                filled.append("gio_dung")

        elif field == "the_tich":
            try:
                ml = float(val)
                if ml > 0:
                    drug["the_tich"] = ml
                    if not drug.get("tui_dich_truyen_ml"):
                        drug["tui_dich_truyen_ml"] = ml
                    drug["the_tich_llm"] = True
                    filled.append("the_tich")
            except Exception:
                pass

        elif field == "duong_dung":
            valid = {"TTM", "TMC", "TB", "TDD", "U", "IV", "IM", "SC", "PO"}
            s = str(val).upper().strip()
            if s in valid:
                if not drug.get("duong_dung"):
                    drug["duong_dung"] = s
                    drug["duong_dung_llm"] = True
                    filled.append("duong_dung")

        elif field == "dung_moi":
            valid_dm = {"NACL_0.9", "SODIUM_0.9", "NUOC_CAT", "GLUCOSE_5"}
            s = str(val).upper().strip()
            if s in valid_dm and not drug.get("dung_moi"):
                drug["dung_moi"] = s
                drug["dung_moi_llm"] = True
                filled.append("dung_moi")

    return drug, filled


# ─── Public API ──────────────────────────────────────────────────────────────
def enrich_drug_with_llm(drug: dict, category: str = "dich_truyen") -> dict:
    """Entry point chính. Nhận drug dict sau khi regex parse, trả về drug đã bổ sung.

    Chỉ gọi LLM khi có field thiếu + có raw text để phân tích.
    Kết quả được cache theo (tên thuốc, raw text).
    """
    if not needs_llm(drug, category):
        return drug

    raw_text = (
        drug.get("raw_usage_line")
        or drug.get("duong_dung_goc")
        or drug.get("raw_text")
        or ""
    ).strip()
    drug_name = drug.get("ten_thuoc", "")

    if not raw_text:
        return drug

    # Xác định field còn thiếu
    critical = _CRITICAL_FIELDS.get(category, [])
    missing = [f for f in critical if not drug.get(f)]

    # Check cache
    ck = _cache_key(drug_name, raw_text)
    if ck in _cache:
        llm_result = _cache[ck]
        drug, filled = _apply_llm_result(drug, llm_result, missing)
        if filled:
            LOG.debug("[llm_parser] cache hit: %s → filled %s", drug_name[:40], filled)
        return drug

    # Gọi LLM
    LOG.info("[llm_parser] gọi LLM cho: %s | thiếu: %s | raw: %s",
             drug_name[:40], missing, raw_text[:80])

    user_prompt = _build_user_prompt(drug_name, raw_text, missing)
    llm_result = _call_anthropic(user_prompt)

    if llm_result:
        # Lưu cache (giới hạn size)
        if len(_cache) >= CACHE_MAX_SIZE:
            # Xóa entry đầu tiên
            _cache.pop(next(iter(_cache)), None)
        _cache[ck] = llm_result

        drug, filled = _apply_llm_result(drug, llm_result, missing)
        _log_parse_failure(drug, missing, filled)
        if filled:
            LOG.info("[llm_parser] filled: %s cho %s", filled, drug_name[:40])
    else:
        # LLM fail → log để biết nhưng không crash
        _log_parse_failure(drug, missing, [])

    return drug


def enrich_drug_list(drugs: list[dict], category: str = "dich_truyen") -> list[dict]:
    """Batch version: enrich toàn bộ list thuốc trong 1 category."""
    return [enrich_drug_with_llm(d, category) for d in drugs]
