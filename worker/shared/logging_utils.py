# -*- coding: utf-8 -*-
"""shared/logging_utils.py — Thiết lập logging chuẩn cho mọi Python worker.

Thay thế setup_logging() + _parse_cli_kv() lặp lại ở:
  input_care.py          → setup_logging(), LOG = getLogger("cham_soc")
  input_infusions_utils.py → setup_logging(), LOG = getLogger("dich_truyen")

Dùng:
  from shared.logging_utils import make_worker_logger

  LOG, setup_logging = make_worker_logger(
      name       = "cham_soc",
      debug_env  = "CHAM_SOC_DEBUG",
      log_file_env = "CHAM_SOC_LOG_FILE",
      log_file_prefix = "cham_soc_debug",
  )
  # Gọi setup_logging() một lần trong if __name__ == "__main__"
"""
from __future__ import annotations

import logging
import os
import sys
from datetime import datetime
from logging.handlers import RotatingFileHandler
from typing import Callable, Optional, Tuple


# ── CLI helper (thay thế _parse_cli_kv lặp ở 2 file) ────────────────────────

def parse_cli_kv(argv: list[str], key: str) -> Optional[str]:
    """Đọc giá trị tham số dòng lệnh dạng --key=value hoặc --key value."""
    for i, a in enumerate(argv):
        if a.startswith(key + "="):
            return a.split("=", 1)[1].strip()
        if a == key and i + 1 < len(argv):
            return argv[i + 1].strip()
    return None


# ── Factory ───────────────────────────────────────────────────────────────────

def make_worker_logger(
    name: str,
    *,
    debug_env: str = "",
    log_file_env: str = "",
    log_file_prefix: str = "",
) -> Tuple[logging.Logger, Callable[[], None]]:
    """Tạo cặp (logger, setup_fn) chuẩn cho một worker.

    Args:
        name:            Tên logger (ví dụ "cham_soc", "dich_truyen").
        debug_env:       Tên biến môi trường để bật DEBUG (ví dụ "CHAM_SOC_DEBUG").
        log_file_env:    Tên biến môi trường chỉ định path log file.
        log_file_prefix: Prefix tên file log tự động (ví dụ "cham_soc_debug").
                         Nếu để trống, dùng name làm prefix.

    Returns:
        (logger, setup_logging) — gọi setup_logging() một lần trước khi chạy.

    Ví dụ:
        LOG, setup_logging = make_worker_logger(
            "cham_soc",
            debug_env="CHAM_SOC_DEBUG",
            log_file_env="CHAM_SOC_LOG_FILE",
            log_file_prefix="cham_soc_debug",
        )
        if __name__ == "__main__":
            setup_logging()
            main()
    """
    logger = logging.getLogger(name)
    prefix = log_file_prefix or name

    def setup_logging() -> None:
        argv = sys.argv[1:]

        # Bật debug qua CLI hoặc env
        debug_flag = ("--debug" in argv) or (
            bool(debug_env)
            and os.getenv(debug_env, "").strip().lower() in ("1", "true", "yes", "y")
        )

        # Path log file qua CLI hoặc env
        log_file = (
            parse_cli_kv(argv, "--log-file")
            or (os.getenv(log_file_env, "").strip() if log_file_env else "")
            or None
        )

        # Auto-path: đặt cạnh file dữ liệu (session dir)
        if not log_file:
            session_dir: Optional[str] = None
            if len(sys.argv) >= 2 and sys.argv[1]:
                session_dir = os.path.dirname(os.path.abspath(sys.argv[1]))
            if not session_dir:
                session_dir = os.path.dirname(os.path.abspath(
                    sys.modules.get("__main__", sys.modules[__name__]).__file__ or "."
                ))
            log_dir = os.path.join(session_dir, "logs")
            try:
                os.makedirs(log_dir, exist_ok=True)
            except Exception:
                log_dir = session_dir
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            log_file = os.path.join(log_dir, f"{prefix}_{ts}.log")

        level = logging.DEBUG if debug_flag else logging.INFO
        logger.setLevel(level)

        # Clear handlers cũ (tránh duplicate khi gọi nhiều lần)
        for h in list(logger.handlers):
            try:
                logger.removeHandler(h)
            except Exception:
                pass

        fmt_full = logging.Formatter("%(asctime)s | %(levelname)s | %(message)s")
        fmt_short = logging.Formatter("%(asctime)s | %(levelname)s | %(message)s",
                                       datefmt="%H:%M:%S")

        # Console handler (stdout — Node.js đọc qua pipe)
        sh = logging.StreamHandler(stream=sys.stdout)
        sh.setLevel(logging.INFO)
        sh.setFormatter(fmt_short)
        logger.addHandler(sh)

        # File handler (rotate 3 MB × 3 bản)
        try:
            fh = RotatingFileHandler(log_file, maxBytes=3_000_000, backupCount=3,
                                     encoding="utf-8")
            fh.setLevel(level)
            fh.setFormatter(fmt_full)
            logger.addHandler(fh)
            logger.debug(f"Log file: {log_file}")
        except Exception as e:
            logger.warning(f"Không tạo được log file '{log_file}': {e}")

    return logger, setup_logging
