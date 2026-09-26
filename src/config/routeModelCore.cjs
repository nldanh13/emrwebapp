'use strict';

// LÕI XỬ LÝ ĐƯỜNG DÙNG — một bản duy nhất cho mọi phần JavaScript:
//   - giao diện: src/config/routes.js
//   - máy chủ Node: server/utils/routeModel.js
// Dữ liệu (mã, từ khoá, chuyên mục…) nằm ở config/routes.json; worker Python có
// bản tương ứng worker/processing/route_table.py, test kiểm hai bên cho kết quả như nhau.

function stripDiacritics(value) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

// Từ khoá người dùng tự thêm ("tiêm khớp") → luật regex so với chữ đã bỏ dấu, viết thường.
function keywordPattern(keyword) {
  const folded = stripDiacritics(keyword).toLowerCase().replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!folded) return '';
  const escaped = folded.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/ /g, '\\s*');
  return `(?<![a-z0-9])${escaped}(?![a-z0-9])`;
}

const ROUTE_DEFAULTS = { category: 'khac', report: 'dose', tone: 'gray' };

// Gộp bảng chuẩn (config/routes.json) với phần người dùng tự cài (config/routes.custom.json):
// - sửa tên/nhãn/chuyên mục/cách hiện của đường dùng có sẵn, hoặc thêm đường dùng mới;
// - từ khoá tự thêm được xét TRƯỚC luật chuẩn (người dùng ghi rõ thì ưu tiên).
function mergeRouteTable(base, custom) {
  const routes = base.routes.map(r => ({ ...r, builtin: true }));
  const userRules = [];
  for (const item of (custom && Array.isArray(custom.routes) ? custom.routes : [])) {
    const code = String(item.code || '').trim().toUpperCase();
    if (!code) continue;
    const patch = {};
    for (const key of ['label', 'short', 'category', 'report', 'tone', 'research_value']) {
      if (item[key] != null && String(item[key]).trim() !== '') patch[key] = String(item[key]).trim();
    }
    const idx = routes.findIndex(r => r.code === code);
    if (idx >= 0) {
      routes[idx] = { ...routes[idx], ...patch, customized: Object.keys(patch).length > 0 };
    } else {
      const label = patch.label || code;
      routes.splice(Math.max(routes.length - 1, 0), 0, {
        ...ROUTE_DEFAULTS,
        short: code,
        research_value: stripDiacritics(label).toLowerCase().replace(/\s+/g, '_'),
        ...patch,
        label,
        code,
        builtin: false,
      });
    }
    const patterns = (Array.isArray(item.keywords) ? item.keywords : []).map(keywordPattern).filter(Boolean);
    if (patterns.length) userRules.push({ route: code, patterns, user: true });
  }
  return { ...base, routes, rules: [...userRules, ...base.rules], custom: custom || { routes: [] } };
}

function createRouteModel(table) {
  const BY_CODE = new Map(table.routes.map(r => [r.code, r]));
  const BY_SHORT = new Map(table.routes.map(r => [String(r.short).toUpperCase(), r]));
  const CATEGORY_BY_CODE = new Map((table.categories || []).map(c => [c.code, c]));
  const COMPILED = table.rules.map(rule => ({
    route: rule.route,
    weak: Boolean(rule.weak),
    patterns: (rule.patterns || []).map(p => new RegExp(p)),
    raw: (rule.raw_patterns || []).map(p => new RegExp(p)),
  }));

  function prepare(text) {
    const raw = stripDiacritics(text);
    const compact = ` ${raw.toLowerCase().replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
    return { raw, compact };
  }
  const matches = (rule, p) => rule.patterns.some(re => re.test(p.compact)) || rule.raw.some(re => re.test(p.raw));

  // Mã chuẩn từ một nhãn có sẵn (mã mới, nhãn ngắn, hoặc nhãn cũ như "U", "IV", "Hít/Xịt").
  function normalizeRouteCode(value) {
    const key = String(value || '').trim().toUpperCase();
    if (!key) return '';
    if (BY_CODE.has(key)) return key;
    if (BY_SHORT.has(key)) return BY_SHORT.get(key).code;
    return table.legacy_aliases[key] || '';
  }

  // Nhận diện đường dùng từ chữ tự do (luật đầu tiên khớp). '' nếu không nhận ra.
  function detectRouteCode(text) {
    const p = prepare(text);
    const hit = COMPILED.find(rule => matches(rule, p));
    return hit ? hit.route : '';
  }

  // Mọi mã mà chữ có nhắc tới; strongOnly bỏ qua luật chung chung (TM, IV, "tiêm").
  function mentionedRoutes(text, { strongOnly = false } = {}) {
    const p = prepare(text);
    const found = [];
    for (const rule of COMPILED) {
      if (found.includes(rule.route) || (strongOnly && rule.weak)) continue;
      if (matches(rule, p)) found.push(rule.route);
    }
    return found;
  }

  const routeInfo = codeOrLabel => BY_CODE.get(normalizeRouteCode(codeOrLabel)) || BY_CODE.get('KHAC');
  const routeShort = codeOrLabel => {
    const code = normalizeRouteCode(codeOrLabel);
    return code ? BY_CODE.get(code).short : String(codeOrLabel || '');
  };
  // 'dose' = làm theo cữ, 'daily' = phát cả ngày, 'hide' = không cần trên báo cáo ca trực.
  const routeReportMode = codeOrLabel => routeInfo(codeOrLabel).report;
  const routeCategory = codeOrLabel => routeInfo(codeOrLabel).category;
  const categoryLabel = category => CATEGORY_BY_CODE.get(category)?.label || String(category || '');
  const categoryDefaultRoute = category => CATEGORY_BY_CODE.get(category)?.default_route || '';
  // Mã của một dòng thuốc: ưu tiên mã worker đã gắn, rồi nhận diện từ chữ gốc.
  const routeCodeOfItem = (item = {}) => normalizeRouteCode(item.duong_dung)
    || detectRouteCode(`${item.duong_dung || ''} ${item.duong_dung_goc || ''}`);

  return {
    ROUTE_TABLE: table,
    ROUTES: table.routes,
    CATEGORIES: table.categories || [],
    normalizeRouteCode,
    detectRouteCode,
    mentionedRoutes,
    routeInfo,
    routeShort,
    routeReportMode,
    routeCategory,
    categoryLabel,
    categoryDefaultRoute,
    routeCodeOfItem,
  };
}

module.exports = { createRouteModel, mergeRouteTable, keywordPattern };
