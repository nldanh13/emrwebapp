// Design tokens cho EMR Data Hub — clinical product UI: compact, quiet, data-first.
// Nguồn chuẩn: DESIGN.md. Biến CSS --emr-* trong src/styles/app.css phải khớp các giá trị này.
// Mọi màu chữ đạt WCAG AA (≥4,5:1) trên surface/bg/nền trạng thái.
export const FONT_UI = '"Aptos", "Segoe UI Variable", "Segoe UI", sans-serif';
export const FONT_MONO = '"Cascadia Mono", "SFMono-Regular", Consolas, monospace';

export const R = {
  xs: 4,
  sm: 5,
  md: 7,
  lg: 10,
};

// Thang chữ cố định (px), tỉ lệ ~1.13. Không dùng chữ nhỏ hơn FS.xs cho nội dung cần đọc.
export const FS = {
  xs: 11.5,   // chú thích, nhãn phụ
  sm: 12,     // nhãn, nút
  md: 13,     // nội dung
  lg: 14.5,   // tiêu đề mục
  xl: 16.5,   // tiêu đề màn hình
};

// Khoảng cách theo bội số 4px.
export const SP = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 24 };

export const C = {
  bg:       '#f4f7fb',
  app:      '#ffffff',
  surface:  '#ffffff',
  surface2: '#f7f9fc',
  surface3: '#edf4ff',
  muted:    '#eef3f8',
  border:   '#d7e0ec',
  border2:  '#e7ecf3',
  text:     '#172033',
  text2:    '#46546c',
  text3:    '#5f6d86',

  green:    '#07755a', greenBg: '#edf9f4', greenBorder: '#b6e6d4',
  amber:    '#a35a00', amberBg: '#fff8eb', amberBorder: '#f4d7a5',
  red:      '#c93232', redBg:   '#fff1f1', redBorder:   '#f3c1c1',
  blue:     '#2463d4', blueBg:  '#eef4ff', blueBorder:  '#c5d6f8',
  orange:   '#c2410c', orangeBg:'#fff2ea', orangeBorder:'#f6c9a8',
  purple:   '#7157b7', purpleBg:'#f4f1fb', purpleBorder:'#d9cff0',
  cyan:     '#127486', cyanBg:  '#eef9fb', cyanBorder:  '#bde2e8',

  shadow:   '0 1px 2px rgba(25,45,75,0.035)',
  shadow2:  '0 10px 30px rgba(25,45,75,0.10)',
};

export const STATUS = {
  red:   { border: C.redBorder,   bg: C.redBg,   text: C.red,   label: 'Ưu tiên'    },
  amber: { border: C.amberBorder, bg: C.amberBg, text: C.amber, label: 'Cần xem'    },
  green: { border: C.greenBorder, bg: C.greenBg, text: C.green, label: 'Ổn'         },
  gray:  { border: C.border,      bg: C.surface2,text: C.text2, label: 'Chưa xử lý' },
};

export const JOB_STATUS = {
  done:      { bg: C.greenBg,  text: C.green, label: '✓ Xong'       },
  running:   { bg: C.blueBg,   text: C.blue,  label: '⟳ Đang chạy'  },
  waiting:   { bg: C.surface2, text: C.text2, label: '○ Chờ'         },
  error:     { bg: C.redBg,    text: C.red,   label: '✗ Lỗi'        },
  cancelled: { bg: C.surface2, text: C.text3, label: '— Đã huỷ'     },
};

export const CONF = {
  high:   { bg: C.greenBg, text: C.green, label: 'Cao'  },
  medium: { bg: C.amberBg, text: C.amber, label: 'TB'   },
  low:    { bg: C.redBg,   text: C.red,   label: 'Thấp' },
};

export const TL_TYPE = {
  care:    { color: C.blue,   label: 'CS'  },
  order:   { color: C.purple, label: 'U'   },
  infus:   { color: C.green,  label: 'DT'  },
  tiem:    { color: C.amber,  label: 'TM'  },
  tra:     { color: C.text3,  label: '↩'   },
  reserve: { color: C.blue,   label: 'YL'  },
  add:     { color: C.green,  label: '+T'  },
  stop:    { color: C.red,    label: 'NG'  },
  doctor:  { color: C.amber,  label: 'BS'  },
  rehab:   { color: C.purple, label: 'VL'  },
  dvkt:    { color: C.green,  label: 'CLS' },
  error:   { color: C.red,    label: '!!'  },
};

export const FLAG = {
  care_missing:   { text: 'Thiếu CS',  bg: C.amberBg, color: C.amber },
  infus_mismatch: { text: 'Lệch DT',   bg: C.redBg,   color: C.red   },
  prev_error:     { text: 'Lỗi trước', bg: C.redBg,   color: C.red   },
  hour_gap:       { text: 'Thiếu giờ', bg: C.amberBg, color: C.amber },
  new_order:      { text: 'YL mới',    bg: C.blueBg,  color: C.blue  },
};

export const mono = { fontFamily: FONT_MONO, fontSize: 11 };
