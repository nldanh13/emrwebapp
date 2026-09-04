# -*- coding: utf-8 -*-
"""Select2 helpers for infusion entry forms."""
import re
import time
try:
    from selenium.webdriver.common.by import By
    from selenium.webdriver.common.keys import Keys
    from selenium.webdriver.common.action_chains import ActionChains
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.common.exceptions import TimeoutException, StaleElementReferenceException
except ModuleNotFoundError:  # Cho phép test helper chọn/so khớp thuần khi chưa cài Selenium.
    By = Keys = ActionChains = WebDriverWait = EC = None  # type: ignore
    class TimeoutException(Exception):
        pass
    class StaleElementReferenceException(Exception):
        pass

from utils import strip_accents
from selenium_emr_helpers import safe_js_click as _safe_js_click
from input_infusions_utils import LOG, _log, _norm_text

def _get_open_select2_options(driver):
    xpaths = [
        "//li[contains(@class,'select2-results__option') and not(contains(@class,'loading-results')) and not(contains(@class,'message')) and not(contains(@class,'disabled'))]",
        "//ul[contains(@class,'select2-results__options')]//li[not(contains(@class,'select2-results__message')) and not(contains(@class,'loading-results')) and not(contains(@class,'disabled'))]",
    ]
    for xp in xpaths:
        try:
            opts = driver.find_elements(By.XPATH, xp)
            opts = [o for o in opts if (o.text or '').strip()]
            if opts:
                return opts
        except Exception:
            pass
    return []

