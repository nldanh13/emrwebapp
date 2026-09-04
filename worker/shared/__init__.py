# -*- coding: utf-8 -*-
"""shared/ — Utilities dùng chung cho toàn bộ Python worker.

Import tắt:
  from shared import text_utils, date_utils, logging_utils, worker_session

Hoặc import trực tiếp:
  from shared.text_utils      import norm_vi, norm_vi_upper, norm_space, contains_any
  from shared.date_utils      import normalize_dmy, parse_dmy, parse_hours_from_text
  from shared.logging_utils   import make_worker_logger
  from shared.worker_session  import WorkerSession, open_session
"""
