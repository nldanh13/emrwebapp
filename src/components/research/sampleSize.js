// Tính cỡ mẫu tối thiểu cho các thiết kế thường gặp trong nghiên cứu lâm sàng.
// Công thức theo các tài liệu phương pháp nghiên cứu chuẩn (Lwanga & Lemeshow 1991,
// Fleiss 2003, Hulley — Designing Clinical Research). Kết quả làm tròn lên, đã cộng hao hụt.

// Phân vị chuẩn tắc (thuật toán Acklam, sai số < 1.2e-9).
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) return NaN;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export const SAMPLE_SIZE_DESIGNS = [
  {
    key: 'prop_one', label: 'Ước lượng một tỉ lệ', group: 'Mô tả',
    example: 'Tỉ lệ phản ứng pha cấp sau truyền Zoledronic Acid',
    fields: ['p', 'd'],
  },
  {
    key: 'mean_one', label: 'Ước lượng một trung bình', group: 'Mô tả',
    example: 'Nồng độ Vitamin D trung bình ở người bệnh loãng xương',
    fields: ['sd', 'd_abs'],
  },
  {
    key: 'two_props', label: 'So sánh hai tỉ lệ (hai nhóm)', group: 'So sánh / yếu tố nguy cơ',
    example: 'Tỉ lệ phản ứng pha cấp ở nhóm thiếu và không thiếu Vitamin D',
    fields: ['p1', 'p2', 'ratio', 'power'],
  },
  {
    key: 'two_means', label: 'So sánh hai trung bình (hai nhóm)', group: 'So sánh / yếu tố nguy cơ',
    example: 'CRP sau truyền ở nhóm có và không có phản ứng',
    fields: ['sd', 'delta', 'ratio', 'power'],
  },
  {
    key: 'paired_means', label: 'So sánh trước – sau (cặp)', group: 'So sánh / yếu tố nguy cơ',
    example: 'Canxi máu trước và sau truyền trên cùng người bệnh',
    fields: ['sd_diff', 'delta', 'power'],
  },
  {
    key: 'correlation', label: 'Tương quan giữa hai biến số', group: 'So sánh / yếu tố nguy cơ',
    example: 'Tương quan giữa Vitamin D và mức tăng CRP',
    fields: ['r', 'power'],
  },
];

export const SAMPLE_SIZE_FIELDS = {
  p: { label: 'Tỉ lệ dự kiến p', hint: 'Từ y văn hoặc nghiên cứu trước; chưa biết thì dùng 0,5 (cho cỡ mẫu lớn nhất).', step: 0.01, min: 0.001, max: 0.999 },
  d: { label: 'Sai số tuyệt đối d', hint: 'Độ chính xác mong muốn, vd. 0,05 (±5%).', step: 0.01, min: 0.001, max: 0.5 },
  sd: { label: 'Độ lệch chuẩn σ', hint: 'Từ y văn, nghiên cứu thử, hoặc lấy từ kho.', step: 0.1, min: 0.0001 },
  d_abs: { label: 'Sai số tuyệt đối (cùng đơn vị)', hint: 'Vd. ±2 ng/mL.', step: 0.1, min: 0.0001 },
  p1: { label: 'Tỉ lệ nhóm 1 (p₁)', hint: 'Nhóm phơi nhiễm / can thiệp.', step: 0.01, min: 0.001, max: 0.999 },
  p2: { label: 'Tỉ lệ nhóm 2 (p₂)', hint: 'Nhóm chứng / không phơi nhiễm.', step: 0.01, min: 0.001, max: 0.999 },
  delta: { label: 'Khác biệt cần phát hiện Δ', hint: 'Chênh lệch nhỏ nhất có ý nghĩa lâm sàng.', step: 0.1, min: 0.0001 },
  sd_diff: { label: 'Độ lệch chuẩn của hiệu số σ_d', hint: 'SD của (sau − trước); chưa biết thì dùng SD của biến.', step: 0.1, min: 0.0001 },
  r: { label: 'Hệ số tương quan dự kiến r', hint: 'Vd. 0,3 (tương quan vừa).', step: 0.05, min: 0.01, max: 0.99 },
  ratio: { label: 'Tỉ lệ cỡ mẫu nhóm 2 : nhóm 1 (k)', hint: '1 = hai nhóm bằng nhau.', step: 0.5, min: 0.1, max: 10 },
  power: { label: 'Lực mẫu (1 − β)', hint: 'Thường 0,8 hoặc 0,9.', step: 0.05, min: 0.5, max: 0.99 },
};

export const SAMPLE_SIZE_DEFAULTS = { alpha: 0.05, power: 0.8, ratio: 1, dropout: 10, p: 0.5, d: 0.05 };

const num = (v) => {
  if (v === '' || v === null || v === undefined) return NaN;
  return Number(String(v).replace(',', '.'));
};

