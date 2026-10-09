# -*- coding: utf-8 -*-
"""worker/nurse_emr_accounts.py — Tài khoản EMR thật riêng theo TÊN điều dưỡng.

Khác với secrets/users.json (tài khoản đăng nhập Data Hub, gắn theo người vận
hành app): file này chỉ ánh xạ TÊN điều dưỡng trong lịch trực (config.json ->
ten_dieu_duong) sang tài khoản EMR của chính người đó — không cần người đó
từng đăng nhập Data Hub. Dùng khi nhập chăm sóc để mỗi ca (làm/trực) được ghi
nhận đúng tài khoản EMR của điều dưỡng phụ trách ca đó, không phải tài khoản
chung.

Xem config/nurse_emr_accounts.example.json để biết định dạng; file thật
secrets/nurse_emr_accounts.json không commit (chứa mật khẩu thật) — xem docs/SECRETS.md.

Cùng file JSON này còn giữ trường tùy chọn "signature_file" (tên file ảnh
chữ ký trong config/signatures/) — dùng khi tự động chèn chữ ký vào bộ
phiếu "IN RA VIỆN" (xem sign_discharge_bundle.py). Trường này không đòi hỏi
phải có emr_username/emr_password: một người có thể chỉ cấu hình chữ ký mà
không cần tài khoản EMR riêng.
"""
from __future__ import annotations

import json
import os
import re
import unicodedata
from functools import lru_cache
from typing import Any, Dict, List, Optional

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
try:
    from shared.secret_store import resolve_secret_file
    # secrets/nurse_emr_accounts.json (máy chưa chuyển thì vẫn là config/ cũ),
    # EMR_NURSE_ACCOUNTS_FILE ghi đè được — cùng quy tắc với server.
    NURSE_EMR_ACCOUNTS_FILE = resolve_secret_file('nurse_emr_accounts.json')[0]
except ImportError:  # chạy tay ngoài thư mục worker/
    NURSE_EMR_ACCOUNTS_FILE = os.path.join(BASE_DIR, 'config', 'nurse_emr_accounts.json')
NURSE_SIGNATURES_DIR = os.path.join(BASE_DIR, 'config', 'signatures')


def normalize_name(value: Any) -> str:
    """Chuẩn hoá tên để so khớp: bỏ dấu, chữ thường, gọn khoảng trắng."""
    text = str(value or '').strip().upper()
    text = unicodedata.normalize('NFD', text)
    text = ''.join(ch for ch in text if unicodedata.category(ch) != 'Mn')
    text = text.replace('Đ', 'D')
    return re.sub(r'\s+', ' ', text)


def _load_json(path: str, fallback: Any) -> Any:
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return fallback


@lru_cache(maxsize=1)
def load_nurse_emr_accounts() -> Dict[str, Dict[str, str]]:
    """Trả về map {tên đã chuẩn hoá: {"name", "emr_username", "emr_password"}}."""
    raw = _load_json(NURSE_EMR_ACCOUNTS_FILE, [])
    out: Dict[str, Dict[str, str]] = {}
    if not isinstance(raw, list):
        return out
    for row in raw:
        if not isinstance(row, dict):
            continue
        name = str(row.get('name') or '').strip()
        username = str(row.get('emr_username') or '').strip()
        password = str(row.get('emr_password') or '')
        if not name or not username or not password:
            continue
        out[normalize_name(name)] = {'name': name, 'emr_username': username, 'emr_password': password}
    return out


def get_emr_account_for_nurse(name: Any) -> Optional[Dict[str, str]]:
    """Trả {"username", "password"} nếu tên khớp tài khoản đã cấu hình, ngược lại None."""
    key = normalize_name(name)
    if not key:
        return None
    row = load_nurse_emr_accounts().get(key)
    if not row:
        return None
    return {'username': row['emr_username'], 'password': row['emr_password']}


def get_nurse_name_for_username(username: Any) -> str:
    """Tra ngược: tên điều dưỡng sở hữu tài khoản EMR `username` ('' nếu không có)."""
    wanted = str(username or '').strip().lower()
    if not wanted:
        return ''
    for row in load_nurse_emr_accounts().values():
        if row['emr_username'].strip().lower() == wanted:
            return row['name']
    return ''