def _norm_staff_key(s: str) -> str:
    """Chuẩn hoá tên nhân sự: bỏ học hàm/học vị/chức danh (BS, Ths., CKI, ĐD, DD...) để tránh so sai."""
    s = (s or "").strip()
    # Bỏ tiền tố ĐD/DD trước khi strip_accents (vì Đ -> D sau khi bỏ dấu, gây sót)
    s = re.sub(r"^(ĐD|DD|Đ\.D|D\.D)[.\s]+", "", s, flags=re.IGNORECASE)
    s = strip_accents(s.lower())
    s = re.sub(r"[\t\r\n]+", " ", s)
    # bỏ các cụm chức danh phổ biến
    s = re.sub(r"\b(ths|th\.s|thac\s*si)\b", " ", s)
    s = re.sub(r"\b(bs|b\.s)\b", " ", s)
    s = re.sub(r"\b(cki|ckii|ck1|ck2)\b", " ", s)
    s = re.sub(r"\b(bac\s+si)\b", " ", s)
    s = re.sub(r"\b(dieu\s+duong|y\s+ta)\b", " ", s)
    s = re.sub(r"\b(dd|d\.d)\b", " ", s)  # fallback nếu còn sót
    # dọn ký tự thừa
    s = re.sub(r"[^0-9a-zA-Z ]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s

def xoa_sach_o_chon_thuoc(driver):
    try:
        remove_btns = driver.find_elements(By.CSS_SELECTOR, "span.select2-selection__choice__remove")
        for btn in remove_btns:
            try:
                btn.click()
                time.sleep(0.2)
            except Exception:
                pass
    except Exception:
        pass

def chon_select2_bac_si_y_ta(driver, field_id: str, target_text: str, timeout: int = 15) -> bool:
    """
    Chọn bác sĩ/điều dưỡng trong Select2 của HIS.

    HIS không nạp hết nhân sự vào thẻ <select> ban đầu. Phải mở đúng dropdown
    Select2, gõ vào ô search của dropdown đang mở, rồi click đúng dòng trong
    ul#select2-{field_id}-results. Dòng kết quả thường là table gồm:
      cột 1 = mã đăng nhập, cột 2 = họ tên nhân sự.
    """
    wait = WebDriverWait(driver, timeout)
    target_text = (target_text or '').strip()
    target_norm = _norm_text(target_text)
    if not target_norm:
        return False

    container_id = f"select2-{field_id}-container"
    results_id = f"select2-{field_id}-results"

    def _strip_titles(name: str) -> str:
        x = re.sub(r"\b(TS|ThS|BSCKI|BSCKII|BS|CN|ĐD|DD|KTV)\b\.?", " ", name or "", flags=re.I)
        return re.sub(r"\s+", " ", x).strip()

    def _query_variants(name: str):
        clean = _strip_titles(name)
        parts = clean.split()
        variants = []
        for q in [clean, name, " ".join(parts[-2:]) if len(parts) >= 2 else clean, parts[-1] if parts else clean]:
            q = (q or '').strip()
            if q and q not in variants:
                variants.append(q)
        return variants

    def _is_dropdown_open(d):
        try:
            ul = d.find_element(By.ID, results_id)
            return ul.is_displayed()
        except Exception:
            return False

    def _open_dropdown():
        selectors = [
            f"span[aria-labelledby='{container_id}']",
            f"#{container_id}",
            f"#{container_id} + span.select2-selection__arrow",
        ]
        for sel in selectors:
            try:
                el = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, sel)))
                driver.execute_script("arguments[0].scrollIntoView({block:'center'});", el)
                try:
                    el.click()
                except Exception:
                    driver.execute_script("arguments[0].click();", el)
                WebDriverWait(driver, 3).until(_is_dropdown_open)
                return True
            except Exception:
                pass

        try:
            driver.execute_script(
                "var el=document.getElementById(arguments[0]); if(el && window.jQuery){ $(el).select2('open'); }",
                field_id,
            )
            WebDriverWait(driver, 4).until(_is_dropdown_open)
            return True
        except Exception:
            return False

    def _visible_search_box():
        return wait.until(EC.visibility_of_element_located(
            (By.CSS_SELECTOR, "span.select2-container--open input.select2-search__field")
        ))

    def _type_query(q: str):
        search = _visible_search_box()
        try:
            search.click()
        except Exception:
            pass
        search.send_keys(Keys.CONTROL, "a")
        search.send_keys(Keys.DELETE)
        driver.execute_script("arguments[0].value='';", search)
        driver.execute_script(
            "arguments[0].dispatchEvent(new Event('input',{bubbles:true}));"
            "arguments[0].dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'Backspace'}));",
            search,
        )
        time.sleep(0.15)
        search.send_keys(q)
        driver.execute_script(
            "arguments[0].dispatchEvent(new Event('input',{bubbles:true}));"
            "arguments[0].dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'Enter'}));",
            search,
        )
        time.sleep(0.9)

    def _read_options():
        try:
            ul = driver.find_element(By.ID, results_id)
        except Exception:
            return []
        try:
            driver.execute_script("arguments[0].scrollTop = 0;", ul)
        except Exception:
            pass
        items = ul.find_elements(By.XPATH, "./li[contains(@class,'select2-results__option')]")
        rows = []
        for li in items:
            raw = (li.text or '').strip()
            norm = _norm_text(raw)
            if not norm:
                continue
            if any(x in norm for x in ["dang tai them ket qua", "no results found", "khong tim thay", "searching"]):
                continue
            try:
                tds = li.find_elements(By.TAG_NAME, "td")
                code = (tds[0].text or '').strip() if len(tds) >= 1 else ''
                name = (tds[-1].text or '').strip() if len(tds) >= 2 else raw
            except Exception:
                code, name = '', raw
            rows.append((li, raw, code, name, _norm_text(name), norm))
        return rows

    def _pick_from_options(rows):
        for li, raw, code, name, name_norm, raw_norm in rows:
            if target_norm == name_norm or target_norm in name_norm or name_norm in target_norm:
                return li
        for li, raw, code, name, name_norm, raw_norm in rows:
            if target_norm == raw_norm or target_norm in raw_norm:
                return li
        parts = _strip_titles(target_text).split()
        tail2 = _norm_text(" ".join(parts[-2:])) if len(parts) >= 2 else target_norm
        if tail2:
            for li, raw, code, name, name_norm, raw_norm in rows:
                if tail2 in name_norm or tail2 in raw_norm:
                    return li
        return None

    def _confirm_selected():
        """Chỉ xem là chọn thành công khi tên hiển thị thật sự khớp tên cần chọn.
        Không chấp nhận value mặc định, vì HIS có thể đang giữ BS/DD mặc định cũ.
        """
        try:
            selected_el = driver.find_element(By.ID, container_id)
            selected_text = ((selected_el.text or '') + ' ' + (selected_el.get_attribute('title') or '')).strip()
            selected_norm = _norm_text(selected_text)
            selected_key = _norm_staff_key(selected_text)
            target_key = _norm_staff_key(target_text)
            if target_key and (target_key == selected_key or target_key in selected_key or selected_key in target_key):
                return True
            if target_norm and target_norm in selected_norm:
                return True
            return False
        except Exception:
            return False
    try:
        wait.until(EC.presence_of_element_located((By.ID, container_id)))

        if not _open_dropdown():
            raise TimeoutException(f"Không mở được Select2 cho {field_id}")

        chosen = None
        last_rows = []
        for q in _query_variants(target_text):
            _type_query(q)
            end_time = time.time() + timeout
            while time.time() < end_time:
                rows = _read_options()
                if rows:
                    last_rows = rows
                    chosen = _pick_from_options(rows)
                    if chosen is not None:
                        break
                time.sleep(0.25)
            if chosen is not None:
                break

        if chosen is None:
            names = "; ".join((r[3] or r[1]) for r in last_rows[:8])
            raise Exception(f"Không tìm thấy nhân sự '{target_text}' trong {field_id}. Kết quả thấy: {names}")

        driver.execute_script("arguments[0].scrollIntoView({block:'center'});", chosen)
        # Click đúng dòng kết quả Select2. Một số giao diện cần mouse event thay vì chỉ JS click.
        try:
            ActionChains(driver).move_to_element(chosen).pause(0.05).click(chosen).perform()
        except Exception:
            try:
                chosen.click()
            except Exception:
                driver.execute_script("arguments[0].click();", chosen)
        time.sleep(0.35)

        # Không dùng ENTER mù vì có thể chọn lại dòng đang highlight khác.
        WebDriverWait(driver, 6).until(lambda d: _confirm_selected())
        selected_el = driver.find_element(By.ID, container_id)
        selected_text = ((selected_el.text or '') + ' ' + (selected_el.get_attribute('title') or '')).strip()
        _log(f"      [+] Đã chọn {field_id}: {selected_text.strip() or target_text}")
        return True

    except Exception as e:
        _log(f"      [!] Không chọn được nhân sự '{target_text}' trên dropdown {field_id}. Lỗi: {e}")
        try:
            driver.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE)
        except Exception:
            pass
        return False

