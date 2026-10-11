# -*- coding: utf-8 -*-
"""Shared, cross-process pacing for read-only EMR HTTP workers on ONE server.

All Python workers on the same Data Hub host reserve request slots in a single
per-origin file. This is NOT a rate limit across other computers or Selenium.
No credentials, patient identifiers or EMR URLs are written to disk.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from contextlib import contextmanager
from pathlib import Path


class EmrAccessProtectionError(RuntimeError):
    """Stop or defer the worker rather than adding load to an overloaded EMR."""


@contextmanager
def _locked_file(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(path), os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(fd, "r+b") as file:
        if os.name == "nt":
            import msvcrt
            deadline = time.monotonic() + 15
            while True:
                try:
                    file.seek(0)
                    msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise EmrAccessProtectionError("Không lấy được khóa điều tiết EMR; tạm dừng để tránh gửi dồn.")
                    time.sleep(0.05)
            try:
                yield file
            finally:
                file.seek(0)
                msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(file.fileno(), fcntl.LOCK_EX)
            try:
                yield file
            finally:
                fcntl.flock(file.fileno(), fcntl.LOCK_UN)


def _state_path(origin: str, directory: str) -> Path:
    # Distinct origins never share a reservation queue. Do not expose hostname in filename.
    digest = hashlib.sha256(origin.lower().encode("utf-8")).hexdigest()[:24]
    return Path(directory) / ("emr-budget-" + digest + ".json")


def _read(file) -> dict:
    file.seek(0)
    try:
        obj = json.loads(file.read().decode("utf-8"))
        return obj if isinstance(obj, dict) else {}
    except (ValueError, UnicodeDecodeError):
        return {}


def _write(file, state: dict) -> None:
    file.seek(0)
    file.truncate()
    file.write(json.dumps(state, separators=(",", ":")).encode("utf-8"))
    file.flush()


def reserve_slot(origin: str, directory: str, gap_ms: int = 500,
                 max_wait_sec: float = 15.0) -> None:
    """Pace concurrent HTTP workers. Reserve quickly under OS lock, then sleep unlocked."""
    if gap_ms <= 0:
        return
    path = _state_path(origin, directory)
    with _locked_file(path) as file:
        state = _read(file)
        now = time.time()
        paused = float(state.get("pause_until") or 0)
        if paused > now:
            raise EmrAccessProtectionError(
                f"EMR đang giảm tải. Tạm dừng yêu cầu khoảng {int(paused - now) + 1} giây."
            )
        scheduled = max(now, float(state.get("next_at") or 0))
        wait = scheduled - now
        if wait > max_wait_sec:
            raise EmrAccessProtectionError(
                "Hàng đợi yêu cầu EMR quá dài; tạm dừng tác vụ để giảm tải."
            )
        _write(file, {"next_at": scheduled + gap_ms / 1000.0, "pause_until": 0})
    if wait > 0:
        time.sleep(wait)
    # A 429/503 may arrive while this request is waiting in its reserved slot.
    with _locked_file(path) as file:
        paused = float(_read(file).get("pause_until") or 0)
    if paused > time.time():
        raise EmrAccessProtectionError("EMR vừa báo quá tải; yêu cầu được dừng trước khi gửi.")


def pause_origin(origin: str, directory: str, seconds: float) -> None:
    """Make *all* local HTTP workers back off after an overload response."""
    delay = min(300.0, max(1.0, float(seconds)))
    with _locked_file(_state_path(origin, directory)) as file:
        state = _read(file)
        until = max(float(state.get("pause_until") or 0), time.time() + delay)
        _write(file, {"next_at": max(float(state.get("next_at") or 0), until),
                      "pause_until": until})