@lru_cache(maxsize=1)
def load_nurse_signature_rows() -> List[Dict[str, str]]:
    """Trả list các dòng đã cấu hình ảnh chữ ký: [{"name", "path"}].

    Khác load_nurse_emr_accounts(): không đòi hỏi có emr_username/emr_password,
    chỉ cần signature_file trỏ tới 1 file ảnh có thật trong config/signatures/.
    """
    raw = _load_json(NURSE_EMR_ACCOUNTS_FILE, [])
    out: List[Dict[str, str]] = []
    if not isinstance(raw, list):
        return out
    for row in raw:
        if not isinstance(row, dict):
            continue
        name = str(row.get('name') or '').strip()
        sig_file = str(row.get('signature_file') or '').strip()
        if not name or not sig_file:
            continue
        # Chỉ nhận tên file thuần — chặn path traversal (../, đường dẫn tuyệt đối).
        sig_file = os.path.basename(sig_file)
        path = os.path.join(NURSE_SIGNATURES_DIR, sig_file)
        if os.path.isfile(path):
            out.append({'name': name, 'path': path})
    return out


def get_signature_for_nurse(name: Any) -> Optional[str]:
    """Trả đường dẫn tuyệt đối ảnh chữ ký đã cấu hình cho `name`, ngược lại None."""
    key = normalize_name(name)
    if not key:
        return None
    for row in load_nurse_signature_rows():
        if normalize_name(row['name']) == key:
            return row['path']
    return None


# ── Tài khoản đăng nhập khi NHẬP LIỆU ────────────────────────────────────────
# Quy tắc (docs/UX_RULES.md mục 4.4): mọi tác vụ GHI vào EMR (chăm sóc, truyền
# dịch, thủ thuật, VTYT...) đăng nhập bằng tài khoản EMR của điều dưỡng CA LÀM
# theo Lịch điều dưỡng của ngày đó, không dùng tài khoản mặc định. Người ca làm
# chưa có tài khoản EMR (Thiết lập tài khoản) thì dùng tài khoản mặc định và
# cảnh báo. Tác vụ chỉ đọc (quét, lấy dữ liệu) vẫn dùng tài khoản mặc định.

def _work_date_dmy(work_date: Any) -> str:
    """'dd/mm/yyyy' từ 'dd/mm/yyyy', 'd/m/yy' hoặc 'yyyy-mm-dd' ('' nếu không đọc được)."""
    text = str(work_date or '').strip()
    m = re.search(r'(\d{4})-(\d{1,2})-(\d{1,2})', text)
    if m:
        return f"{int(m.group(3)):02d}/{int(m.group(2)):02d}/{int(m.group(1)):04d}"
    m = re.search(r'(\d{1,2})/(\d{1,2})/(\d{2,4})', text)
    if m:
        year = int(m.group(3))
        if year < 100:
            year += 2000
        return f"{int(m.group(1)):02d}/{int(m.group(2)):02d}/{year:04d}"
    return ''


def scheduled_work_nurse(schedule: Any, work_date: Any) -> str:
    """Tên điều dưỡng ca làm của `work_date` theo lịch (config['ten_dieu_duong'])."""
    dmy = _work_date_dmy(work_date)
    if not dmy or not isinstance(schedule, dict):
        return ''
    from utils import get_nurse_by_shift  # import muộn: utils kéo theo selenium
    try:
        return str(get_nurse_by_shift(f"08:00 {dmy}", schedule, force_shift='work') or '').strip()
    except Exception:
        return ''