def _select2_field_exists(driver, field_id: str) -> bool:
    try:
        return bool(driver.execute_script(
            "var el=document.getElementById(arguments[0]); return !!(el && window.jQuery && $(el).data('select2'));",
            field_id
        ))
    except Exception:
        try:
            driver.find_element(By.ID, f"select2-{field_id}-container")
            return True
        except Exception:
            return False

def _find_drug_select2_field_id(driver):
    """Tự dò field Select2 chọn thuốc/dịch truyền.

    Không dùng XPath input Select2 đầu tiên vì trên modal có nhiều Select2
    (thuốc, bác sĩ, điều dưỡng). Nếu lấy nhầm input của BS/DD thì HIS sẽ báo
    'Chưa chọn thuốc'.
    """
    priority_ids = [
        'cbbThuoc', 'cbbTenThuoc', 'cbbTenThuocDichTruyen', 'cbbDichTruyen',
        'cbbThuocDichTruyen', 'cbbDuoc', 'cbbDuocPham', 'cbbVatTuThuoc',
        'cboThuoc', 'ddlThuoc'
    ]
    for fid in priority_ids:
        if _select2_field_exists(driver, fid):
            return fid

    try:
        ids = driver.execute_script(
            """
            if (!window.jQuery) return [];
            return $('select').filter(function(){
                var id = this.id || '';
                if (!id) return false;
                if (id === 'cbbBacSi' || id === 'cbbYTa' || id === 'cbbNguoiLap') return false;
                return !!$(this).data('select2');
            }).map(function(){ return this.id; }).get();
            """
        ) or []
        # Ưu tiên id có nghĩa là thuốc/dịch/dược.
        for fid in ids:
            n = _norm_text(fid)
            if any(k in n for k in ['thuoc', 'dich', 'duoc']):
                return fid
        if ids:
            return ids[0]
    except Exception:
        pass
    return None

