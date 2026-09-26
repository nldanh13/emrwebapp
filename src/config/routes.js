// Bảng chuẩn đường dùng thuốc — BẢN SAO của config/routes.json (nguồn chính).
// Sửa config/routes.json rồi cập nhật file này; test tests/test_routes_config.py kiểm hai file khớp nhau.

export const ROUTE_TABLE = {
  "routes": [
    {
      "code": "TTM",
      "short": "TTM",
      "label": "Truyền tĩnh mạch",
      "category": "dich_truyen",
      "report": "dose"
    },
    {
      "code": "SE",
      "short": "SE",
      "label": "Truyền qua bơm tiêm điện",
      "category": "dich_truyen",
      "report": "dose"
    },
    {
      "code": "TMC",
      "short": "TMC",
      "label": "Tiêm tĩnh mạch chậm",
      "category": "thuoc_tiem",
      "report": "dose"
    },
    {
      "code": "TB",
      "short": "TB",
      "label": "Tiêm bắp",
      "category": "thuoc_tiem",
      "report": "dose"
    },
    {
      "code": "TDD",
      "short": "TDD",
      "label": "Tiêm dưới da",
      "category": "thuoc_tiem",
      "report": "dose"
    },
    {
      "code": "TTD",
      "short": "TTD",
      "label": "Tiêm trong da",
      "category": "thuoc_tiem",
      "report": "dose"
    },
    {
      "code": "UONG",
      "short": "Uống",
      "label": "Uống",
      "category": "thuoc_uong",
      "report": "daily"
    },
    {
      "code": "NDL",
      "short": "NDL",
      "label": "Ngậm dưới lưỡi",
      "category": "thuoc_uong",
      "report": "daily"
    },
    {
      "code": "KHI_DUNG",
      "short": "Khí dung",
      "label": "Khí dung",
      "category": "thuoc_hit_xit",
      "report": "dose"
    },
    {
      "code": "HIT_XIT",
      "short": "Hít/Xịt",
      "label": "Hít / Xịt",
      "category": "thuoc_hit_xit",
      "report": "hide"
    },
    {
      "code": "NGAM",
      "short": "Ngậm",
      "label": "Ngậm / Súc miệng",
      "category": "thuoc_uong",
      "report": "hide"
    },
    {
      "code": "NHO_MAT",
      "short": "Nhỏ mắt",
      "label": "Nhỏ mắt",
      "category": "thuoc_nho",
      "report": "hide"
    },
    {
      "code": "NHO_MUI",
      "short": "Nhỏ mũi",
      "label": "Nhỏ mũi",
      "category": "thuoc_nho",
      "report": "hide"
    },
    {
      "code": "NHO_TAI",
      "short": "Nhỏ tai",
      "label": "Nhỏ tai",
      "category": "thuoc_nho",
      "report": "hide"
    },
    {
      "code": "BOI",
      "short": "Bôi",
      "label": "Bôi ngoài da",
      "category": "thuoc_boi",
      "report": "hide"
    },
    {
      "code": "DAN",
      "short": "Dán",
      "label": "Dán qua da",
      "category": "thuoc_boi",
      "report": "hide"
    },
    {
      "code": "DAT_HM",
      "short": "Đặt HM",
      "label": "Đặt hậu môn",
      "category": "thuoc_dat",
      "report": "hide"
    },
    {
      "code": "DAT_AD",
      "short": "Đặt AĐ",
      "label": "Đặt âm đạo",
      "category": "thuoc_dat",
      "report": "hide"
    },
    {
      "code": "KHAC",
      "short": "Khác",
      "label": "Khác",
      "category": "khac",
      "report": "dose"
    }
  ],
  "legacy_aliases": {
    "U": "UONG",
    "PO": "UONG",
    "UONG": "UONG",
    "UỐNG": "UONG",
    "IV": "TMC",
    "TM": "TMC",
    "IM": "TB",
    "SC": "TDD",
    "HÍT/XỊT": "HIT_XIT",
    "HIT/XIT": "HIT_XIT",
    "BÔI": "BOI",
    "DÁN": "DAN",
    "NHỎ MẮT": "NHO_MAT",
    "NHỎ MŨI": "NHO_MUI",
    "NHỎ TAI": "NHO_TAI",
    "NHỎ": "NHO_MAT",
    "TRỰC TRÀNG": "DAT_HM",
    "ÂM ĐẠO": "DAT_AD",
    "ĐẶT": "DAT_HM",
    "NGẬM": "NGAM",
    "KHÁC": "KHAC"
  },
  "rules": [
    {
      "route": "UONG",
      "patterns": [
        "\\buong\\b",
        "\\bpo\\b",
        "\\boral\\b"
      ]
    },
    {
      "route": "NDL",
      "patterns": [
        "duoi\\s*luoi"
      ]
    },
    {
      "route": "TDD",
      "patterns": [
        "\\btdd\\b",
        "\\bsc\\b",
        "\\bsubcut",
        "duoi\\s*da"
      ]
    },
    {
      "route": "TTD",
      "patterns": [
        "trong\\s*da",
        "\\bttd\\b"
      ]
    },
    {
      "route": "TB",
      "patterns": [
        "\\btb\\b",
        "\\bim\\b",
        "intramuscular",
        "tiem\\s*bap",
        "\\bbap\\b"
      ]
    },
    {
      "route": "SE",
      "patterns": [
        "bom\\s*tiem\\s*dien",
        "syringe\\s*pump"
      ],
      "raw_patterns": [
        "\\bSE\\b"
      ]
    },
    {
      "route": "TMC",
      "patterns": [
        "\\btmc\\b",
        "tinh\\s*mach\\s*cham",
        "tiem\\s*mach\\s*cham",
        "tiem\\s*tm\\s*cham",
        "tiem\\s*cham"
      ]
    },
    {
      "route": "TTM",
      "patterns": [
        "\\bttm\\b",
        "\\btttm\\b",
        "truyen\\s*tinh\\s*mach",
        "tiem\\s*truyen",
        "truyen",
        "giot\\s*/?\\s*phut",
        "\\bml\\s*/?\\s*h\\b"
      ]
    },
    {
      "route": "TMC",
      "patterns": [
        "\\btm\\b",
        "\\biv\\b",
        "tiem\\s*mach",
        "tinh\\s*mach",
        "\\btiem\\b"
      ]
    },
    {
      "route": "KHI_DUNG",
      "patterns": [
        "khi\\s*dung",
        "phun\\s*mu",
        "nebuli"
      ]
    },
    {
      "route": "HIT_XIT",
      "patterns": [
        "\\bhit\\b",
        "\\bxit\\b",
        "dinh\\s*lieu",
        "aerosol"
      ]
    },
    {
      "route": "NHO_MAT",
      "patterns": [
        "nho\\s*mat"
      ]
    },
    {
      "route": "NHO_MUI",
      "patterns": [
        "nho\\s*mui"
      ]
    },
    {
      "route": "NHO_TAI",
      "patterns": [
        "nho\\s*tai"
      ]
    },
    {
      "route": "BOI",
      "patterns": [
        "\\bboi\\b",
        "\\bthoa\\b"
      ]
    },
    {
      "route": "DAN",
      "patterns": [
        "dan\\s*qua\\s*da",
        "mieng\\s*dan",
        "\\bpatch\\b"
      ]
    },
    {
      "route": "DAT_HM",
      "patterns": [
        "hau\\s*mon",
        "truc\\s*trang"
      ]
    },
    {
      "route": "DAT_AD",
      "patterns": [
        "am\\s*dao"
      ]
    },
    {
      "route": "NGAM",
      "patterns": [
        "\\bngam\\b",
        "suc\\s*mieng"
      ]
    }
  ]
};

