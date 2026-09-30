'use strict';

// Đường dẫn script worker Python lấy lịch sử XN/CĐHA cho Kho nghiên cứu.

const path = require('path');
const { ROOT_DIR } = require('../constants');

const SCRIPT_PATH = path.join(ROOT_DIR, 'research', 'nghien_cuu_1', 'lay_lich_su_xn_cdha.py');

module.exports = {
  SCRIPT_PATH,
};