def _select2_has_value(driver, field_id: str) -> bool:
    """Backward-compatible check: native Select2 value thật, không nhận tag giả."""
    state = _selected_drug_state(driver, field_id)
    return bool(state.get('ok')) if state else False


def _clean_lot_value(value):
    """Chuẩn hoá số lô đọc từ Select2; không để literal null/undefined lọt vào form."""
    text = str(value or '').strip()
    if text.lower() in {'null', 'none', 'undefined', 'n/a', 'na', '-'}:
        return ''
    return text


def _parse_drug_option_info(li):
    """Đọc một dòng kết quả Select2 thuốc/dịch truyền dạng bảng.

    Select2 HIS thường trả về các cột:
      Mã | Tên | Đvt | Hoạt chất | Hàm lượng | Số lô
    Trả về dict rỗng nếu dòng là header/message/loading.
    """
    try:
        cls = li.get_attribute('class') or ''
    except Exception:
        cls = ''
    if any(x in cls for x in ['disabled', 'loading-results', 'message']):
        return {}

    raw = (li.text or '').strip()
    raw_norm = _norm_text(raw)
    if not raw_norm:
        return {}
    if any(x in raw_norm for x in ['dang tai', 'khong tim thay', 'no results', 'searching']):
        return {}

    try:
        tds = li.find_elements(By.TAG_NAME, 'td')
    except Exception:
        tds = []
    cells = [(td.text or '').strip() for td in tds]

    # Dòng header trong ví dụ dùng <th>, không phải thuốc thật.
    if len(cells) < 2:
        return {}

    info = {
        'raw_text': raw,
        'ma': cells[0] if len(cells) > 0 else '',
        'ten': cells[1] if len(cells) > 1 else '',
        'dvt': cells[2] if len(cells) > 2 else '',
        'hoat_chat': cells[3] if len(cells) > 3 else '',
        'ham_luong': cells[4] if len(cells) > 4 else '',
        'so_lo': _clean_lot_value(cells[5] if len(cells) > 5 else ''),
    }
    ten_norm = _norm_text(info.get('ten'))
    if ten_norm in {'ten', 'ten thuoc'}:
        return {}
    return info


def _norm_drug_alias(s: str) -> str:
    """Chuẩn hoá alias thuốc/dịch để khớp Select2 an toàn hơn.

    Không dùng fuzzy rộng. Chỉ quy về các biến thể đã gặp trên EMR như
    ``Pha natriclorid`` -> ``natri clorid`` và sodium chloride/NaCl.
    """
    x = _norm_text(s or '')
    x = re.sub(r'^\s*pha\s+', '', x)
    x = re.sub(r'\bnatri\s*clorid\b', 'natri clorid', x)
    x = re.sub(r'\bnatriclorid\b', 'natri clorid', x)
    x = re.sub(r'\bnatri\s*chlorid(?:e)?\b', 'natri clorid', x)
    x = re.sub(r'\bsodium\s*chlorid(?:e)?\b', 'natri clorid', x)
    x = re.sub(r'\bnacl\b', 'natri clorid', x)
    x = re.sub(r'\s+', ' ', x).strip()
    return x


