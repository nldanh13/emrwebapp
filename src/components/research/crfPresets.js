// Mẫu phiếu nhập tay dựng sẵn. Mỗi dòng: "Nhóm | Nhãn | kiểu | lựa chọn (cách nhau ;) | đơn vị | min-max | cờ"
// kiểu: number, text, choice, yesno, date, datetime. Cờ "id" = trường định danh (không ra file phân tích).
// Các biến đã lấy được từ EMR (năm sinh, giới, khoa, chẩn đoán, xét nghiệm, thuốc) không lặp lại ở đây:
// chọn chúng ở bước Chọn biến của Tạo nghiên cứu.

const NRS = 'number |  | điểm | 0-10';
const GRADE = 'choice | 0; 1; 2; 3; 4';

const APR_ZOLEDRONIC = {
  key: 'apr_zoledronic',
  label: 'Phản ứng pha cấp sau truyền Zoledronic Acid 5mg/100ml',
  description: 'Theo bộ công cụ: thông tin nền, quy trình truyền, theo dõi 24/48/72 giờ và ngày 7, kết luận APR.',
  timepoints: [
    { id: 'T24', label: '24 giờ', offset_hours: 24 },
    { id: 'T48', label: '48 giờ', offset_hours: 48 },
    { id: 'T72', label: '72 giờ', offset_hours: 72 },
    { id: 'D7', label: 'Ngày 7', offset_hours: 168 },
  ],
  base: `
Nhân khẩu & lối sống | Số điện thoại liên lạc | text |  |  |  | id
Nhân khẩu & lối sống | Chiều cao | number |  | cm | 50-250
Nhân khẩu & lối sống | Cân nặng | number |  | kg | 20-250
Nhân khẩu & lối sống | BMI | number |  | kg/m2 | 10-60
Nhân khẩu & lối sống | Khoảng cách nhà – bệnh viện | number |  | km | 0-2000
Nhân khẩu & lối sống | Hút thuốc lá | choice | Không; Đang hút/Cai < 6 tháng
Nhân khẩu & lối sống | Uống rượu bia trong 24 giờ qua | yesno
Tình trạng loãng xương | Chẩn đoán xác định | choice | Loãng xương sau mãn kinh/nguyên phát; Loãng xương nặng (có gãy xương)
Tình trạng loãng xương | T-score thấp nhất | number |  | SD | -10-5
Tình trạng loãng xương | Tiền sử gãy xương | yesno
Tình trạng loãng xương | Vị trí gãy xương | text
Tiền sử dùng thuốc | Bisphosphonate đường uống | choice | Chưa từng dùng; Đã dùng nhưng ngưng > 1 năm; Đang dùng đều đặn, nay chuyển sang truyền
Tiền sử dùng thuốc | Tiền sử truyền Zoledronic Acid | choice | Lần đầu tiên trong đời; Đã truyền, ngưng ≥ 3 năm
Bệnh kèm & thuốc đồng sử dụng | Kháng viêm/giảm đau trong 3 ngày trước truyền | yesno
Bệnh kèm & thuốc đồng sử dụng | Tên thuốc kháng viêm/giảm đau | text
Bệnh kèm & thuốc đồng sử dụng | Dùng Statin | yesno
Bệnh kèm & thuốc đồng sử dụng | Đái tháo đường | yesno
Bệnh kèm & thuốc đồng sử dụng | Bệnh dạ dày – tá tràng | yesno
Bệnh kèm & thuốc đồng sử dụng | Bệnh tự miễn (Lupus/RA) | yesno
Triệu chứng nền | Nhiệt độ cơ thể nền | number |  | °C | 34-43
Triệu chứng nền | Đau cột sống thắt lưng (NRS) | ${NRS}
Triệu chứng nền | Đau khớp gối/vai/háng (NRS) | ${NRS}
Triệu chứng nền | Đau mỏi cơ toàn thân (NRS) | ${NRS}
Triệu chứng nền | Mệt mỏi nền (NRS) | ${NRS}
Trước khi truyền | Buổi truyền | choice | Sáng (trước 12h); Chiều (sau 12h)
Trước khi truyền | Tình trạng ăn uống | choice | Đói (> 6h chưa ăn); No (ăn trong vòng 4h)
Trước khi truyền | Mức độ lo lắng (NRS) | ${NRS}
Trước khi truyền | Kỳ vọng tác dụng phụ | choice | Không lo; Lo nhẹ; Tin chắc sẽ bị hành
Trước khi truyền | Môi trường phòng | choice | Máy lạnh; Quạt/Thoáng gió
Trước khi truyền | Nhiệt độ máy lạnh | number |  | °C | 10-40
Trước khi truyền | Cảm giác nhiệt | choice | Lạnh (cần đắp chăn); Bình thường; Nóng
Trước khi truyền | Mạch T0 | number |  | lần/phút | 20-250
Trước khi truyền | HA tâm thu T0 | number |  | mmHg | 50-300
Trước khi truyền | HA tâm trương T0 | number |  | mmHg | 20-200
Trước khi truyền | Nhiệt độ T0 | number |  | °C | 34-43
Kỹ thuật thiết lập | Số lô thuốc (Lot No.) | text
Kỹ thuật thiết lập | Vị trí kim | choice | Tĩnh mạch lớn (khuỷu tay); Tĩnh mạch nhỏ (mu bàn tay)
Kỹ thuật thiết lập | Cỡ kim | choice | 18G; 20G; 22G/24G
Kỹ thuật thiết lập | Số lần chọc kim | number |  | lần | 1-10
Trong khi truyền | Bắt đầu truyền (giọt đầu tiên) | datetime
Trong khi truyền | Kết thúc truyền (giọt cuối cùng) | datetime
Trong khi truyền | Tổng thời gian truyền | number |  | phút | 0-600
Trong khi truyền | Đánh giá tuân thủ tốc độ | choice | Quá nhanh (< 45 phút); Chuẩn (60–75 phút); Chậm (> 90 phút)
Trong khi truyền | Bất thường tại phút 30 | yesno
Trong khi truyền | Ghi rõ bất thường phút 30 | text
Sau khi truyền & dự phòng | Dịch Paracetamol truyền | number |  | ml | 0-2000
Sau khi truyền & dự phòng | Dịch NaCl 0,9% | number |  | ml | 0-5000
Sau khi truyền & dự phòng | Tổng dịch truyền tĩnh mạch | number |  | ml | 0-6000
Sau khi truyền & dự phòng | Nước uống tại viện | choice | Ít (< 200 ml); Trung bình (200–500 ml); Nhiều (> 500 ml)
Sau khi truyền & dự phòng | Mạch sau truyền | number |  | lần/phút | 20-250
Sau khi truyền & dự phòng | HA tâm thu sau truyền | number |  | mmHg | 50-300
Sau khi truyền & dự phòng | HA tâm trương sau truyền | number |  | mmHg | 20-200
Sau khi truyền & dự phòng | Nhiệt độ sau truyền | number |  | °C | 34-43
Sau khi truyền & dự phòng | Phản ứng tại chỗ tiêm | choice | Không; Sưng/Thoát mạch; Viêm tĩnh mạch
Sau khi truyền & dự phòng | Đã đi tiểu trước khi về | yesno
Kết luận của nghiên cứu viên | Chẩn đoán phản ứng pha cấp (APR) | choice | Không (Non-APR); Có (APR)
Kết luận của nghiên cứu viên | Mức độ APR | choice | Độ 1 (nhẹ); Độ 2 (vừa); Độ 3 (nặng)
`,
  repeated: ['T24', 'T48', 'T72'],
  followup: `
Theo dõi | Nhiệt độ max (đo tại nhà) | number |  | °C | 34-43
Theo dõi | Có cơn rét run | yesno
Theo dõi | Dùng thuốc thêm (ngoài liều dự phòng) | choice | Không; Paracetamol; NSAID/Khác
Theo dõi | Đau cơ toàn thân (PRO-CTCAE) | ${GRADE}
Theo dõi | Tính chất đau cơ | choice | Ê ẩm như cảm cúm; Đau lưng cũ
Theo dõi | Đau khớp | ${GRADE}
Theo dõi | Đau đầu | ${GRADE}
Theo dõi | Mệt mỏi (ảnh hưởng chức năng) | ${GRADE}
`,
  day7: `
Đánh giá ngày 7 | Triệu chứng khó chịu nhất xuất hiện | choice | Trong 24 giờ đầu; Ngày thứ 2 hoặc 3
Đánh giá ngày 7 | Đã hoàn toàn bình thường | choice | Rồi; Chưa (vẫn còn mệt/đau)
Đánh giá ngày 7 | Hết triệu chứng vào ngày thứ | number |  | ngày | 1-7
Đánh giá ngày 7 | Số ngày không làm việc được | number |  | ngày | 0-7
Đánh giá ngày 7 | Mức ảnh hưởng sinh hoạt (0–10) | ${NRS}
Đánh giá ngày 7 | Chi phí thêm sau ra viện | choice | Không tốn kém; Mua thêm thuốc uống; Đi khám tư nhân/phòng mạch; Quay lại bệnh viện/cấp cứu
Đánh giá ngày 7 | Chi phí mua thuốc thêm | number |  | VNĐ | 0-100000000
Đánh giá ngày 7 | Nếu biết trước có đồng ý truyền không | choice | Vẫn đồng ý; Sẽ suy nghĩ lại; Chắc chắn không truyền nữa
`,
};

