# -*- coding: utf-8 -*-
"""Helper log cho bước xử lý y lệnh.

Tách riêng để các parser log cùng một kiểu, dễ đọc khi debug mất thuốc/mất giờ.
"""

from runtime_logging import get_worker_logger

LOG = get_worker_logger('xu_ly.processing')


def log_category(drug, category, reason=None):
    name = (drug or {}).get('ten_thuoc') or (drug or {}).get('ten_hien_thi') or ''
    route = (drug or {}).get('duong_dung_goc') or ''
    msg = "[drug-category] %s -> %s" % (name, category)
    if reason:
        msg += " (%s)" % reason
    if route:
        msg += " | route=%s" % route
    LOG.debug(msg)


def log_fallback(message, **fields):
    suffix = " ".join([f"{k}={v}" for k, v in fields.items() if v not in (None, '')])
    LOG.warning("[fallback] %s%s", message, (" | " + suffix) if suffix else "")


def log_sanity_warning(warning):
    LOG.warning(
        "[sanity] %s | %s | %s | %s",
        warning.get('code', ''),
        warning.get('ngay_lam', ''),
        warning.get('ma_bn', ''),
        warning.get('message', ''),
    )