def _selected_drug_state(driver, field_id: str):
    """Đọc trạng thái Select2 thuốc sau click.

    Một số bản HIS AJAX không phản ánh selection qua ``$(select).val()`` ngay,
    nhưng Select2 đã có data/text hợp lệ. Vì vậy đọc đồng thời native value,
    option selected, select2('data') và text container.
    """
    try:
        return driver.execute_script(
            """
            var id = arguments[0];
            var el = document.getElementById(id);
            if (!el) return {ok:false, value:'', tagged:false, selectedText:'', dataText:'', containerText:''};
            var val = '';
            try { val = window.jQuery ? $(el).val() : el.value; } catch(e) { val = el.value || ''; }
            if (Array.isArray(val)) val = val.filter(function(x){ return String(x || '').trim(); });
            var hasValue = Array.isArray(val) ? val.length > 0 : !!String(val || '').trim();
            var tagged = false;
            var selectedText = '';
            try {
                var selected = Array.from(el.options || []).filter(function(o){ return o.selected; });
                tagged = selected.some(function(o){ return o.getAttribute('data-select2-tag') === 'true'; });
                selectedText = selected.map(function(o){ return (o.text || '').trim(); }).filter(Boolean).join(' | ');
            } catch(e) {}
            var dataText = '';
            try {
                if (window.jQuery && $(el).data('select2')) {
                    var data = $(el).select2('data') || [];
                    dataText = data.map(function(x){ return (x && (x.text || x.ten || x.name)) || ''; }).filter(Boolean).join(' | ');
                }
            } catch(e) {}
            var containerText = '';
            try {
                var c = document.getElementById('select2-' + id + '-container');
                if (c) containerText = ((c.textContent || '') + ' ' + (c.getAttribute('title') || '')).trim();
            } catch(e) {}
            return {ok:hasValue && !tagged, value:val, tagged:tagged, selectedText:selectedText, dataText:dataText, containerText:containerText};
            """,
            field_id,
        ) or {}
    except Exception:
        return {}


def _drug_selection_committed(driver, field_id: str, expected_targets=None) -> bool:
    """Xác nhận selection thật mà không bắt buộc native value phải có ngay.

    Nếu native value có thì tin trực tiếp (trừ option tag giả). Nếu value rỗng,
    chỉ chấp nhận khi Select2/container sau click hiển thị tên khớp mạnh với
    target đã được chọn từ một dòng dropdown thật.
    """
    state = _selected_drug_state(driver, field_id)
    if not state or state.get('tagged'):
        return False
    if state.get('ok'):
        return True
    texts = [state.get('selectedText'), state.get('dataText'), state.get('containerText')]
    probes = [_norm_drug_alias(x) for x in (expected_targets or []) if str(x or '').strip()]
    probes = [x for x in probes if x]
    if not probes:
        return False
    for raw in texts:
        cand = _norm_drug_alias(raw or '')
        if not cand or cand in {'chon', 'select', 'lua chon', 'chon thuoc'}:
            continue
        for q in probes:
            if cand == q or q in cand or cand in q:
                return True
            # Cho phép bỏ hàm lượng/thể tích ở hai phía nhưng vẫn cần tên lõi >= 4 ký tự.
            q_base = re.sub(r'\b\d+(?:[,.]\d+)?\s*(?:mg|mcg|g|gram|ml|%|ui|iu)\b.*$', '', q).strip()
            c_base = re.sub(r'\b\d+(?:[,.]\d+)?\s*(?:mg|mcg|g|gram|ml|%|ui|iu)\b.*$', '', cand).strip()
            if len(q_base) >= 4 and len(c_base) >= 4 and (q_base == c_base or q_base in c_base or c_base in q_base):
                return True
    return False


