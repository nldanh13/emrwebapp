// server/services/scan_logger.js — Ghi log danh sách đã quét

'use strict';

const fs   = require('fs');
const path = require('path');

const { ensureDir, nowFileStamp, writeJsonAtomic } = require('../utils/file');

function extractScanSummaryRows(rawData) {
  const rows = Array.isArray(rawData) ? rawData : [];
  return rows.map((item, idx) => ({
    stt:       idx + 1,
    ma_bn:     item?.Ma_BN || item?.ma_bn || item?.MaBN || item?.mabn || item?.['Mã BN'] || item?.['Mã bệnh nhân'] || '',
    ho_ten:    item?.Ho_Ten || item?.ho_ten || item?.Ten_BN || item?.ten_bn || item?.['Họ tên'] || item?.['Tên bệnh nhân'] || '',
    gioi_tinh: item?.Gioi_Tinh || item?.gioi_tinh || item?.GT || item?.gt || '',
    phong:     item?.Phong || item?.phong || item?.Buong || item?.buong || item?.Khoa_Phong || item?.['Phòng'] || '',
    giuong:    item?.Giuong || item?.giuong || item?.Vi_Tri || item?.vi_tri || item?.['Giường'] || item?.['Vị trí'] || '',
    chan_doan: item?.Chan_Doan || item?.chan_doan || item?.['Chẩn đoán'] || '',
  }));
}

/**
 * Ghi snapshot JSON + append vào scan_history.log.
 * Trả về { snapshotPath, historyPath, count } hoặc null nếu lỗi.
 */
function writeScanLog(ctx, rawData) {
  try {
    ensureDir(ctx.LOGS_DIR);
    const stamp       = nowFileStamp();
    const summaryRows = extractScanSummaryRows(rawData);

    const payload = {
      created_at: new Date().toISOString(),
      session_id: ctx.sid,
      count:      summaryRows.length,
      items:      summaryRows,
      // raw data KHÔNG lưu vào snapshot để tránh tăng dung lượng disk gấp đôi
    };

    const snapshotPath = path.join(ctx.LOGS_DIR, `scan_list_${stamp}.json`);
    writeJsonAtomic(snapshotPath, payload);

    const historyPath = path.join(ctx.LOGS_DIR, 'scan_history.log');
    const lines = [
      `=== ${new Date().toLocaleString('vi-VN')} | sid=${ctx.sid} | so_luong=${summaryRows.length} ===`,
      ...summaryRows.map(r => `${String(r.stt).padStart(3, '0')}. ${r.ma_bn || '-'} | ${r.ho_ten || '-'} | ${r.phong || '-'} | ${r.giuong || '-'}`),
      '',
    ];
    fs.appendFileSync(historyPath, lines.join('\n'), 'utf-8');

    return { snapshotPath, historyPath, count: summaryRows.length };
  } catch (err) {
    console.error('!!! LỖI ghi scan log:', err);
    return null;
  }
}

module.exports = { writeScanLog };
