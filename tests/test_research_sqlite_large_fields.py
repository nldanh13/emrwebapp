import csv
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "research" / "sqlite_store.py"

spec = importlib.util.spec_from_file_location("research_sqlite_store", MODULE_PATH)
sqlite_store = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(sqlite_store)


def test_read_csv_file_preserves_field_larger_than_default_limit(tmp_path):
    long_text = "A" * 200_000
    csv_path = tmp_path / "clinical_notes.csv"
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["patient_code", "note_text"])
        writer.writerow(["26065620", long_text])

    columns, rows = sqlite_store.read_csv_file(csv_path)

    assert columns == ["patient_code", "note_text"]
    assert len(rows) == 1
    assert rows[0]["patient_code"] == "26065620"
    assert rows[0]["note_text"] == long_text
    assert len(rows[0]["note_text"]) == 200_000
    assert sqlite_store.CSV_FIELD_SIZE_LIMIT >= 200_000
