// Mẫu phiếu nhập tay dựng sẵn. Mỗi dòng: "Nhóm | Nhãn | kiểu | lựa chọn (cách nhau ;) | đơn vị | min-max | cờ"
// kiểu: number, text, choice, yesno, date, datetime. Cờ "id" = trường định danh (không ra file phân tích).
// Cờ "auto:<khóa>" = câu hỏi EMR/kho trả lời được (năm sinh, giới, khoa, chẩn đoán, xét nghiệm 14 ngày,
// thuốc 3 ngày trước truyền, bệnh kèm): app điền sẵn giá trị kèm nguồn, người nhập xem lại và sửa được.

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
Nhân khẩu & lối sống | Năm sinh | number |  |  | 1900-2030 | auto:birth_year
Nhân khẩu & lối sống | Giới tính | choice | Nam; Nữ |  |  | auto:sex
Nhân khẩu & lối sống | Khoa | text |  |  |  | auto:department
Nhân khẩu & lối sống | Chiều cao | number |  | cm | 50-250
Nhân khẩu & lối sống | Cân nặng | number |  | kg | 20-250
Nhân khẩu & lối sống | BMI | number |  | kg/m2 | 10-60
Nhân khẩu & lối sống | Khoảng cách nhà – bệnh viện | number |  | km | 0-2000
Nhân khẩu & lối sống | Hút thuốc lá | choice | Không; Đang hút/Cai < 6 tháng
Nhân khẩu & lối sống | Uống rượu bia trong 24 giờ qua | yesno
Tình trạng loãng xương | Chẩn đoán xác định | choice | Loãng xương sau mãn kinh/nguyên phát; Loãng xương nặng (có gãy xương) |  |  | auto:osteo_dx
Tình trạng loãng xương | T-score thấp nhất | number |  | SD | -10-5
Tình trạng loãng xương | Tiền sử gãy xương | yesno |  |  |  | auto:fracture
Tình trạng loãng xương | Vị trí gãy xương | text
Tiền sử dùng thuốc | Bisphosphonate đường uống | choice | Chưa từng dùng; Đã dùng nhưng ngưng > 1 năm; Đang dùng đều đặn, nay chuyển sang truyền
Tiền sử dùng thuốc | Tiền sử truyền Zoledronic Acid | choice | Lần đầu tiên trong đời; Đã truyền, ngưng ≥ 3 năm
Bệnh kèm & thuốc đồng sử dụng | Kháng viêm/giảm đau trong 3 ngày trước truyền | yesno |  |  |  | auto:analgesic_3d
Bệnh kèm & thuốc đồng sử dụng | Tên thuốc kháng viêm/giảm đau | text |  |  |  | auto:analgesic_3d_names
Bệnh kèm & thuốc đồng sử dụng | Dùng Statin | yesno |  |  |  | auto:statin
Bệnh kèm & thuốc đồng sử dụng | Đái tháo đường | yesno |  |  |  | auto:dm
Bệnh kèm & thuốc đồng sử dụng | Bệnh dạ dày – tá tràng | yesno |  |  |  | auto:gastro
Bệnh kèm & thuốc đồng sử dụng | Bệnh tự miễn (Lupus/RA) | yesno |  |  |  | auto:autoimmune
Cận lâm sàng (14 ngày trước truyền) | Vitamin D [25(OH)D] | number |  | ng/mL | 0-300 | auto:lab_vitd
Cận lâm sàng (14 ngày trước truyền) | Ngày xét nghiệm Vitamin D | date |  |  |  | auto:lab_vitd_date
Cận lâm sàng (14 ngày trước truyền) | Canxi ion hóa | number |  | mmol/L | 0-5 | auto:lab_ca_ion
Cận lâm sàng (14 ngày trước truyền) | Mức lọc cầu thận (eGFR) | number |  | mL/phút/1.73m2 | 0-250 | auto:lab_egfr
Cận lâm sàng (14 ngày trước truyền) | Bạch cầu (WBC) | number |  | G/L | 0-500 | auto:lab_wbc
Cận lâm sàng (14 ngày trước truyền) | Tỷ lệ Lympho (%Lym) | number |  | % | 0-100 | auto:lab_lym
Cận lâm sàng (14 ngày trước truyền) | Tỷ lệ Mono (%Mono) | number |  | % | 0-100 | auto:lab_mono
Triệu chứng nền | Nhiệt độ cơ thể nền | number |  | °C | 34-43
Triệu chứng nền | Đau cột sống thắt lưng (NRS) | ${NRS}
Triệu chứng nền | Đau khớp gối/vai/háng (NRS) | ${NRS}
Triệu chứng nền | Đau mỏi cơ toàn thân (NRS) | ${NRS}
Triệu chứng nền | Mệt mỏi nền (NRS) | ${NRS}
Trước khi truyền | Buổi truyền | choice | Sáng (trước 12h); Chiều (sau 12h) |  |  | auto:infusion_session
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
  // Câu hỏi lặp lại ở mỗi lần gọi 24/48/72 giờ.
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

function parseLines(textBlock, timepoint = '') {
  return textBlock.trim().split('\n').filter(Boolean).map(line => {
    const [section, label, type, options, unit, range, flag] = line.split('|').map(x => x.trim());
    const field = { section, label, type: type || 'text', timepoint };
    if (options) field.options = options.split(';').map(x => x.trim()).filter(Boolean);
    if (unit) field.unit = unit;
    const m = /^(-?[\d.]+)-(-?[\d.]+)$/.exec(range || '');
    if (m) { field.min = Number(m[1]); field.max = Number(m[2]); }
    if (flag === 'id') field.identifier = true;
    if (flag?.startsWith('auto:')) field.auto = flag.slice(5);
    return field;
  });
}

function buildPresetForm(preset) {
  const fields = [
    ...parseLines(preset.base),
    ...preset.repeated.flatMap(tp => parseLines(preset.followup, tp)),
    ...parseLines(preset.day7, 'D7'),
  ];
  return { timepoints: preset.timepoints, fields };
}

const CRF_PRESETS = [APR_ZOLEDRONIC];

export { CRF_PRESETS, buildPresetForm };
