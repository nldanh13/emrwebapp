# -*- coding: utf-8 -*-
"""Helper log cho bước xử lý y lệnh.

Tách riêng để các parser log cùng một kiểu, dễ đọc khi debug mất thuốc/mất giờ.
"""

from runtime_logging import get_worker_logger

LOG = get_worker_logger('xu_ly.processing')


def log_sanity_warning(warning):
    LOG.warning(
        "[sanity] %s | %s | %s | %s",
        warning.get('code', ''),
        warning.get('ngay_lam', ''),
        warning.get('ma_bn', ''),
        warning.get('message', ''),
    )
