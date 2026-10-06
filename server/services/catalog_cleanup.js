'use strict';
// Dọn Danh mục thuốc: các mục "X + Natri clorid 0.9%" (… Sodium chloride, Glucose, Nước cất) do bước
// tự đồng bộ CŨ sinh ra từ tên hiển thị của thuốc pha truyền. Mỗi mục được gộp về thuốc gốc X:
//   - X đã có trong danh mục → thêm tên X (nếu khác) vào "tên khác"; thể tích/tốc độ khác quy tắc pha
//     hiện có thì giữ lại thành "cách pha gợi ý" (dilution_suggestions) để người dùng duyệt, KHÔNG
//     tự áp dụng; rồi xoá mục rác.
//   - X chưa có → đổi mục thành thuốc X, thể tích/tốc độ cũ thành quy tắc pha "chỉ khi y lệnh ghi
//     truyền" (thể tích cũ là thể tích PHA, không phải thể tích chai thuốc).
// Thuần dữ liệu (không đọc/ghi file) để test được; route lo sao lưu + ghi file.

const SOLVENT_SUFFIX = /^(.*?\S)\s*\+\s*(natri\s*cl?orid[e]?|natri\s*chlorid[e]?|sodium\s*chlorid[e]?|nacl|glucose|dextrose|n[uư][oớ]c\s*c[aấ]t)\b.*$/i;

function solventCodeOf(text) {
  const t = String(text || '').toLowerCase();
  if (/glucose|dextrose/.test(t)) return 'GLUCOSE_5';
  if (/n[uư][oớ]c\s*c[aấ]t/.test(t)) return 'NUOC_CAT';
  return 'NACL_0.9';
}

function normKey(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'D')
    .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

// "VANCOMYCIN 500mg" → "VANCOMYCIN": bỏ hàm lượng/thể tích để tìm thuốc gốc khi tên đầy đủ không có.
function stripStrength(name) {
  return String(name || '').replace(/\s+\d+(?:[.,]\d+)?\s*(?:mg|mcg|g|gm|ml|ui|iu|%)\b.*$/i, '').trim();
}

function num(v) {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function namesOf(med) {
  return [med?.canonical, ...(Array.isArray(med?.aliases) ? med.aliases : [])].map(normKey).filter(Boolean);
}

function findBase(meds, baseName, skip) {
  const tries = [baseName, stripStrength(baseName)].map(normKey).filter(Boolean);
  for (const key of tries) {
    const hit = meds.find(m => m !== skip && !SOLVENT_SUFFIX.test(String(m?.canonical || '')) && namesOf(m).includes(key));
    if (hit) return hit;
  }
  return null;
}

// Kế hoạch dọn (xem trước): [{ key, base, action: 'merge'|'rename', target, alias, suggestion, note }]
function planCleanup(medications) {
  const meds = Array.isArray(medications) ? medications : [];
  const plan = [];
  for (const med of meds) {
    const m = SOLVENT_SUFFIX.exec(String(med?.canonical || '').trim());
    if (!m) continue;
    const baseName = m[1].trim();
    const solvent = solventCodeOf(m[2]);
    const vol = num(med.default_volume_ml);
    const rate = num(med.default_rate);
    const target = findBase(meds, baseName, med);
    if (target) {
      const ruleVol = num(target?.dilution?.volume_ml);
      const sameAsRule = target?.dilution?.solvent === solvent && ruleVol != null && ruleVol === vol;
      const suggestion = vol != null && !sameAsRule ? { solvent, volume_ml: vol, ...(rate ? { rate } : {}), tu: med.canonical } : null;
      const alias = namesOf(target).includes(normKey(baseName)) ? '' : baseName;
      plan.push({
        key: med.canonical, base: baseName, action: 'merge', target: target.canonical, alias, suggestion,
        note: `Gộp vào "${target.canonical}"${alias ? `, thêm tên khác "${alias}"` : ''}`
          + (suggestion ? `; giữ ${vol} ml${rate ? `, ${rate} giọt/phút` : ''} thành cách pha gợi ý để duyệt` : '') + '.',
      });
    } else {
      plan.push({
        key: med.canonical, base: baseName, action: 'rename', target: baseName, alias: '',
        suggestion: null,
        dilution: { solvent, ...(vol ? { volume_ml: vol } : {}), apply: 'infusion_only', ...(rate ? { rate } : {}) },
        note: `Đổi thành thuốc "${baseName}", quy tắc pha: ${vol ? `${vol} ml` : 'chưa rõ thể tích'}${rate ? `, ${rate} giọt/phút` : ''} khi y lệnh ghi truyền.`,
      });
    }
  }
  return plan;
}

// Áp kế hoạch (chỉ các key được chọn). Trả về { medications, applied }.
function applyCleanup(medications, plan, keys) {
  const chosen = new Set(Array.isArray(keys) ? keys : plan.map(p => p.key));
  let meds = (Array.isArray(medications) ? medications : []).map(m => ({ ...m }));
  const applied = [];
  for (const step of plan) {
    if (!chosen.has(step.key)) continue;
    const idx = meds.findIndex(m => m.canonical === step.key);
    if (idx === -1) continue;
    if (step.action === 'merge') {
      const t = meds.findIndex(m => m.canonical === step.target);
      if (t === -1) continue;
      const target = { ...meds[t] };
      if (step.alias) target.aliases = [...(target.aliases || []), step.alias];
      if (step.suggestion) {
        const list = Array.isArray(target.dilution_suggestions) ? [...target.dilution_suggestions] : [];
        if (!list.some(s => s.solvent === step.suggestion.solvent && s.volume_ml === step.suggestion.volume_ml)) list.push(step.suggestion);
        target.dilution_suggestions = list;
      }
      target.sua_tay = true;
      meds[t] = target;
      meds = meds.filter((_, i) => i !== idx);
    } else {
      const clash = meds.some((m, i) => i !== idx && normKey(m.canonical) === normKey(step.target));
      if (clash) continue;
      const med = { ...meds[idx], canonical: step.target, dilution: step.dilution, sua_tay: true };
      delete med.default_volume_ml;
      delete med.default_rate;
      meds[idx] = med;
    }
    applied.push(step.key);
  }
  return { medications: meds, applied };
}

module.exports = { planCleanup, applyCleanup, SOLVENT_SUFFIX, stripStrength };
