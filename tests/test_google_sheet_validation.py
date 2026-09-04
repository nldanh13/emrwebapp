import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "src" / "components" / "records" / "googleSheetValidation.mjs"


def test_google_sheet_validation_scenarios():
    script = f"""
import {{
  applyGoogleSheetValidation,
  buildGoogleSheetIndex,
  buildUnlinkedSheetIssues,
  compareNames,
  googleSheetRecordStatus,
}} from {json.dumps(MODULE.as_uri())};

const check = (condition, message) => {{ if (!condition) throw new Error(message); }};
const status = (records, row) => googleSheetRecordStatus(row, buildGoogleSheetIndex(records));

check(status([
  {{row_number: 2, storage_raw: '03/009370/BT/2026', patient_name: 'Nhân Viên An'}}
], {{storage: '03/009370/BT/2026', displayName: 'Nhân Viên An'}}).state === 'available', 'exact match');

check(status([
  {{row_number: 2, storage_raw: '03/009370/BT/2026', patient_name: 'Nhân Viên Anh'}}
], {{storage: '03/009370/BT/2026', displayName: 'Nhân Viên An'}}).state === 'possible_name_typo', 'possible name typo');

check(status([
  {{row_number: 2, storage_raw: '03/009370/BT/2026', patient_name: 'Nhân Viên An'}},
  {{row_number: 3, storage_raw: '03/009370/BT/2026', patient_name: 'Trần Văn Bình'}}
], {{storage: '03/009370/BT/2026', displayName: 'Nhân Viên An'}}).state === 'storage_name_conflict', 'one storage with multiple names');

// Cùng họ tên nhưng khác Số LT không đủ căn cứ kết luận nhập sai.
const sameNameOtherStorage = status([
  {{row_number: 2, storage_raw: '03/009371/BT/2026', patient_name: 'Nhân Viên An'}}
], {{storage: '03/009370/BT/2026', displayName: 'Nhân Viên An'}});
check(sameNameOtherStorage.state === 'missing_same_name', 'same name different storage remains missing');
check(sameNameOtherStorage.is_issue === false, 'same name different storage is not an issue');
check(sameNameOtherStorage.related_records.length === 0, 'same-name reference is not claimed as linked');

check(status([
  {{row_number: 2, storage_raw: '03/009371/BT/2026', patient_name: 'Nhân Viên Anh'}}
], {{storage: '03/009370/BT/2026', displayName: 'Nhân Viên An'}}).state === 'possible_name_and_storage_typo', 'double typo');

check(status([
  {{row_number: 2, storage_raw: '03/009370/BT/2026', patient_name: ''}}
], {{storage: '03/009370/BT/2026', displayName: 'Nhân Viên An'}}).state === 'missing_name', 'missing name');

check(status([], {{storage: '03/009370/BT/2026', displayName: 'Nhân Viên An'}}).state === 'missing', 'missing sheet record');

// Dấu tiếng Việt phải được giữ khi xác định khớp chính xác.
const accentComparison = compareNames('Nguyễn Thị Phương', 'Nguyễn Thị Phượng');
check(accentComparison.exact === false && accentComparison.close === true, 'Vietnamese accents are not exact but may be close');
check(status([
  {{row_number: 2, storage_raw: '03/009106/BT/2026', patient_name: 'Nguyễn Thị Phương'}}
], {{storage: '03/009106/BT/2026', displayName: 'Nguyễn Thị Phượng'}}).state === 'possible_name_typo', 'accent difference is not auto matched');

// Tình huống thực tế: một dòng Sheet 9106 và ba dòng EMR cùng tên.
// Chỉ 9106 được xác nhận; 10556 và 4400 vẫn là chưa có hồ sơ.
const sheetRecords = [
  {{row_number: 2, storage_raw: '9106', patient_name: 'Nguyễn Thị Phượng', timestamp: '16/07/2026 14:34:11'}}
];
const validatedRows = applyGoogleSheetValidation([
  {{storage: '03/010556/BT/2026', displayName: 'Nguyễn Thị Phượng'}},
  {{storage: '03/009106/BT/2026', displayName: 'Nguyễn Thị Phượng'}},
  {{storage: '03/004400/BT/2026', displayName: 'Nguyễn Thị Phượng'}},
], buildGoogleSheetIndex(sheetRecords));
check(validatedRows[0].paperRecord.state === 'missing_same_name', '10556 remains missing');
check(validatedRows[1].paperRecord.state === 'available', '9106 is available');
check(validatedRows[2].paperRecord.state === 'missing_same_name', '4400 remains missing');
check(validatedRows[0].paperRecord.issue_detail.includes('lượt điều trị khác hoặc người trùng tên'), 'safe explanatory text');

// Dòng đã khớp chính xác không được dùng lại làm ứng viên lỗi kép cho ca khác.
const claimedCandidateRows = applyGoogleSheetValidation([
  {{storage: '03/009106/BT/2026', displayName: 'Nguyễn Thị Phượng'}},
  {{storage: '03/009016/BT/2026', displayName: 'Nguyễn Thị Phương'}},
], buildGoogleSheetIndex(sheetRecords));
check(claimedCandidateRows[0].paperRecord.state === 'available', 'claimed exact row is available');
check(claimedCandidateRows[1].paperRecord.state === 'missing', 'claimed sheet row is not reused as double typo');

const unlinked = buildUnlinkedSheetIssues([
  {{storage: '03/009370/BT/2026', displayName: 'Nhân Viên An', paperRecord: {{related_records: []}}}}
], [
  {{row_number: 2, storage_raw: '03/009370/BT/2026', patient_name: 'Trần Văn B'}}
]);
check(unlinked.length === 1 && unlinked[0].label === 'Cần xác minh tên', 'reverse sheet issue');

const unlinkedSameName = buildUnlinkedSheetIssues([
  {{storage: '03/009370/BT/2026', displayName: 'Nhân Viên An', paperRecord: {{related_records: []}}}}
], [
  {{row_number: 2, storage_raw: '03/009371/BT/2026', patient_name: 'Nhân Viên An'}}
]);
check(unlinkedSameName.length === 1, 'same-name sheet row remains unlinked');
check(unlinkedSameName[0].tone === 'gray', 'same name different storage is informational');
check(unlinkedSameName[0].label === 'Chưa ghép được', 'same name different storage has neutral label');
"""
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr or completed.stdout
