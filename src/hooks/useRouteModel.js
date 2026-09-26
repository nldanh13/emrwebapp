import { useSyncExternalStore } from 'react';
import { getRouteTable, subscribeRouteModel } from '../config/routes.js';

// Vẽ lại component khi bảng đường dùng đổi (sau khi lưu ở tab Đường dùng).
export function useRouteTable() {
  return useSyncExternalStore(subscribeRouteModel, getRouteTable, getRouteTable);
}
