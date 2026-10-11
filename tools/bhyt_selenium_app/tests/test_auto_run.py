from __future__ import annotations

import tempfile
import threading
import unittest
from datetime import date
from pathlib import Path

from bhyt.auto_run import AutoRunError, AutoRunner
from bhyt.mapping import DOC_BHXH, DOC_GRV
from bhyt.store import Store

GRV_FIELDS = {
    "ma_bhxh": "9201234567", "ho_ten": "TRẦN THỊ MẪU", "ngay_sinh": "02/03/1985", "gioi_tinh": "Nữ",
    "ma_khoa": "K24", "dan_toc": "Kinh", "dia_chi": "Cần Thơ", "tu_ngay": "01/10/2026 01:56",
    "den_ngay": "08/10/2026 13:00", "chan_doan": "S42", "pp_dieutri": "Mổ",
    "doctor_text": "Nguyễn Lê Hoan", "ngay_ct": "08/10/2026", "ma_ct": "100001/2026/GRV",
    "ghi_chu": "Nghỉ ốm từ ngày 09/10/2026 đến hết ngày 19/10/2026",
}
PHIEU_FIELDS = {
    "so_kcb": "KCB1", "ma_bhxh": "7912345678", "ho_ten": "NGUYỄN VĂN AN", "ngay_sinh": "15/04/1988",
    "chan_doan": "Cảm", "tu_ngay": "10/10/2026", "den_ngay": "12/10/2026",
    "doctor_text": "Phạm Việt Tân", "ngay_ct": "10/10/2026", "so_seri": "S1",
}


class FakeEmr:
    def __init__(self, logged_in=True, clinic_error=None):
        self.logged_in = logged_in
        self.clinic_error = clinic_error
        self.calls = []

    def session_status(self):
        return {"logged_in": self.logged_in}

    def harvest_sick_leave(self, progress=None, **kw):
        self.calls.append(("clinic",))
        if self.clinic_error:
            raise self.clinic_error
        progress and progress(1, 1, "NGUYỄN VĂN AN")
        return {"scanned": 3, "working_age": 1,
                "found": [{"ho_ten": "NGUYỄN VĂN AN", "doc_type": DOC_BHXH, "fields": dict(PHIEU_FIELDS)}]}

    def harvest_discharges(self, day=None, defaults=None, progress=None, **kw):
        self.calls.append(("discharge", day, defaults))
        return {"scanned": 2, "working_age": 1,
                "found": [{"ho_ten": "TRẦN THỊ MẪU", "doc_type": DOC_GRV, "fields": dict(GRV_FIELDS)}]}


class FakePortal:
    def __init__(self, logged_in=True):
        self.logged_in = logged_in

    def session_status(self):
        return {"logged_in": self.logged_in}


class FakeWorker:
    def __init__(self, store):
        self.store = store
        self.started = []
        self.thread = None

    def start(self, ids, dry_run=True, delay_seconds=1.0, auto_enrich=False):
        self.started.append((list(ids), dry_run))

        def run():
            for rid in ids:
                self.store.mark(rid, "success", "OK")
        self.thread = threading.Thread(target=run)
        self.thread.start()


def make(tmp, emr=None, portal=None):
    store = Store(Path(tmp) / "t.sqlite3")
    worker = FakeWorker(store)
    runner = AutoRunner(emr or FakeEmr(), portal or FakePortal(), worker, store, delay_seconds=0)
    return runner, store, worker


class AutoRunTests(unittest.TestCase):
    def test_scans_both_lists_then_submits_ready_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner, store, worker = make(tmp)
            today = date.today().strftime("%Y-%m-%d")
            runner.run(today, {"ma_khoa": "K24", "doctor_text": "Nguyễn Lê Hoan"})
            st = runner.status()
            records = store.list_records()
        self.assertFalse(st["running"])
        self.assertEqual(st["results"]["clinic"]["found"], 1)
        self.assertEqual(st["results"]["discharge"]["found"], 1)
        self.assertEqual(len(worker.started), 1)
        self.assertFalse(worker.started[0][1])           # nhập thật, không điền thử
        self.assertEqual(len(worker.started[0][0]), 2)
        self.assertEqual(st["results"]["submit"]["success"], 2)
        self.assertEqual({r["status"] for r in records}, {"success"})

    def test_records_needing_answer_are_not_submitted(self):
        with tempfile.TemporaryDirectory() as tmp:
            emr = FakeEmr()
            orig = emr.harvest_discharges

            def ask(**kw):
                out = orig(**kw)
                out["found"][0]["fields"].update(ghi_chu="Tái khám", hoi_nghi_om="can_hoi")
                return out
            emr.harvest_discharges = ask
            runner, store, worker = make(tmp, emr=emr)
            runner.run(date.today().isoformat(), {})
            st = runner.status()
        self.assertEqual(len(worker.started[0][0]), 1)  # chỉ phiếu phòng khám
        self.assertEqual(st["results"]["discharge"]["ask_sick_leave"], 1)

    def test_clinic_error_does_not_stop_discharges(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner, store, worker = make(tmp, emr=FakeEmr(clinic_error=RuntimeError("EMR chậm")))
            runner.run(date.today().isoformat(), {})
            st = runner.status()
        self.assertIn("EMR chậm", st["results"]["clinic"]["error"])
        self.assertEqual(st["results"]["discharge"]["found"], 1)

    def test_other_day_skips_clinic_list(self):
        # Danh sách khám EMR chỉ có ngày hôm nay: chọn ngày khác thì chỉ quét ra viện.
        with tempfile.TemporaryDirectory() as tmp:
            emr = FakeEmr()
            runner, store, worker = make(tmp, emr=emr)
            runner.run("2026-10-01", {})
            st = runner.status()
        self.assertNotIn(("clinic",), emr.calls)
        self.assertIn("hôm nay", st["results"]["clinic"]["skipped"])

    def test_start_requires_both_logins(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner, _, _ = make(tmp, portal=FakePortal(logged_in=False))
            with self.assertRaises(AutoRunError) as ctx:
                runner.start()
            self.assertIn("cổng", str(ctx.exception))
            runner, _, _ = make(tmp, emr=FakeEmr(logged_in=False))
            with self.assertRaises(AutoRunError) as ctx:
                runner.start()
            self.assertIn("EMR", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