def _drug_option_match_score(info, targets):
    """Chấm điểm dòng thuốc so với các chuỗi cần tìm.

    Ưu tiên khớp tên thuốc/hoạt chất rõ ràng; dùng raw_text làm fallback vì
    nhiều dòng Select2 gộp bảng thành text liên tục.
    """
    if not info:
        return 0
    targets_norm = []
    for t in targets or []:
        t = _norm_drug_alias(t)
        if not t or len(t) < 2:
            continue
        if t not in targets_norm:
            targets_norm.append(t)
    if not targets_norm:
        return 0

    ten = _norm_drug_alias(info.get('ten'))
    hc = _norm_drug_alias(info.get('hoat_chat'))
    ham_luong = _norm_text(info.get('ham_luong'))
    raw = _norm_drug_alias(info.get('raw_text'))

    best = 0
    for target in targets_norm:
        # bỏ bớt hàm lượng khỏi query khi cần, ví dụ "VANCOMYCIN 500mg"
        base = re.sub(r"\b\d+(?:[,.]\d+)?\s*(mg|mcg|g|gram|ml|%|ui|iu)\b.*$", "", target).strip()
        probes = [target]
        if base and base not in probes:
            probes.append(base)
        for q in probes:
            if not q:
                continue
            if ten == q:
                best = max(best, 100)
            elif q in ten or ten in q:
                best = max(best, 92)
            elif hc and (q == hc or q in hc or hc in q):
                best = max(best, 86)
            elif raw and q in raw:
                best = max(best, 78)
            # tăng nhẹ khi query có hàm lượng trùng dòng kết quả
            if best and ham_luong and any(tok in ham_luong for tok in re.findall(r"\d+(?:[,.]\d+)?\s*(?:mg|mcg|g|gram|ml|%|ui|iu)", q)):
                best = min(100, best + 4)
    return best


def _open_drug_select2_and_type(driver, field_id, query):
    """Mở đúng Select2 thuốc và gõ query. Trả về search box hoặc None."""
    results_id = f"select2-{field_id}-results"
    driver.execute_script(
        "var el=document.getElementById(arguments[0]); if(el && window.jQuery){ $(el).select2('open'); }",
        field_id,
    )
    search_box = WebDriverWait(driver, 8).until(
        EC.visibility_of_element_located((By.CSS_SELECTOR, "span.select2-container--open input.select2-search__field"))
    )
    search_box.send_keys(Keys.CONTROL, 'a')
    search_box.send_keys(Keys.DELETE)
    driver.execute_script("arguments[0].value='';", search_box)
    driver.execute_script("arguments[0].dispatchEvent(new Event('input', {bubbles:true}));", search_box)
    time.sleep(0.2)
    if query:
        search_box.send_keys(query)
        driver.execute_script("arguments[0].dispatchEvent(new Event('input', {bubbles:true}));", search_box)
    time.sleep(0.9)
    return search_box


def _read_drug_options_for_field(driver, field_id):
    results_id = f"select2-{field_id}-results"
    try:
        ul = driver.find_element(By.ID, results_id)
        lis = ul.find_elements(By.XPATH, "./li[contains(@class,'select2-results__option')]")
    except Exception:
        lis = _get_open_select2_options(driver)
    rows = []
    for li in lis:
        info = _parse_drug_option_info(li)
        if info:
            rows.append((li, info))
    return rows


def _pick_drug_option(rows, targets):
    best_li = None
    best_info = {}
    best_score = 0
    for li, info in rows or []:
        score = _drug_option_match_score(info, targets)
        if score > best_score:
            best_li, best_info, best_score = li, info, score
    return best_li, best_info, best_score


