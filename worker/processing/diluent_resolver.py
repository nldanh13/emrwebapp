# -*- coding: utf-8 -*-
"""Gợi ý/gắn dung môi NaCl và chuyển thuốc tiêm cần pha sang dịch truyền."""
import re

from runtime_logging import get_worker_logger
try:
    from processing.semantic_search import semantic_solvent_kind
except Exception:
    semantic_solvent_kind = None
from xu_ly_config import (
    ALWAYS_INFUSION_DRUGS,
    DEFAULT_NACL_VOLUME_BY_KEYWORD,
    _contains_any,
    _norm_upper,
    get_safety_nacl_volume,
    parse_hours_from_gio_dung,
    parse_quantity_int,
)

LOG = get_worker_logger('xu_ly.diluent')

def infer_and_reclassify_diluents(raw_dich_truyen, raw_thuoc_tiem):
    """Gắn dung môi NaCl theo gợi ý (cùng giờ) và chuẩn hoá thuốc cần pha truyền.

    Mục tiêu:
    - Thuốc cần pha truyền (ví dụ VANCOMYCIN, MEROVIA, NEFOPAM, ...) sẽ có thêm dung_moi và được tính thời gian theo thể tích dung môi.
    - Các dòng Natri/Sodium chloride (túi/chai) trong y lệnh chỉ đóng vai trò "dung môi pha truyền" sẽ KHÔNG xuất hiện như một dịch truyền độc lập ở output.

    Quy tắc chính:
    - Ưu tiên luật an toàn (LUAT_AN_TOAN) nếu có (ví dụ NEFOPAM/TRAMADOL: 100 ml).
    - Nếu chính dòng thuốc có 'the_tich_lay_ml' / 'the_tich_pha_du_ml' (đã parse từ "lấy đủ ... ml", "pha đủ ... ml") thì dùng luôn thể tích đó.
    - Nếu có túi/chai NaCl cùng giờ: ưu tiên túi 100 ml (Natri). Nếu không có, lấy thể tích nhỏ nhất.
    - ten_hien_thi: không hiển thị số ml, chỉ hiển thị tên dung môi.
    """
    raw_dich_truyen = raw_dich_truyen or []
    raw_thuoc_tiem = raw_thuoc_tiem or []

    def _is_flush_only_diluent(item):
        """NaCl dùng thông/tráng ống không phải dịch truyền và cũng không phải túi pha thuốc."""
        if not isinstance(item, dict):
            return False
        if item.get("flush_only") or item.get("usage_purpose") == "iv_line_flush":
            return True
        route = str(item.get("duong_dung_goc") or "").strip().lower().strip(" .;,:-–—")
        return bool(re.fullmatch(
            r'(?:thông\s*)?(?:tráng|trang)\s+(?:ống|ong)(?:\s+kim\s+(?:luồn|luon))?'
            r'|(?:rửa|rua)\s+(?:ống|ong)(?:\s+kim\s+(?:luồn|luon))?',
            route,
            flags=re.IGNORECASE,
        ))

    # -----------------------------
    # 1) Thu thập túi/chai NaCl theo giờ (để dùng làm dung môi)
    # -----------------------------
    diluent_by_hour = {}
    diluent_all = []

    def _dil_kind(name_u: str, route_u: str):
        """Nhận diện dòng dung môi NaCl/Natri/Sodium dựa trên TÊN THUỐC.

        KHÔNG dựa vào 'duong_dung_goc' để tránh nhầm các thuốc có ghi
        'pha với Sodium/Natri...' (ví dụ VANCOMYCIN) thành dung môi.
        """
        t = f"{name_u}"
        if "SODIUM" in t and ("CHLORIDE" in t or "CLORID" in t or "CHLORID" in t or "NACL" in t or "0.9" in t or "0,9" in t):
            return "SODIUM"
        if "NATRI CLORID" in t or "NATRI CHLORID" in t or "NATRI CHLORIDE" in t or "NACL" in t:
            return "NACL"
        if "NUOC MUOI" in t or "NƯỚC MUỐI" in t:
            return "NACL"
        return None
    for dt in raw_dich_truyen:
        # NaCl "Thông tráng ống/Tráng ống kim luồn" không được đưa vào pool
        # dung môi, nếu không có thể bị gán nhầm cho một thuốc truyền khác.
        if _is_flush_only_diluent(dt):
            continue
        name_u = _norm_upper(dt.get("ten_thuoc", ""))
        route_u = _norm_upper(dt.get("duong_dung_goc", ""))
        kind = _dil_kind(name_u, route_u)
        route_l = (dt.get("duong_dung_goc") or "").lower()
        solvent_hint = (
            ("pha" in route_l)
            or ("dùng để pha" in route_l)
            or ("dung de pha" in route_l)
            or ("lấy" in route_l)
            or ("lay" in route_l)
        )

        # Heuristic: NaCl 100ml, không tốc độ -> thường là dung môi (dù y lệnh không ghi chữ "pha")
        try:
            _vol_dt = float(dt.get("the_tich") or 0)
        except Exception as exc:
            LOG.debug("Handled xu_ly fallback exception", exc_info=True)
            _vol_dt = 0.0
        toc_do_txt = str(dt.get("toc_do", "") or "").strip()

        likely_solvent_nacl = (
            kind in ("NACL", "SODIUM")
            and (_vol_dt <= 100 or _vol_dt == 0)   # 0 => chưa parse được thể tích, tạm cho vào pool
            and not toc_do_txt
        )

        # Chỉ bỏ khỏi pool dung môi khi rõ ràng là dịch truyền thật (truyền nền)
        if kind and not (solvent_hint or likely_solvent_nacl):
            continue

        if not kind:
            continue

        # thể tích túi/chai
        try:
            vol = int(dt.get("the_tich") or 0)
        except Exception as exc:
            LOG.debug("Handled xu_ly fallback exception", exc_info=True)
            vol = 0
        if vol <= 0:
            vol = 500 if kind == "SODIUM" else 100

        # thể tích "lấy đủ" (nếu có)
        take = None
        try:
            take = int(dt.get("the_tich_lay_ml") or 0) or None
        except Exception as exc:
            LOG.debug("Handled xu_ly fallback exception", exc_info=True)
            take = None

        # Một dòng NaCl có thể là x2, x3... hoặc có so_luong_moi_gio.
        # Cần tách thành từng "đơn vị dung môi" để không dùng 1 chai NaCl cho nhiều thuốc.
        _diluent_seq = len(diluent_all)

        def _safe_int_qty(x):
            return parse_quantity_int(x, default=0)

        def _qty_for_diluent_hour(item, h, hours):
            # Ưu tiên so_luong_moi_gio nếu parser đã tách được.
            slmg = item.get("so_luong_moi_gio")
            if isinstance(slmg, dict):
                for key in (str(h), h):
                    q = _safe_int_qty(slmg.get(key))
                    if q > 0:
                        return min(q, 20)

            # Nếu chỉ có 1 giờ dùng thì so_luong thường là số chai/túi của giờ đó.
            if len(hours or []) <= 1:
                q = _safe_int_qty(item.get("so_luong"))
                if q > 0:
                    return min(q, 20)

            # Nếu có nhiều giờ mà không tách được số lượng từng giờ: giữ an toàn 1 chai/túi mỗi giờ.
            return 1

        base_text = f"{dt.get('ten_thuoc','')} {dt.get('duong_dung_goc','')}"
        hours = parse_hours_from_gio_dung(dt.get("gio_dung", ""))

        def _make_rec(hour=None, idx=1):
            nonlocal _diluent_seq
            _diluent_seq += 1
            return {
                "id": f"DIL-{len(diluent_all)}-{_diluent_seq}-{hour if hour is not None else 'NA'}-{idx}",
                "kind": kind,
                "vol": float(vol),
                "take": take,
                "hour": hour,
                "text": base_text,
            }

        if hours:
            for h in hours:
                qty = _qty_for_diluent_hour(dt, h, hours)
                for idx in range(max(1, qty)):
                    rec = _make_rec(h, idx + 1)
                    diluent_all.append(rec)
                    diluent_by_hour.setdefault(h, []).append(rec)
        else:
            qty = _safe_int_qty(dt.get("so_luong")) or 1
            for idx in range(max(1, min(qty, 20))):
                rec = _make_rec(None, idx + 1)
                diluent_all.append(rec)

    def _is_tramadol_drug(drug):
        name_u = _norm_upper(f"{drug.get('ten_thuoc', '')} {drug.get('hoat_chat', '')} {drug.get('ten_hien_thi', '')}")
        # TRASOLU là tên thương mại Tramadol thường gặp trong dữ liệu khoa.
        # Một số dòng EMR không kèm hoạt chất, nên chỉ dò chữ TRAMADOL sẽ bỏ sót
        # và giữ nhầm 2ml (thể tích ống) làm thể tích truyền.
        return any(alias in name_u for alias in ("TRAMADOL", "TRASOLU"))

    def _route_has_explicit_infusion_or_nacl(drug):
        route_l = (drug.get("duong_dung_goc") or "").lower()
        return any(k in route_l for k in [
            "ttm", "truyền", "truyen", "tiêm truyền", "tiem truyen", "pha truyền", "pha truyen",
            "giọt/phút", "giot/phut", "g/p", "ml/h", "ml/giờ", "ml/gio",
            "natri clorid", "natri chlorid", "natri chloride",
            "sodium clorid", "sodium chlorid", "sodium chloride",
            "nacl", "nước muối", "nuoc muoi"
        ]) or bool(drug.get("dung_moi"))

    def _route_is_clear_im_or_sc(drug):
        route_l = (drug.get("duong_dung_goc") or "").lower()
        return any(k in route_l for k in ["tiêm bắp", "tiem bap", "bắp", "bap", " im ", "(im)", "dưới da", "duoi da", " sc ", "(sc)"])

    def _is_nacl_drug_line(drug):
        name_u = _norm_upper(f"{drug.get('ten_thuoc', '')} {drug.get('ten_hien_thi', '')}")
        return any(k in name_u for k in ["NATRI CLORID", "NATRI CHLORID", "NATRI CHLORIDE", "SODIUM CHLORIDE", "NACL", "NUOC MUOI", "NƯỚC MUỐI"])

    def _is_water_for_injection_line(drug):
        name_u = _norm_upper(f"{drug.get('ten_thuoc', '')} {drug.get('ten_hien_thi', '')}")
        return any(k in name_u for k in ["NƯỚC CẤT", "NUOC CAT", "AQUA", "WATER FOR INJECTION"])

    def _drug_hours(drug):
        return parse_hours_from_gio_dung(drug.get("gio_dung", "")) or []

    def _drug_likely_consumes_nacl_before_tramadol(drug):
        """Ước tính thuốc khác có quyền ưu tiên dùng NaCl trước Tramadol.

        Mục tiêu không phải đổi đường dùng thuốc này sang dịch truyền, mà chỉ để đếm số chai/túi NaCl
        đã có khả năng được dùng để pha thuốc khác trong cùng giờ. Nhờ vậy Tramadol chỉ lấy NaCl dư.
        """
        if not isinstance(drug, dict):
            return False
        if _is_tramadol_drug(drug) or _is_nacl_drug_line(drug) or _is_water_for_injection_line(drug):
            return False

        name_u = _norm_upper(f"{drug.get('ten_thuoc', '')} {drug.get('hoat_chat', '')} {drug.get('ten_hien_thi', '')}")
        route_l = (drug.get("duong_dung_goc") or "").lower()
        dang_u = _norm_upper(drug.get("dang", ""))

        # Y lệnh ghi rõ pha/truyền/NaCl thì chắc chắn ưu tiên trước Tramadol.
        if any(k in route_l for k in [
            "ttm", "truyền", "truyen", "tiêm truyền", "tiem truyen", "pha truyền", "pha truyen",
            "natri clorid", "natri chlorid", "natri chloride",
            "sodium clorid", "sodium chlorid", "sodium chloride",
            "nacl", "nước muối", "nuoc muoi",
            "giọt/phút", "giot/phut", "g/p", "ml/h", "ml/giờ", "ml/gio"
        ]):
            return True

        # Thuốc trong nhóm thường phải pha truyền theo cấu hình.
        if get_safety_nacl_volume(name_u) is not None:
            return True
        if _contains_any(name_u, list(DEFAULT_NACL_VOLUME_BY_KEYWORD.keys())):
            return True
        if any(k in name_u for k in ALWAYS_INFUSION_DRUGS):
            return True

        # Thuốc dạng lọ/bột + đường tiêm/tĩnh mạch: thường có dung môi riêng, ưu tiên hơn Tramadol.
        is_vial_powder = any(k in dang_u for k in ["LỌ", "LO", "BỘT", "BOT"])
        has_injection_hint = any(k in route_l for k in ["tiêm", "tiem", "tĩnh mạch", "tinh mach", "tmc", "tm chậm", "mach cham"])
        if is_vial_powder and has_injection_hint:
            return True

        return False

    def _mandatory_nacl_demand_for_hour(hour):
        count = 0
        for d in list(raw_dich_truyen or []) + list(raw_thuoc_tiem or []):
            if hour not in _drug_hours(d):
                continue
            if _drug_likely_consumes_nacl_before_tramadol(d):
                count += 1
        return count

    def _sort_diluent_candidates(candidates):
        def key(c):
            vol = float(c.get("vol") or 0)
            txt = (c.get("text") or "").lower()
            # Ưu tiên chai/túi 100ml; sau đó ưu tiên dòng không ghi thuốc khác.
            return (0 if vol == 100 else 1, vol or 9999, 1 if any(x in txt for x in ["pha", "dùng để pha", "dung de pha"]) else 0)
        return sorted(candidates, key=key)

    def _free_nacl_candidates_for_tramadol(drug):
        """NaCl rời dùng được cho Tramadol theo nguyên tắc còn dư mới pha.

        Thứ tự ưu tiên:
        1) Nếu dòng NaCl ghi rõ pha Tramadol -> dùng cho Tramadol.
        2) Nếu NaCl chung cùng giờ:
           - Đếm các thuốc khác cùng giờ có khả năng cần NaCl trước.
           - Chỉ lấy phần NaCl còn dư sau khi đã trừ số đó.

        Ví dụ: cùng giờ có CEFOXITIN + TRAMADOL.
        - 1 NaCl  -> CEFOXITIN dùng, TRAMADOL vẫn tiêm bắp.
        - 2 NaCl  -> CEFOXITIN dùng 1, TRAMADOL được pha với 1.
        """
        if not _is_tramadol_drug(drug):
            return []

        hours = parse_hours_from_gio_dung(drug.get("gio_dung", ""))
        if not hours:
            return []

        blocked_keywords = [
            "CEFOXITIN", "CEFAZOLIN", "CEFTRIAXON", "CEFTRIAXONE", "CEFOTAXIM", "CEFOTAXIME",
            "VANCOMYCIN", "MEROPENEM", "MEROVIA", "PIPERACILLIN", "TAZOBACTAM",
            "PARACETAMOL", "THERMODOL", "NEFOPAM", "METHYLPREDNISOLON", "SOLU",
            "RABEPRAZOLE", "ESOMEPRAZOLE"
        ]

        out = []
        seen = set()
        for h in hours:
            same_hour = [
                rec for rec in (diluent_by_hour.get(h, []) or [])
                if rec.get("kind") in ("NACL", "SODIUM")
            ]
            if not same_hour:
                continue

            direct_for_tramadol = []
            generic_free = []

            for rec in same_hour:
                txt_u = _norm_upper(rec.get("text", ""))
                # Dòng dung môi ghi rõ Tramadol thì ưu tiên dùng cho Tramadol.
                if "TRAMADOL" in txt_u:
                    direct_for_tramadol.append(rec)
                    continue

                # Dòng NaCl có nhắc thuốc khác thì coi như đã dành cho thuốc đó.
                if any(k in txt_u for k in blocked_keywords):
                    continue

                generic_free.append(rec)

            selected = []
            if direct_for_tramadol:
                selected = _sort_diluent_candidates(direct_for_tramadol)
            else:
                generic_free = _sort_diluent_candidates(generic_free)
                mandatory_count = _mandatory_nacl_demand_for_hour(h)
                # Tramadol chỉ được lấy phần NaCl còn dư sau thuốc khác.
                selected = generic_free[mandatory_count:] if len(generic_free) > mandatory_count else []

            for rec in selected:
                key = rec.get("id") or (h, rec.get("kind"), float(rec.get("vol") or 0), _norm_upper(rec.get("text", "")))
                if key in seen:
                    continue
                seen.add(key)
                out.append(rec)

        return out

    def _prefer_tramadol_intramuscular(drug):
        if not _is_tramadol_drug(drug):
            return False
        if _route_is_clear_im_or_sc(drug):
            return True
        if _route_has_explicit_infusion_or_nacl(drug):
            return False
        # Nếu có NaCl rời cùng giờ thì rule sau sẽ chuyển sang dịch truyền.
        if _free_nacl_candidates_for_tramadol(drug):
            return False
        route_l = (drug.get("duong_dung_goc") or "").lower()
        return ("tiêm" in route_l) or ("tiem" in route_l) or not route_l.strip()

    def _drug_name_text_u(drug):
        """Tên + hoạt chất + tên hiển thị để nhận diện thuốc pha truyền.

        Một số thuốc trong EMR có tên thương mại không chứa hoạt chất, ví dụ
        VECMID 1GM nhưng hoạt chất là Vancomycin. Nếu chỉ dò `ten_thuoc`,
        parser sẽ hiểu nhầm VECMID là thuốc tiêm TMC thay vì dịch truyền pha NaCl.
        """
        if not isinstance(drug, dict):
            return ""
        text = _norm_upper(" ".join([
            str(drug.get("ten_thuoc") or ""),
            str(drug.get("hoat_chat") or ""),
            str(drug.get("ten_hien_thi") or ""),
        ]))
        # Một số tên thương mại không chứa hoạt chất trong ten_thuoc.
        brand_alias = {
            "VECMID": "VANCOMYCIN",
            "VECMID 1GM": "VANCOMYCIN",
        }
        for brand, active in brand_alias.items():
            if brand in text and active not in text:
                text = f"{text} {active}"
        return text

    def choose_bag_volume_and_type(drug):
        """Return (bag_ml, dung_moi_code, explicit_from_ylenh)."""
        name_u = _drug_name_text_u(drug)
        route_l = (drug.get("duong_dung_goc") or "").lower()
        hours = parse_hours_from_gio_dung(drug.get("gio_dung", ""))

        # A) Ưu tiên thể tích đã tách ngay trên chính thuốc (lấy đủ / pha đủ / túi X ml)
        take_self = None
        for key in ("the_tich_lay_ml", "the_tich_pha_du_ml", "tui_dich_truyen_ml"):
            try:
                v = float(drug.get(key) or 0)
                if v > 0:
                    take_self = v
                    break
            except Exception as exc:
                LOG.debug("Handled xu_ly fallback exception", exc_info=True)
                pass
        if take_self:
            dm = "SODIUM_0.9" if (take_self > 100 or "sodium" in route_l) else "NACL_0.9"
            return float(take_self), dm, True

        # TRAMADOL: ưu tiên tiêm bắp. Chỉ pha NaCl khi y lệnh ghi rõ truyền/NaCl
        # hoặc có một túi/chai NaCl rời cùng giờ không gắn với thuốc khác.
        if _is_tramadol_drug(drug):
            free_candidates = _free_nacl_candidates_for_tramadol(drug)
            if free_candidates:
                vols = sorted({float(c.get("vol") or 0) for c in free_candidates if float(c.get("vol") or 0) > 0})
                bag = 100.0 if 100.0 in vols else (float(vols[0]) if vols else 100.0)
                any_sodium = any(c.get("kind") == "SODIUM" for c in free_candidates) or any("sodium" in (c.get("text") or "").lower() for c in free_candidates)
                dm = "SODIUM_0.9" if (any_sodium or bag > 100) else "NACL_0.9"
                return bag, dm, True

            if _route_has_explicit_infusion_or_nacl(drug):
                safety_vol = get_safety_nacl_volume(name_u) or 100.0
                return float(safety_vol), "NACL_0.9", False

        # B) Theo túi/chai NaCl cùng giờ
        candidates = []
        for h in hours:
            candidates.extend(diluent_by_hour.get(h, []))

        # Nếu không có cùng giờ mà vẫn có NaCl ở đâu đó, dùng để tránh fallback sai
        if not candidates and diluent_all:
            candidates = diluent_all[:]

        if candidates:

            # PARACETAMOL/THERMODOL (dạng Ống/INJ): ưu tiên dung môi có ghi "pha paracetamol/thermodol"
            # (kể cả dòng dung môi không có giờ), và tránh bị 'ăn' nhầm chai Sodium 500ml cùng giờ.
            dang_u = (drug.get("dang") or "").upper()
            is_para_inj = ("INJ" in name_u) or ("INJECTION" in name_u) or ("ỐNG" in dang_u) or ("ONG" in dang_u)
            if is_para_inj and (("PARACETAMOL" in name_u) or ("THERMODOL" in name_u)):
                key = "paracetamol" if "PARACETAMOL" in name_u else "thermodol"
                pool = candidates + [c for c in diluent_all if c not in candidates]
                ref = [c for c in pool if key in (c.get("text") or "").lower()]
                if ref:
                    vols = [float(c.get("vol") or 0) for c in ref if float(c.get("vol") or 0) > 0]
                    bag = 100.0 if 100.0 in vols else (float(sorted(vols)[0]) if vols else 100.0)
                    any_sodium = any(c.get("kind") == "SODIUM" for c in ref) or any("sodium" in (c.get("text") or "").lower() for c in ref)
                    dm = "SODIUM_0.9" if (any_sodium or bag > 100) else "NACL_0.9"
                    return bag, dm, True
                return 100.0, "NACL_0.9", True

            # VANCOMYCIN: ưu tiên tuyệt đối thể tích ghi trong y lệnh/dòng dung môi.
            # Hai ca thực tế cần đúng 200ml mỗi cữ:
            # - "Pha 200ml natriclorid X2 TTM..."
            # - "lấy 200ml pha 1g vancomycin"
            if "VANCOMYCIN" in name_u:
                # Ưu tiên đúng dòng dung môi có nhắc Vancomycin (tránh dính nhầm NaCl của thuốc khác)
                vanco_candidates = [c for c in candidates if "vancomycin" in (c.get("text") or "").lower()]
                pool = vanco_candidates if vanco_candidates else candidates

                explicit_vols = []
                for c in pool:
                    txt = c.get("text") or ""
                    if c.get("take"):
                        explicit_vols.append(float(c["take"]))
                        continue
                    m = re.search(r'(?i)\b(?:lấy|lay|pha)\s*(?:đủ\s*)?(\d+(?:[\.,]\d+)?)\s*ml\b', txt)
                    if m:
                        try:
                            explicit_vols.append(float(m.group(1).replace(',', '.')))
                        except Exception as exc:
                            LOG.debug("Handled xu_ly fallback exception", exc_info=True)

                if explicit_vols:
                    bag = float(sorted(explicit_vols)[0])
                    any_sodium = any((c.get("kind") == "SODIUM") for c in pool) or any("sodium" in (c.get("text") or "").lower() for c in pool) or bag > 100
                    dm = "SODIUM_0.9" if any_sodium else "NACL_0.9"
                    return bag, dm, True

                # nếu không có "lấy/pha X ml" nhưng có dòng dung môi (túi/chai) -> lấy thể tích túi/chai
                vols = [float(c.get("vol") or 0) for c in pool if float(c.get("vol") or 0) > 0]
                if vols:
                    bag = float(sorted(vols)[0])
                    any_sodium = any((c.get("kind") == "SODIUM") for c in pool) or any("sodium" in (c.get("text") or "").lower() for c in pool)
                    dm = "SODIUM_0.9" if (any_sodium or bag > 100) else "NACL_0.9"
                    return bag, dm, True


        # C) Luật an toàn: chỉ áp dụng khi KHÔNG có dữ kiện thể tích từ y lệnh (A/B)
        safety_vol = get_safety_nacl_volume(name_u)
        if safety_vol:
            return float(safety_vol), "NACL_0.9", False

        # D) Suy luận theo thể tích túi/chai NaCl (không có "lấy đủ")
        if candidates:
            vols = sorted({float(c["vol"]) for c in candidates if float(c.get("vol") or 0) > 0})
            if 100.0 in vols:
                return 100.0, "NACL_0.9", False

            bag = float(vols[0]) if vols else 100.0
            return bag, ("SODIUM_0.9" if bag > 100 else "NACL_0.9"), False

        # E) mapping keyword (trừ VANCOMYCIN)
        for kw, v in DEFAULT_NACL_VOLUME_BY_KEYWORD.items():
            if kw in name_u and kw != "VANCOMYCIN":
                bag = float(v)
                return bag, ("SODIUM_0.9" if bag > 100 else "NACL_0.9"), False

        return 100.0, "NACL_0.9", False

    def is_candidate_need_nacl(drug):
        name_u = _drug_name_text_u(drug)
        route_l = (drug.get("duong_dung_goc") or "").lower()
        dang_u = _norm_upper(drug.get("dang", ""))

        # loại trừ: bản thân là túi/chai NaCl
        if any(k in name_u for k in ["NATRI CLORID", "SODIUM CHLORIDE", "NACL"]):
            return False

        # TRAMADOL: ưu tiên tiêm bắp. Chỉ chuyển sang truyền nếu ghi rõ TTM/truyền/NaCl
        # hoặc có NaCl rời cùng giờ không pha với thuốc khác.
        if _is_tramadol_drug(drug):
            if _route_is_clear_im_or_sc(drug):
                return False
            if _route_has_explicit_infusion_or_nacl(drug):
                return True
            return bool(_free_nacl_candidates_for_tramadol(drug))

        # Chỉ chuyển thuốc tiêm sang dịch truyền khi có NaCl/Sodium chloride rõ ràng hoặc rule cấu hình.
        # Không dùng riêng chữ "natri" vì có thể là một phần tên hoạt chất như Ceftriaxone Natri/Diclofenac Natri.
        has_explicit_nacl = bool(drug.get("dung_moi") in ("NACL_0.9", "SODIUM_0.9")) or any(k in route_l for k in [
            "natri clorid", "natri chlorid", "natri chloride",
            "sodium clorid", "sodium chlorid", "sodium chloride",
            "nacl", "nước muối", "nuoc muoi",
        ])
        if has_explicit_nacl:
            return True

        # Chai/túi truyền sẵn có thể tích riêng (ví dụ CIPROFLOXACIN KABI 200mg/100ml)
        # KHÔNG được tự gắn thêm NaCl chỉ vì dạng thuốc có chuỗi tổng quát
        # "Chai/Lọ/Ống/Túi" và đường dùng là TTM. Đây là thành phẩm truyền sẵn,
        # không phải lọ bột cần pha. Nếu y lệnh thật sự ghi NaCl thì nhánh
        # has_explicit_nacl phía trên đã xử lý trước khi tới đây.
        def _ready_to_infuse_product():
            try:
                vol = float(str(drug.get("the_tich") or 0).replace(',', '.'))
            except Exception:
                vol = 0.0
            raw_blob = _norm_upper(" ".join([
                str(drug.get("raw_text") or ""),
                str(drug.get("raw_drug_part") or ""),
                str(drug.get("ham_luong") or ""),
            ]))
            has_own_volume_strength = bool(re.search(
                r'\b\d+(?:[\.,]\d+)?\s*(?:MG|G)\s*/\s*\d+(?:[\.,]\d+)?\s*ML\b',
                raw_blob,
                flags=re.IGNORECASE,
            ))
            container_blob = f"{dang_u} {raw_blob}"
            is_bag_or_bottle = any(k in container_blob for k in ["CHAI", "TÚI", "TUI", "BOTTLE", "BAG"])
            return vol >= 50 and is_bag_or_bottle and has_own_volume_strength

        if _ready_to_infuse_product():
            return False

        # Paracetamol/THERMODOL: không tự suy luận pha NaCl.
        # Hai thuốc này thường là chai/túi truyền sẵn; chỉ gắn dung môi khi y lệnh ghi rõ NaCl/Natri/Sodium ở trên.
        if any(k in name_u for k in ["THERMODOL", "PARACETAMOL"]):
            return False

        # Tiêm bắp / dưới da: không cần pha NaCl dù là ALWAYS_INFUSION_DRUGS
        is_injection_only = any(k in route_l for k in ["tiêm bắp", "bắp", "dưới da", "im ", "sc "])
        if is_injection_only:
            return False

        if any(k in name_u for k in ALWAYS_INFUSION_DRUGS):
            return True

        if _contains_any(name_u, list(DEFAULT_NACL_VOLUME_BY_KEYWORD.keys())):
            return True
        # luật an toàn: nếu có yêu cầu pha NaCl (ví dụ NEFOPAM/TRAMADOL) thì coi là cần gắn dung môi
        if get_safety_nacl_volume(name_u) is not None:
            return True


        is_powder_vial = ("LỌ" in dang_u) or ("LO" in dang_u) or ("BỘT" in dang_u) or ("BOT" in dang_u)

        # Gợi ý truyền thật sự: không coi riêng "tĩnh mạch chậm" là dịch truyền NaCl.
        has_infusion_hint = (
            ("tiêm truyền" in route_l) or ("truyền" in route_l) or
            ("ttm" in route_l) or ("g/p" in route_l) or ("giọt/phút" in route_l) or
            ("ml/h" in route_l) or ("ml/giờ" in route_l)
        )

        if is_powder_vial and has_infusion_hint:
            return True

        return False

    def enrich_with_diluent(drug):
        route_l = (drug.get("duong_dung_goc") or "").lower()

        # nếu text đã ghi rõ natri/sodium/nacl/nước muối... thì không set suy_luan_dung_moi
        explicit = any(k in route_l for k in [
            "natri clorid", "natri chlorid", "natri chloride",
            "sodium clorid", "sodium chlorid", "sodium chloride",
            "nacl", "nước muối", "nuoc muoi"
        ]) or bool(drug.get("dung_moi"))

        bag, dm, explicit_from_choose = choose_bag_volume_and_type(drug)

        if not (explicit or explicit_from_choose):
            drug["suy_luan_dung_moi"] = True
        else:
            drug.pop("suy_luan_dung_moi", None)

        drug["dung_moi"] = dm
        drug["duong_dung"] = "TTM"

        # Giữ lại túi/chai pha nếu đã có 'tui_dich_truyen_ml' trên chính thuốc (ví dụ: pha với 500ml),
        # và dùng 'bag' làm thể tích truyền thực tế (ví dụ: lấy 375ml).
        def _to_float_local(x):
            try:
                return float(str(x).replace(',', '.'))
            except Exception as exc:
                LOG.debug("Handled xu_ly fallback exception", exc_info=True)
                return None

        orig_tui = _to_float_local(drug.get("tui_dich_truyen_ml"))
        orig_take = _to_float_local(drug.get("the_tich_lay_ml") or drug.get("the_tich_pha_du_ml"))

        if orig_tui and orig_take and orig_tui >= orig_take:
            drug["tui_dich_truyen_ml"] = float(orig_tui)
        else:
            drug["tui_dich_truyen_ml"] = float(bag)

        # thể tích vận hành: thuốc pha truyền => dùng thể tích THỰC TẾ (bag) để tính thời gian truyền
        drug["the_tich"] = float(bag)

        # Nếu có cả túi pha và thể tích lấy, tính liều thực tế (ví dụ 2g * 375/500 = 1.5g)
        try:
            if orig_tui and orig_take and orig_tui > 0 and orig_take > 0:
                ham = (drug.get("ham_luong") or "")
                so_luong = drug.get("so_luong") or ""
                m_g = re.search(r'(\d+(?:[\.,]\d+)?)\s*g\b', ham.lower())
                m_mg = re.search(r'(\d+(?:[\.,]\d+)?)\s*mg\b', ham.lower())
                ham_g = None
                if m_g:
                    ham_g = _to_float_local(m_g.group(1))
                elif m_mg:
                    ham_mg = _to_float_local(m_mg.group(1))
                    ham_g = (ham_mg / 1000.0) if ham_mg is not None else None

                m_qty = re.search(r'(\d+(?:[\.,]\d+)?)', str(so_luong))
                qty = _to_float_local(m_qty.group(1)) if m_qty else None

                if ham_g is not None and qty is not None:
                    total_g = ham_g * qty
                    frac = float(orig_take) / float(orig_tui)
                    lieu_thuc_te = total_g * frac
                    drug["lieu_pha_g"] = round(total_g, 3)
                    drug["ty_le_lay"] = round(frac, 4)
                    drug["lieu_thuc_te_g"] = round(lieu_thuc_te, 3)
        except Exception as exc:
            LOG.debug("Handled xu_ly fallback exception", exc_info=True)
            pass

        # ten_hien_thi: bỏ ml
        dil_disp = "Sodium chloride 0.9%" if dm == "SODIUM_0.9" else "Natri clorid 0.9%"
        drug["ten_hien_thi"] = f"{drug.get('ten_thuoc','')} + {dil_disp}"
        return drug

    # -----------------------------
    # 2) Enrich + reclassify
    # -----------------------------
    enriched_dich_truyen = []

    # 2.1) Dịch truyền: enrich thuốc cần pha truyền, bỏ các túi/chai NaCl khỏi output
    for dt in raw_dich_truyen:
        if _is_flush_only_diluent(dt):
            LOG.info("Bỏ NaCl thông/tráng đường truyền khỏi dịch truyền: %s", dt.get("ten_thuoc", ""))
            continue
        name_u = _norm_upper(dt.get("ten_thuoc", ""))
        route_u = _norm_upper(dt.get("duong_dung_goc", ""))

        # Bỏ NƯỚC CẤT hoàn toàn — chỉ là dung môi pha thuốc tiêm, không phải dịch truyền
        if "NƯỚC CẤT" in name_u or "NUOC CAT" in name_u:
            continue

        # bỏ túi/chai NaCl (dung môi) khỏi output
        if _dil_kind(name_u, route_u):
            route_l = (dt.get("duong_dung_goc") or "").lower()
            solvent_hint = (
            ("pha" in route_l)
            or ("dùng để pha" in route_l)
            or ("dung de pha" in route_l)
            or ("lấy" in route_l)
            or ("lay" in route_l)
        )

            try:
                _vol_out = float(dt.get("the_tich") or 0)
            except Exception as exc:
                LOG.debug("Handled xu_ly fallback exception", exc_info=True)
                _vol_out = 0.0
            toc_do_txt = str(dt.get("toc_do", "") or "").strip()

            # NaCl 100ml không tốc độ thường là túi pha thuốc -> bỏ khỏi output
            likely_solvent_nacl = (_vol_out <= 100 or _vol_out == 0) and not toc_do_txt

            if solvent_hint or likely_solvent_nacl:
                continue

            # NaCl/Sodium là chai truyền độc lập (500ml, có đường dùng truyền TM)
            # -> giữ lại và đặt ten_hien_thi = ten_thuoc nếu chưa có
            if not dt.get("ten_hien_thi"):
                dt["ten_hien_thi"] = dt.get("ten_thuoc", "")
            enriched_dich_truyen.append(dt)
            continue

        if is_candidate_need_nacl(dt):
            dt = enrich_with_diluent(dt)

        enriched_dich_truyen.append(dt)

    # 2.2) Thuốc tiêm: enrich + chuyển sang truyền nếu phù hợp
    kept_tiem = []
    moved_to_truyen = []
    for inj in raw_thuoc_tiem:
        if _prefer_tramadol_intramuscular(inj):
            # EMR thường ghi chung "Tiêm" cho Tramadol. Khi không có NaCl rời phù hợp,
            # ưu tiên hiểu là tiêm bắp theo thực hành khoa.
            inj["duong_dung"] = "TB"
            inj["tramadol_route_rule"] = "prefer_intramuscular_without_free_nacl"
            kept_tiem.append(inj)
        elif is_candidate_need_nacl(inj):
            inj = enrich_with_diluent(inj)
            moved_to_truyen.append(inj)
        else:
            kept_tiem.append(inj)

    if moved_to_truyen:
        enriched_dich_truyen.extend(moved_to_truyen)

    return enriched_dich_truyen, kept_tiem