const scoreField = (id, label, section, max = 3) => ({ id, label, section, type: 'number', min: 0, max });
const yesNoField = (id, label, section) => ({ id, label, section, type: 'yesno' });

const ORTHO_PSYCH_SLEEP_PAIN = {
  key: 'ortho_psych_sleep_pain',
  label: 'Lo âu, trầm cảm, giấc ngủ và đau sau phẫu thuật CTCH',
  description: 'Phiếu điện tử theo nghiên cứu CTCH: HADS, PSQI, AIS-5 trước mổ; VAS và tác dụng/ADR giảm đau N1–N3; vận động, biến chứng và hài lòng. Thuốc, ngày mổ và dữ liệu bệnh án lấy từ EMR, không nhập lặp.',
  form: {
    timepoints: [
      { id: 'N1', label: 'Hậu phẫu ngày 1', offset_hours: 24 },
      { id: 'N2', label: 'Hậu phẫu ngày 2', offset_hours: 48 },
      { id: 'N3', label: 'Hậu phẫu ngày 3', offset_hours: 72 },
    ],
    fields: [
      { id: 'weight_kg', label: 'Cân nặng', section: 'Thông tin trước mổ', type: 'number', min: 20, max: 300, unit: 'kg' },
      { id: 'height_cm', label: 'Chiều cao', section: 'Thông tin trước mổ', type: 'number', min: 80, max: 250, unit: 'cm' },
      { id: 'vas_admission', label: 'VAS lúc vào viện', section: 'Đau trước mổ', type: 'number', min: 0, max: 10, unit: 'điểm' },
      ...[1,3,5,7,9,11,13].map(n => scoreField(`hads_a${n}`, `HADS-A câu ${n}`, 'HADS trước mổ')),
      ...[2,4,6,8,10,12,14].map(n => scoreField(`hads_d${n}`, `HADS-D câu ${n}`, 'HADS trước mổ')),
      { id: 'psqi_bed_time', label: 'Giờ thường đi ngủ', section: 'PSQI trước mổ', type: 'text' },
      { id: 'psqi_latency_min', label: 'Thời gian để ngủ được', section: 'PSQI trước mổ', type: 'number', min: 0, max: 600, unit: 'phút' },
      { id: 'psqi_wake_time', label: 'Giờ thường thức dậy', section: 'PSQI trước mổ', type: 'text' },
      { id: 'psqi_sleep_hours', label: 'Số giờ ngủ thực tế mỗi đêm', section: 'PSQI trước mổ', type: 'number', min: 0, max: 24, unit: 'giờ' },
      { id: 'psqi_total', label: 'Tổng điểm PSQI (0–21)', section: 'PSQI trước mổ', type: 'number', min: 0, max: 21, unit: 'điểm' },
      ...[1,2,3,4,5].map(n => scoreField(`ais_${n}`, `AIS-5 câu ${n}`, 'AIS-5 trước mổ')),
      ...[
        ['anxiety_pain', 'Sợ đau'], ['anxiety_complication', 'Sợ biến chứng/tử vong'], ['anxiety_outcome', 'Lo kết quả phẫu thuật'],
        ['anxiety_cost', 'Lo chi phí'], ['anxiety_work', 'Lo mất khả năng lao động'], ['anxiety_family', 'Lo gia đình/xã hội'], ['anxiety_none', 'Không có nguyên nhân lo âu nêu trên'],
      ].map(([id, label]) => yesNoField(id, label, 'Nguyên nhân lo âu')),
      ...[
        ['sleep_pain', 'Đau'], ['sleep_noise', 'Tiếng ồn/môi trường bệnh viện'], ['sleep_anxiety', 'Lo âu'], ['sleep_care', 'Can thiệp chăm sóc/điều trị'], ['sleep_other', 'Nguyên nhân khác'],
      ].map(([id, label]) => yesNoField(id, label, 'Nguyên nhân rối loạn giấc ngủ')),
      { id: 'first_mobilization', label: 'Thời điểm vận động lần đầu', section: 'Hậu phẫu', type: 'choice', options: ['<12 giờ', '12–24 giờ', '24–48 giờ', '>48 giờ', 'Chưa vận động'] },
      { id: 'day1_mobility', label: 'Khả năng vận động ngày 1', section: 'Hậu phẫu', type: 'text' },
      { id: 'postop_complication', label: 'Biến chứng hậu phẫu ghi nhận thêm', section: 'Hậu phẫu', type: 'text' },
      ...['pain_control','nursing_care','information','mobility_support','surgery_outcome'].map((id, i) => ({ id: `satisfaction_${id}`, label: ['Kiểm soát đau','Chăm sóc điều dưỡng','Thông tin được cung cấp','Hỗ trợ vận động','Kết quả phẫu thuật chung'][i], section: 'Hài lòng', type: 'number', min: 1, max: 5, unit: 'điểm' })),
      { id: 'satisfaction_comment', label: 'Ý kiến khác', section: 'Hài lòng', type: 'text' },
      ...['N1','N2','N3'].flatMap(tp => [
        { id: 'vas', label: 'VAS', section: 'Đau hậu phẫu', type: 'number', min: 0, max: 10, unit: 'điểm', timepoint: tp },
        { id: 'analgesic_effect', label: 'Hiệu quả giảm đau', section: 'Đau hậu phẫu', type: 'choice', options: ['Tốt', 'Trung bình', 'Kém'], timepoint: tp },
        { id: 'side_effect_nausea', label: 'Buồn nôn/nôn', section: 'Tác dụng không mong muốn', type: 'yesno', timepoint: tp },
        { id: 'side_effect_dizziness', label: 'Chóng mặt', section: 'Tác dụng không mong muốn', type: 'yesno', timepoint: tp },
        { id: 'side_effect_other', label: 'Tác dụng không mong muốn khác', section: 'Tác dụng không mong muốn', type: 'text', timepoint: tp },
      ]),
    ],
  },
};