const BY_CODE = new Map(ROUTE_TABLE.routes.map(r => [r.code, r]));
const BY_SHORT = new Map(ROUTE_TABLE.routes.map(r => [r.short.toUpperCase(), r]));
const COMPILED = ROUTE_TABLE.rules.map(rule => ({
  route: rule.route,
  patterns: (rule.patterns || []).map(p => new RegExp(p)),
  raw: (rule.raw_patterns || []).map(p => new RegExp(p)),
}));

export const ROUTES = ROUTE_TABLE.routes;

function stripDiacritics(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

// Mã chuẩn từ một nhãn có sẵn (mã mới, nhãn ngắn, hoặc nhãn cũ như "U", "IV", "Hít/Xịt").
export function normalizeRouteCode(value) {
  const key = String(value || '').trim().toUpperCase();
  if (!key) return '';
  if (BY_CODE.has(key)) return key;
  if (BY_SHORT.has(key)) return BY_SHORT.get(key).code;
  return ROUTE_TABLE.legacy_aliases[key] || '';
}

// Nhận diện đường dùng từ chữ tự do trong y lệnh. Trả '' nếu không nhận ra.
export function detectRouteCode(text) {
  const raw = stripDiacritics(text);
  const compact = ` ${raw.toLowerCase().replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ')} `;
  for (const rule of COMPILED) {
    if (rule.patterns.some(re => re.test(compact)) || rule.raw.some(re => re.test(raw))) return rule.route;
  }
  return '';
}

export function routeInfo(codeOrLabel) {
  return BY_CODE.get(normalizeRouteCode(codeOrLabel)) || BY_CODE.get('KHAC');
}

// Nhãn ngắn để hiển thị (TTM, TMC, Uống, Khí dung…).
export function routeShort(codeOrLabel) {
  const code = normalizeRouteCode(codeOrLabel);
  return code ? BY_CODE.get(code).short : String(codeOrLabel || '');
}

// 'dose' = làm theo cữ, 'daily' = phát cả ngày, 'hide' = không cần trên báo cáo ca trực.
export function routeReportMode(codeOrLabel) {
  return routeInfo(codeOrLabel).report;
}

export function routeCategory(codeOrLabel) {
  return routeInfo(codeOrLabel).category;
}
