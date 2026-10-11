from __future__ import annotations

import copy
import unittest

from bhyt.portal import Worker


def _issues(fields):
    # Hồ sơ "sẵn sàng" khi có Số KCB (mô phỏng quy tắc thiếu dữ liệu của mẫu 07).
    return [] if fields.get("so_kcb") else ["Thiếu Số KCB"]


class FakeStore:
    def __init__(self, records):
        self.records = {r["id"]: r for r in records}
        self.marks = []

    def get_record(self, rid):
        r = self.records.get(rid)
        return copy.deepcopy(r) if r else None

    def update_fields(self, rid, fields):
        r = self.records[rid]
        r["fields"].update(fields)
        r["issues"] = _issues(r["fields"])
        r["ready"] = not r["issues"]

    def mark(self, rid, status, message, increment_attempt=False):
        self.records[rid]["status"] = status
        self.records[rid]["message"] = message
        self.marks.append((rid, status))


class FakePortal:
    def __init__(self):
        self.filled = []

    def fill_record(self, record, dry_run=True):
        self.filled.append((record["id"], dry_run))
        return "đã điền"


class FakeEmr:
    def __init__(self, by_name):
        self.by_name = by_name
        self.calls = []

    def read_phieu_pdf(self, name):
        self.calls.append(name)
        return {"fields": self.by_name.get(name, {})}


def rec(rid, name, fields):
    return {"id": rid, "patient_name": name, "status": "pending",
            "issues": _issues(fields), "ready": bool(not _issues(fields)),
            "fields": dict(fields)}


class WorkerAutoEnrichTests(unittest.TestCase):
    def test_enrich_fills_missing_from_emr(self):
        store = FakeStore([rec(1, "NGUYEN VAN A", {})])
        emr = FakeEmr({"NGUYEN VAN A": {"so_kcb": "260004779", "so_cccd": "086300000786"}})
        w = Worker(FakePortal(), store, emr)
        out = w._enrich_from_emr(store.get_record(1))
        self.assertEqual(out["fields"]["so_kcb"], "260004779")
        self.assertEqual(out["issues"], [])
        self.assertEqual(emr.calls, ["NGUYEN VAN A"])

    def test_run_auto_enrich_then_fills(self):
        store = FakeStore([rec(1, "NGUYEN VAN A", {})])  # thiếu Số KCB
        portal = FakePortal()
        emr = FakeEmr({"NGUYEN VAN A": {"so_kcb": "260004779"}})
        w = Worker(portal, store, emr)
        w._run([1], dry_run=False, delay_seconds=0, auto_enrich=True)
        self.assertEqual(portal.filled, [(1, False)])        # đã điền lên cổng
        self.assertEqual(store.records[1]["status"], "success")
        self.assertEqual(emr.calls, ["NGUYEN VAN A"])

    def test_run_without_enrich_marks_error_when_missing(self):
        store = FakeStore([rec(1, "NGUYEN VAN A", {})])
        portal = FakePortal()
        w = Worker(portal, store, FakeEmr({}))
        w._run([1], dry_run=False, delay_seconds=0, auto_enrich=False)
        self.assertEqual(portal.filled, [])                  # không điền vì thiếu dữ liệu
        self.assertEqual(store.records[1]["status"], "error")

    def test_run_enrich_still_missing_marks_error(self):
        # EMR không trả được Số KCB -> vẫn thiếu -> báo lỗi, không điền.
        store = FakeStore([rec(1, "NGUYEN VAN A", {})])
        portal = FakePortal()
        emr = FakeEmr({"NGUYEN VAN A": {"so_cccd": "086300000786"}})  # không có so_kcb
        w = Worker(portal, store, emr)
        w._run([1], dry_run=False, delay_seconds=0, auto_enrich=True)
        self.assertEqual(portal.filled, [])
        self.assertEqual(store.records[1]["status"], "error")


if __name__ == "__main__":
    unittest.main()
