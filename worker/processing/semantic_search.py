# -*- coding: utf-8 -*-
"""Semantic/fuzzy matcher nhẹ cho thuốc, dung môi và đường dùng.

Thiết kế an toàn cho môi trường bệnh viện:
- Không bắt buộc cài model nặng. Mặc định dùng vector ký tự n-gram + cosine
  trong stdlib để bắt lỗi chính tả/viết tách âm thông dụng.
- Nếu muốn dùng sentence-transformers, cài thêm package và đặt biến môi trường:
    EMR_SEMANTIC_BACKEND=sentence_transformers
  Khi không có package/model, code tự rơi về matcher local, không làm hỏng pipeline.
- Exact/rule-based vẫn chạy trước. Module này chỉ là lớp fallback khi rule cũ
  không khớp hoặc khớp yếu.
"""
from __future__ import annotations

import math
import os
import re
import unicodedata
from collections import Counter
from functools import lru_cache
from difflib import SequenceMatcher
from typing import Any, Iterable


def normalize_semantic_text(value: Any) -> str:
    """Chuẩn hóa chuỗi để so khớp mềm, giữ số để phân biệt hàm lượng 1G/500MG."""
    text = str(value or "").upper().replace("Đ", "D")
    text = unicodedata.normalize("NFD", text)
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = re.sub(r"[^A-Z0-9]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()

    replacements = {
        "PA RA XE TA MON": "PARACETAMOL",
        "PA RA CETAMOL": "PARACETAMOL",
        "PARA XETAMON": "PARACETAMOL",
        "PARAXETAMOL": "PARACETAMOL",
        "THERMODON": "THERMODOL",
        "THERMO DON": "THERMODOL",
        "NUOC MOI": "NUOC MUOI",
        "NUOC MUI": "NUOC MUOI",
        "NATRI CLORIT": "NATRI CLORID",
        "NATRI CHLORIT": "NATRI CHLORID",
        "SODIUM CLORIT": "SODIUM CLORID",
        "SODIUM CHLORIT": "SODIUM CHLORID",
        "TIEM MACH CHAM": "TINH MACH CHAM",
        "TM CHAM": "TMC",
        "TRUYEN TM": "TTM",
        "TRUYEN TINH MACH": "TTM",
    }
    for src, dst in replacements.items():
        text = re.sub(rf"(?<![A-Z0-9]){re.escape(src)}(?![A-Z0-9])", dst, text)
    return re.sub(r"\s+", " ", text).strip()


def _char_ngrams(text: str, min_n: int = 2, max_n: int = 4) -> Counter:
    text = f" {normalize_semantic_text(text)} "
    grams: Counter[str] = Counter()
    if not text.strip():
        return grams
    for n in range(min_n, max_n + 1):
        if len(text) < n:
            continue
        for idx in range(0, len(text) - n + 1):
            gram = text[idx:idx + n]
            if gram.strip():
                grams[gram] += 1
    return grams


def _cosine_counter(a: Counter, b: Counter) -> float:
    if not a or not b:
        return 0.0
    common = set(a).intersection(b)
    numerator = sum(a[k] * b[k] for k in common)
    denom_a = math.sqrt(sum(v * v for v in a.values()))
    denom_b = math.sqrt(sum(v * v for v in b.values()))
    if denom_a <= 0 or denom_b <= 0:
        return 0.0
    return float(numerator / (denom_a * denom_b))


def _token_windows(text: str, target: str) -> list[str]:
    q_tokens = normalize_semantic_text(text).split()
    t_tokens = normalize_semantic_text(target).split()
    if not q_tokens:
        return []
    sizes = {len(t_tokens), len(t_tokens) + 1, max(1, len(t_tokens) - 1)}
    windows = {" ".join(q_tokens)}
    for size in sizes:
        if size <= 0 or size > len(q_tokens):
            continue
        for i in range(0, len(q_tokens) - size + 1):
            windows.add(" ".join(q_tokens[i:i + size]))
    return [w for w in windows if w]


def local_vector_similarity(query: Any, candidate: Any) -> float:
    """Điểm tương đồng 0..1 bằng char n-gram cosine + SequenceMatcher."""
    q = normalize_semantic_text(query)
    c = normalize_semantic_text(candidate)
    if not q or not c:
        return 0.0
    if q == c:
        return 1.0
    if c in q:
        return 0.98

    best = 0.0
    cand_vec = _char_ngrams(c)
    for window in _token_windows(q, c):
        cos = _cosine_counter(_char_ngrams(window), cand_vec)
        seq = SequenceMatcher(None, normalize_semantic_text(window), c).ratio()
        score = (0.72 * cos) + (0.28 * seq)
        if score > best:
            best = score
    return float(max(0.0, min(1.0, best)))


@lru_cache(maxsize=1)
def _sentence_transformer_model():
    backend = os.environ.get("EMR_SEMANTIC_BACKEND", "local").strip().lower()
    if backend not in {"sentence_transformers", "sentence-transformers", "st"}:
        return None
    try:
        from sentence_transformers import SentenceTransformer  # type: ignore
        model_name = os.environ.get("EMR_SEMANTIC_MODEL", "paraphrase-multilingual-MiniLM-L12-v2")
        return SentenceTransformer(model_name)
    except Exception:
        return None


def _st_similarity(query: str, candidate: str) -> float | None:
    model = _sentence_transformer_model()
    if model is None:
        return None
    try:
        embeddings = model.encode([str(query or ""), str(candidate or "")], normalize_embeddings=True)
        return float(sum(float(a) * float(b) for a, b in zip(embeddings[0], embeddings[1])))
    except Exception:
        return None


def semantic_similarity(query: Any, candidate: Any) -> float:
    """Điểm semantic/fuzzy. Có sentence-transformers thì trộn điểm AI, không có thì dùng local."""
    local = local_vector_similarity(query, candidate)
    st = _st_similarity(str(query or ""), str(candidate or ""))
    if st is None:
        return local
    return float(max(local, (0.65 * st) + (0.35 * local)))


def semantic_best_match(
    query: Any,
    candidates: Iterable[Any],
    *,
    threshold: float = 0.84,
    min_candidate_len: int = 3,
) -> dict[str, Any] | None:
    """Trả về candidate gần nhất nếu vượt ngưỡng."""
    q = normalize_semantic_text(query)
    if not q:
        return None

    best: dict[str, Any] | None = None
    for cand in candidates or []:
        c_text = str(cand or "").strip()
        c_norm = normalize_semantic_text(c_text)
        if len(c_norm.replace(" ", "")) < min_candidate_len:
            continue
        score = semantic_similarity(q, c_norm)
        if best is None or score > float(best.get("score") or 0):
            best = {"candidate": c_text, "candidate_key": c_norm, "score": score}

    if best and float(best.get("score") or 0) >= threshold:
        return best
    return None


def semantic_contains(text: Any, candidates: Iterable[Any], *, threshold: float = 0.88) -> bool:
    return semantic_best_match(text, candidates, threshold=threshold) is not None


NACL_ALIASES = [
    "NATRI CLORID", "NATRI CHLORID", "NATRI CHLORIDE", "NACL",
    "NUOC MUOI", "NUOC MUOI SINH LY", "NUOC BIEN SINH LY",
]
SODIUM_ALIASES = [
    "SODIUM CHLORIDE", "SODIUM CLORID", "SODIUM CHLORID", "SODIUM 0.9", "SODIUM 0,9",
]
WATER_FOR_INJECTION_ALIASES = [
    "NUOC CAT", "NUOC CAT PHA TIEM", "AQUA", "WATER FOR INJECTION",
]


def semantic_solvent_kind(text: Any, *, threshold: float = 0.88) -> str | None:
    """Nhận diện dung môi bằng semantic/fuzzy: NACL, SODIUM hoặc NUOC_CAT."""
    q = normalize_semantic_text(text)
    if not q:
        return None
    if semantic_contains(q, WATER_FOR_INJECTION_ALIASES, threshold=threshold):
        return "NUOC_CAT"
    if semantic_contains(q, SODIUM_ALIASES, threshold=threshold):
        return "SODIUM"
    if semantic_contains(q, NACL_ALIASES, threshold=threshold):
        return "NACL"
    return None
