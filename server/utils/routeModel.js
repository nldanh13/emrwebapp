'use strict';

// MODEL ĐƯỜNG DÙNG DUY NHẤT phía máy chủ Node: cùng dữ liệu (config/routes.json)
// và cùng lõi xử lý (src/config/routeModelCore.cjs) với giao diện.

const path = require('path');
const { createRouteModel } = require(path.join(__dirname, '..', '..', 'src', 'config', 'routeModelCore.cjs'));

module.exports = createRouteModel(require(path.join(__dirname, '..', '..', 'config', 'routes.json')));
