# -*- coding: utf-8 -*-
"""Dọn CUỐI không được xóa phiếu 'Mới' cố ý chờ người lập (ca trực) Hoàn tất."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "worker"
if str(WORKER) not in sys.path:
    sys.path.insert(0, str(WORKER))

import care_cache


class FakeWS:
    def __init__(self):
        self.config = {"username": "a", "password": "pw"}
        self.driver = object()
        self.switched = []

    def switch_to_creator_account(self, creator, ma_bn, allow_completed=False):
        self.switched.append(creator)
        return True

    def restore_account(self, *a, **k):
        pass


def _cache():
    return {
        "20:00 25/09/2026": [{"creator": "Điều Dưỡng B", "status": "Mới", "hhmm": "20:00", "id_delete": "X1", "id_edit": "X1"}],
        "16:00 25/09/2026": [{"creator": "Điều Dưỡng B", "status": "Mới", "hhmm": "16:00", "id_delete": "X2", "id_edit": "X2"}],
    }


def test_keep_pending_moi_but_delete_other_moi(monkeypatch):
    deleted = []
    monkeypatch.setattr(care_cache, "delete_cham_soc_new_by_id", lambda d, cid: deleted.append(cid))
    ws = FakeWS()
    cache = _cache()
    care_cache.cleanup_cham_soc_cache(
        ws, "BN1", cache, [16, 20], ["Điều Dưỡng B"], phase="CUỐI",
        keep_moi_time_keys={"20:00 25/09/2026"},
    )
    assert deleted == ["X2"]
    assert "20:00 25/09/2026" in cache
