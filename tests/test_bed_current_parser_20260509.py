# -*- coding: utf-8 -*-
from bed_current_check import parse_bed_timeline, build_checks


def test_parse_current_bed_from_bg_timeline():
    html = '''
    <a id="btnBG" onclick="onShowBuongGiuong(this);">Buồng giường</a>
    <div id="tabGiuongInfo">
      <div id="vertical-timeline">
        <div class="row">
          <div><span>Trạng thái: <span class="badge">Hoàn tất</span></span><br>
          <a>Từ: 14:04 29/04/2026 (Thứ 4)</a><br>
          <a>Đến: 16:00 06/05/2026 (Thứ 4)</a><br>
          <a>Người chỉ định: Nguyễn Chí Nguyện</a><br>
          <a>Loại: Không ghép</a><br></div>
          <h2>Giường K24.10.06.H034 | Phòng bệnh khoa Ngoại CTCH - 10 (Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh)</h2>
          <p>Giường Ngoại khoa loại 3 - Khoa Chấn thương chỉnh hình | Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh.</p>
        </div>
        <div class="row">
          <div><span>Trạng thái: <span class="badge">Đang thực hiện</span></span><br>
          <a>Từ: 19:00 06/05/2026 (Thứ 4)</a><br>
          <a>Đến: 23:59 08/05/2026 (Thứ 6)</a><br>
          <a>Người chỉ định: Nguyễn Chí Nguyện</a><br>
          <a>Loại: Không ghép</a><br></div>
          <h2>Giường K24.10.02.H030 | Phòng bệnh khoa Ngoại CTCH - 10 (Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh)</h2>
          <p>Giường Ngoại khoa loại 3 - Khoa Chấn thương chỉnh hình | Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh.</p>
        </div>
      </div>
    </div>
    '''
    timeline = parse_bed_timeline(html)
    checks = build_checks(timeline)
    current = checks['current']

    assert len(timeline) == 2
    assert checks['status'] == 'ok'
    assert current['is_current'] is True
    assert current['ma_giuong'] == 'K24.10.02.H030'
    assert current['phong_norm'] == 'P10'
    assert current['nguoi_chi_dinh'] == 'Nguyễn Chí Nguyện'
    assert current['expected_doctor_by_room'] == 'Nguyễn Chí Nguyện'
    assert current['doctor_matches_room'] is True