def nhap_thuoc_select2_va_lay_lo(driver, ten_thuoc, extra_targets=None, click_choice=True):
    """Chọn thuốc/dịch truyền qua Select2 và đọc số lô của dòng đã chọn.

    Chỉ chọn dòng dropdown có match score đủ tin cậy. Sau click, xác nhận bằng
    native value *hoặc* Select2 data/container text vì một số HIS AJAX cập nhật
    value chậm/rỗng dù selection UI đã commit. DOM Select2 có thể redraw nên
    retry toàn bộ thao tác khi gặp stale element.
    """
    query = (ten_thuoc or '').strip()
    targets = [query] + [x for x in (extra_targets or []) if str(x or '').strip()]
    field_id = _find_drug_select2_field_id(driver)
    base_out = {'ok': False, 'field_id': field_id or '', 'so_lo': '', 'option': {}, 'query': query}
    if not field_id:
        return base_out

    last_err = None
    for attempt in range(1, 3):
        out = dict(base_out)
        try:
            search_box = _open_drug_select2_and_type(driver, field_id, query)
            rows = _read_drug_options_for_field(driver, field_id)
            if not rows:
                try:
                    search_box.send_keys(Keys.CONTROL, 'a')
                    search_box.send_keys(Keys.DELETE)
                    driver.execute_script("arguments[0].value=''; arguments[0].dispatchEvent(new Event('input', {bubbles:true}));", search_box)
                    time.sleep(0.6)
                    rows = _read_drug_options_for_field(driver, field_id)
                except Exception:
                    pass

            chosen, info, score = _pick_drug_option(rows, targets)
            if chosen is None or score < 70:
                if rows:
                    seen = '; '.join((r[1].get('ten') or r[1].get('raw_text') or '') for r in rows[:5])
                    LOG.info(
                        f"      [!] Không có kết quả Select2 đủ tin cậy cho '{query}' "
                        f"(score={score}). Kết quả thấy: {seen}"
                    )
                return out

            out['option'] = info or {}
            out['so_lo'] = (info or {}).get('so_lo', '').strip()
            out['score'] = score
            if not click_choice:
                out['ok'] = True
                return out

            # Native mouse click trước. JS click là fallback cuối vì một số Select2
            # bắt mouseup/mousedown và không commit selection với element.click().
            clicked = False
            try:
                driver.execute_script("arguments[0].scrollIntoView({block:'center'});", chosen)
                ActionChains(driver).move_to_element(chosen).pause(0.05).click(chosen).perform()
                clicked = True
            except Exception:
                try:
                    chosen.click()
                    clicked = True
                except Exception:
                    try:
                        _safe_js_click(driver, chosen)
                        clicked = True
                    except Exception:
                        clicked = False
            if not clicked:
                return out

            expected = targets + [(info or {}).get('ten', ''), (info or {}).get('hoat_chat', '')]
            end_t = time.time() + 2.5
            while time.time() < end_t:
                if _drug_selection_committed(driver, field_id, expected):
                    out['ok'] = True
                    break
                time.sleep(0.15)

            if out['ok']:
                state = _selected_drug_state(driver, field_id)
                msg = f"      [i] Đã chọn thuốc qua {field_id}: {(info or {}).get('ten') or query}"
                if not state.get('ok'):
                    msg += " | Select2 đã commit theo text/data (native value rỗng)"
                if out['so_lo']:
                    msg += f" | số lô: {out['so_lo']}"
                LOG.info(msg)
            return out

        except StaleElementReferenceException as e:
            last_err = e
            LOG.info(f"      [i] Select2 redraw DOM khi chọn '{query}', thử lại ({attempt}/2).")
            try:
                driver.find_element(By.TAG_NAME, 'body').send_keys(Keys.ESCAPE)
            except Exception:
                pass
            time.sleep(0.25)
            continue
        except Exception as e:
            last_err = e
            # Chrome đôi khi bọc stale thành WebDriverException text; retry một lần.
            if 'stale element reference' in str(e).lower() and attempt < 2:
                LOG.info(f"      [i] Select2 stale khi đọc '{query}', thử lại ({attempt}/2).")
                try:
                    driver.find_element(By.TAG_NAME, 'body').send_keys(Keys.ESCAPE)
                except Exception:
                    pass
                time.sleep(0.25)
                continue
            break

    if last_err is not None:
        LOG.info(f"      [!] Không chọn/đọc được số lô thuốc '{query}'. Lỗi: {last_err}")
    try:
        driver.find_element(By.TAG_NAME, 'body').send_keys(Keys.ESCAPE)
    except Exception:
        pass
    return base_out

