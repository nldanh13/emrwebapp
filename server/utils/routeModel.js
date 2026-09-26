'use strict';

// MODEL ĐƯỜNG DÙNG DUY NHẤT phía máy chủ Node: cùng dữ liệu (config/routes.json +
// phần tự cài config/routes.custom.json) và cùng lõi xử lý (src/config/routeModelCore.cjs)
// với giao diện. Tự nạp lại khi một trong hai file thay đổi.

const fs = require('fs');
const path = require('path');
const { createRouteModel, mergeRouteTable } = require(path.join(__dirname, '..', '..', 'src', 'config', 'routeModelCore.cjs'));

const BASE_FILE = path.join(__dirname, '..', '..', 'config', 'routes.json');
const CUSTOM_FILE = path.join(__dirname, '..', '..', 'config', 'routes.custom.json');

function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

let cacheKey = '';
let current = null;

function model() {
  const key = `${mtime(BASE_FILE)}|${mtime(CUSTOM_FILE)}`;
  if (!current || key !== cacheKey) {
    current = createRouteModel(mergeRouteTable(readJson(BASE_FILE, { routes: [], rules: [] }), readJson(CUSTOM_FILE, { routes: [] })));
    cacheKey = key;
  }
  return current;
}

const api = {
  BASE_FILE,
  CUSTOM_FILE,
  readCustom: () => readJson(CUSTOM_FILE, { routes: [] }),
  readBase: () => readJson(BASE_FILE, { routes: [], rules: [] }),
};
for (const name of ['normalizeRouteCode', 'detectRouteCode', 'mentionedRoutes', 'routeInfo', 'routeShort',
  'routeReportMode', 'routeCategory', 'categoryLabel', 'categoryDefaultRoute', 'routeCodeOfItem']) {
  api[name] = (...args) => model()[name](...args);
}
Object.defineProperty(api, 'ROUTE_TABLE', { get: () => model().ROUTE_TABLE, enumerable: true });
Object.defineProperty(api, 'ROUTES', { get: () => model().ROUTES, enumerable: true });
Object.defineProperty(api, 'CATEGORIES', { get: () => model().CATEGORIES, enumerable: true });

module.exports = api;
