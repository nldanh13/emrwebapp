# -*- coding: utf-8 -*-
"""runtime_logging.py — Logging dùng chung cho Python worker."""
from __future__ import annotations

import logging
import os
from datetime import datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path


_CONFIGURED = set()


def get_worker_logger(name: str = "worker", runtime_dir: str | None = None) -> logging.Logger:
    logger = logging.getLogger(name)
    if name in _CONFIGURED:
        return logger

    logger.setLevel(logging.DEBUG)
    logger.propagate = False

    base = Path(runtime_dir or os.environ.get("WORKER_RUNTIME_DIR") or os.getcwd())
    log_dir = base / "logs"
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / f"{name}_{datetime.now().strftime('%Y%m%d')}.log"
        handler = RotatingFileHandler(log_path, maxBytes=2_000_000, backupCount=5, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s"))
        logger.addHandler(handler)
    except Exception:
        # Logging không được làm worker ngưng chạy.
        pass

    if not logger.handlers:
        logger.addHandler(logging.NullHandler())

    _CONFIGURED.add(name)
    return logger