def nhap_thuoc_select2(driver, ten_thuoc):
    query = (ten_thuoc or '').strip()
    target_norm = _norm_text(query)
    field_id = _find_drug_select2_field_id(driver)

    try:
        if field_id:
            results_id = f"select2-{field_id}-results"
            # Mở đúng Select2 của thuốc bằng jQuery, tránh click nhầm Select2 BS/DD.
            driver.execute_script(
                "var el=document.getElementById(arguments[0]); if(el && window.jQuery){ $(el).select2('open'); }",
                field_id
            )
            search_box = WebDriverWait(driver, 8).until(
                EC.visibility_of_element_located((By.CSS_SELECTOR, "span.select2-container--open input.select2-search__field"))
            )
            search_box.send_keys(Keys.CONTROL, 'a')
            search_box.send_keys(Keys.DELETE)
            driver.execute_script("arguments[0].value='';", search_box)
            driver.execute_script("arguments[0].dispatchEvent(new Event('input', {bubbles:true}));", search_box)
            time.sleep(0.2)
            if query:
                search_box.send_keys(query)
            time.sleep(0.9)

            def _options_for_field(d):
                try:
                    ul = d.find_element(By.ID, results_id)
                    lis = ul.find_elements(By.XPATH, "./li[contains(@class,'select2-results__option')]")
                except Exception:
                    lis = _get_open_select2_options(d)
                valid = []
                for li in lis:
                    txt = _norm_text(li.text)
                    if not txt:
                        continue
                    if 'dang tai' in txt or 'khong tim thay' in txt or 'no results' in txt:
                        continue
                    cls = li.get_attribute('class') or ''
                    if 'disabled' in cls or 'loading-results' in cls or 'message' in cls:
                        continue
                    valid.append(li)
                return valid

            options = _options_for_field(driver)
            if not options:
                # Nếu tìm theo Paracetamol không ra do bộ lọc AJAX, xóa query để lấy option đầu tiên.
                search_box.send_keys(Keys.CONTROL, 'a')
                search_box.send_keys(Keys.DELETE)
                time.sleep(0.6)
                options = _options_for_field(driver)

            chosen = None
            for opt in options:
                txt = _norm_text(opt.text)
                if target_norm and (txt == target_norm or target_norm in txt):
                    chosen = opt
                    break
            # Không chọn option đầu tiên nếu tên không khớp query.
            if chosen is None and not target_norm and options:
                chosen = options[0]

            if chosen is not None:
                try:
                    _safe_js_click(driver, chosen)
                except Exception:
                    chosen.click()
                time.sleep(0.5)
                ok = _drug_selection_committed(driver, field_id, [query])
                if ok:
                    LOG.info(f"      [i] Đã chọn thuốc qua {field_id}: {query or chosen.text}")
                    return True
                LOG.info(f"      [!] Đã click thuốc nhưng {field_id} chưa có value thật.")

        # Fallback cũ: dùng input tag của Select2 nếu không dò được id thuốc.
        search_box = driver.find_element(By.XPATH, "//ul[contains(@class,'select2-selection__rendered')]//input")
        search_box.click()
        search_box.send_keys(Keys.CONTROL, 'a')
        search_box.send_keys(Keys.DELETE)
        if query:
            search_box.send_keys(query)
        time.sleep(0.8)
        options = _get_open_select2_options(driver)
        chosen = None
        for opt in options:
            txt = _norm_text(opt.text)
            if target_norm and (txt == target_norm or target_norm in txt):
                chosen = opt
                break
        if chosen is None and not target_norm and options:
            chosen = options[0]
        if chosen is not None:
            try:
                _safe_js_click(driver, chosen)
            except Exception:
                chosen.click()
            time.sleep(0.3)
            if field_id:
                return _drug_selection_committed(driver, field_id, [query])
            return False
        return False
    except Exception as e:
        LOG.info(f"      [!] Không chọn được thuốc '{query}'. Lỗi: {e}")
        try:
            driver.find_element(By.TAG_NAME, 'body').send_keys(Keys.ESCAPE)
        except Exception:
            pass
        return False

def _select2_selected_text(driver, container_id):
    try:
        txt = driver.find_element(By.ID, f"select2-{container_id}-container").text or ""
        return txt.strip()
    except Exception:
        return ""