// Trả { n, groups?: [n1, n2], raw, formula } hoặc { error }.
export function computeSampleSize(params = {}) {
  const design = params.design;
  const alpha = num(params.alpha ?? SAMPLE_SIZE_DEFAULTS.alpha);
  const power = num(params.power ?? SAMPLE_SIZE_DEFAULTS.power);
  const dropout = num(params.dropout ?? SAMPLE_SIZE_DEFAULTS.dropout);
  if (!(alpha > 0 && alpha < 0.5)) return { error: 'α phải trong khoảng 0–0,5.' };
  const za = normalQuantile(1 - alpha / 2);
  const zb = normalQuantile(power);
  const needsPower = ['two_props', 'two_means', 'paired_means', 'correlation'].includes(design);
  if (needsPower && !(power > 0.5 && power < 1)) return { error: 'Lực mẫu phải trong khoảng 0,5–0,99.' };
  if (!(dropout >= 0 && dropout < 90)) return { error: 'Tỉ lệ hao hụt phải trong khoảng 0–90%.' };
  const inflate = (n) => Math.ceil(n / (1 - dropout / 100) - 1e-9);
  const k = num(params.ratio ?? 1);
  let raw;
  let groups = null;
  let formula = '';
  if (design === 'prop_one') {
    const p = num(params.p); const d = num(params.d);
    if (!(p > 0 && p < 1)) return { error: 'Nhập tỉ lệ dự kiến p (0–1).' };
    if (!(d > 0 && d < 1)) return { error: 'Nhập sai số d (0–1).' };
    raw = (za ** 2 * p * (1 - p)) / d ** 2;
    formula = 'n = Z²₁₋α/₂ · p(1 − p) / d²';
  } else if (design === 'mean_one') {
    const sd = num(params.sd); const d = num(params.d_abs);
    if (!(sd > 0)) return { error: 'Nhập độ lệch chuẩn σ.' };
    if (!(d > 0)) return { error: 'Nhập sai số tuyệt đối.' };
    raw = (za ** 2 * sd ** 2) / d ** 2;
    formula = 'n = Z²₁₋α/₂ · σ² / d²';
  } else if (design === 'two_props') {
    const p1 = num(params.p1); const p2 = num(params.p2);
    if (!(p1 > 0 && p1 < 1 && p2 > 0 && p2 < 1)) return { error: 'Nhập tỉ lệ hai nhóm (0–1).' };
    if (p1 === p2) return { error: 'Hai tỉ lệ phải khác nhau.' };
    if (!(k > 0)) return { error: 'Tỉ lệ k phải > 0.' };
    const pBar = (p1 + k * p2) / (1 + k);
    const n1 = (za * Math.sqrt((1 + 1 / k) * pBar * (1 - pBar)) + zb * Math.sqrt(p1 * (1 - p1) + (p2 * (1 - p2)) / k)) ** 2 / (p1 - p2) ** 2;
    groups = [n1, k * n1];
    formula = 'n₁ = [Z₁₋α/₂√((1+1/k)p̄(1−p̄)) + Z₁₋β√(p₁(1−p₁) + p₂(1−p₂)/k)]² / (p₁ − p₂)²';
  } else if (design === 'two_means') {
    const sd = num(params.sd); const delta = num(params.delta);
    if (!(sd > 0)) return { error: 'Nhập độ lệch chuẩn σ.' };
    if (!(delta > 0)) return { error: 'Nhập khác biệt cần phát hiện Δ.' };
    if (!(k > 0)) return { error: 'Tỉ lệ k phải > 0.' };
    const n1 = ((1 + 1 / k) * sd ** 2 * (za + zb) ** 2) / delta ** 2;
    groups = [n1, k * n1];
    formula = 'n₁ = (1 + 1/k) · σ² · (Z₁₋α/₂ + Z₁₋β)² / Δ²';
  } else if (design === 'paired_means') {
    const sd = num(params.sd_diff); const delta = num(params.delta);
    if (!(sd > 0)) return { error: 'Nhập độ lệch chuẩn của hiệu số.' };
    if (!(delta > 0)) return { error: 'Nhập khác biệt cần phát hiện Δ.' };
    raw = (sd ** 2 * (za + zb) ** 2) / delta ** 2;
    formula = 'n = σ_d² · (Z₁₋α/₂ + Z₁₋β)² / Δ²';
  } else if (design === 'correlation') {
    const r = num(params.r);
    if (!(r > 0 && r < 1)) return { error: 'Nhập hệ số tương quan r (0–1).' };
    raw = ((za + zb) / (0.5 * Math.log((1 + r) / (1 - r)))) ** 2 + 3;
    formula = 'n = [(Z₁₋α/₂ + Z₁₋β) / (½ ln((1 + r)/(1 − r)))]² + 3';
  } else {
    return { error: 'Chọn thiết kế nghiên cứu.' };
  }
  if (groups) {
    const g = groups.map(x => Math.ceil(x - 1e-9));
    const gi = g.map(inflate);
    return { n: gi[0] + gi[1], groups: gi, raw: g[0] + g[1], formula };
  }
  return { n: inflate(raw), raw: Math.ceil(raw - 1e-9), formula };
}