def resolve_entry_account(
    work_date: Any,
    *,
    schedule: Any,
    default_username: Any,
    default_password: Any,
    lookup=None,
) -> Dict[str, str]:
    """Tài khoản EMR để NHẬP LIỆU cho ngày `work_date`.

    Trả {"username", "password", "nurse_name", "source": "schedule"|"default", "warning"}.
    - source="schedule": người ca làm theo lịch có tài khoản EMR riêng.
    - source="default": không tra được người ca làm hoặc người đó chưa có tài
      khoản → tài khoản mặc định, kèm `warning` tiếng Việt nói rõ cần làm gì.
    """
    lookup = lookup or get_emr_account_for_nurse
    dmy = _work_date_dmy(work_date) or str(work_date or '').strip()
    nurse = scheduled_work_nurse(schedule, work_date)
    account = lookup(nurse) if nurse else None
    if account and account.get('username') and account.get('password'):
        return {
            'username': str(account['username']).strip(),
            'password': str(account['password']),
            'nurse_name': nurse,
            'source': 'schedule',
            'warning': '',
        }
    if nurse:
        warning = (f"Ngày {dmy}: điều dưỡng ca làm {nurse} chưa có tài khoản EMR trong Thiết lập tài khoản → Tài khoản EMR "
                   f"→ nhập bằng tài khoản mặc định. Thêm tài khoản EMR cho {nurse} để lần sau nhập đúng tên.")
    else:
        warning = (f"Ngày {dmy}: chưa có người ca làm trong Lịch điều dưỡng → nhập bằng tài khoản mặc định. "
                   f"Xếp lịch ngày này để lần sau nhập đúng tài khoản.")
    return {
        'username': str(default_username or '').strip(),
        'password': str(default_password or ''),
        'nurse_name': nurse,
        'source': 'default',
        'warning': warning,
    }


class EntryAccountResolver:
    """Gọi resolve_entry_account theo từng ngày, nhớ kết quả và chỉ cảnh báo một lần mỗi ngày."""

    def __init__(self, config: Dict[str, Any], *, schedule: Any = None, warn=None, lookup=None) -> None:
        self.schedule = schedule if schedule is not None else (config or {}).get('ten_dieu_duong')
        self.default_username = str((config or {}).get('username') or '').strip()
        self.default_password = str((config or {}).get('password') or '')
        self.warn = warn or (lambda msg: print(f"   [WARN] {msg}"))
        self.lookup = lookup
        self.warnings: List[str] = []
        self._cache: Dict[str, Dict[str, str]] = {}
        self.run_account: Dict[str, str] = {}

    def for_date(self, work_date: Any) -> Dict[str, str]:
        key = _work_date_dmy(work_date) or str(work_date or '').strip()
        if key not in self._cache:
            info = resolve_entry_account(
                work_date, schedule=self.schedule,
                default_username=self.default_username, default_password=self.default_password,
                lookup=self.lookup,
            )
            self._cache[key] = info
            if info['warning'] and info['warning'] not in self.warnings:
                self.warnings.append(info['warning'])
                self.warn(info['warning'])
            elif info['source'] == 'schedule':
                print(f">>> Ngày {key}: nhập bằng tài khoản EMR của {info['nurse_name']} (ca làm theo lịch).")
        return self._cache[key]

    def login_config(self, config: Dict[str, Any], work_date: Any) -> Dict[str, Any]:
        """Bản sao config đăng nhập bằng tài khoản ca làm của `work_date` — ngày đầu tiên
        của lượt. Cả lượt (mọi ngày) nhập bằng tài khoản này, chỉ đăng nhập một lần."""
        info = self.for_date(work_date)
        out = dict(config or {})
        if info['username'] and info['password']:
            out['username'] = info['username']
            out['password'] = info['password']
        # Cả lượt nhập dùng đúng phiên này, không đăng nhập lại tài khoản khác
        # (WorkerSession.switch_account từ chối khi single_login).
        out['single_login'] = True
        self.run_account = info
        return out


def sort_tasks_by_work_date(tasks: List[Dict[str, Any]], key: str = 'ngay_lam') -> List[Dict[str, Any]]:
    """Xếp task theo ngày làm (giữ thứ tự cũ trong cùng ngày) để mỗi tài khoản ca làm chỉ đăng nhập một lần."""
    def _k(task: Dict[str, Any]):
        dmy = _work_date_dmy((task or {}).get(key))
        return (dmy[6:10], dmy[3:5], dmy[0:2]) if dmy else ('9999', '99', '99')
    return sorted(list(tasks or []), key=_k)
