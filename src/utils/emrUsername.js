// src/utils/emrUsername.js — Gợi ý tên đăng nhập EMR theo quy ước của viện: chữ đầu của họ + tên đệm,
// cộng nguyên tên, không dấu, chữ thường (Hoàng Minh Tú → hmtu). Cùng quy tắc với máy chủ
// (server/utils/nurse_emr_accounts.js → emrUsernameFromName).

export function suggestEmrUsername(name) {
  const words = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  return words.slice(0, -1).map(w => w[0]).join('') + words[words.length - 1];
}

/** Gợi ý cho nhiều người, không trùng tài khoản đã có hay trùng nhau (trùng thì thêm số: hmtu2). */
export function uniqueEmrUsernames(names, taken = []) {
  const used = new Set((taken || []).map(u => String(u || '').toLowerCase()).filter(Boolean));
  return (names || []).map(name => {
    const base = suggestEmrUsername(name);
    if (!base) return '';
    let candidate = base;
    for (let i = 2; used.has(candidate); i += 1) candidate = `${base}${i}`;
    used.add(candidate);
    return candidate;
  });
}