function parseLines(textBlock, timepoint = '') {
  return textBlock.trim().split('\n').filter(Boolean).map(line => {
    const [section, label, type, options, unit, range, flag] = line.split('|').map(x => x.trim());
    const field = { section, label, type: type || 'text', timepoint };
    if (options) field.options = options.split(';').map(x => x.trim()).filter(Boolean);
    if (unit) field.unit = unit;
    const m = /^(-?[\d.]+)-(-?[\d.]+)$/.exec(range || '');
    if (m) { field.min = Number(m[1]); field.max = Number(m[2]); }
    if (flag === 'id') field.identifier = true;
    return field;
  });
}

function buildPresetForm(preset) {
  if (preset?.form) return {
    timepoints: (preset.form.timepoints || []).map(tp => ({ ...tp })),
    fields: (preset.form.fields || []).map(field => ({ ...field, options: Array.isArray(field.options) ? [...field.options] : field.options })),
  };
  const fields = [
    ...parseLines(preset.base),
    ...preset.repeated.flatMap(tp => parseLines(preset.followup, tp)),
    ...parseLines(preset.day7, 'D7'),
  ];
  return { timepoints: preset.timepoints, fields };
}

const CRF_PRESETS = [ORTHO_PSYCH_SLEEP_PAIN, APR_ZOLEDRONIC];

export { CRF_PRESETS, buildPresetForm };
