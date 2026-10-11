// Máy chủ đã biết địa chỉ đăng nhập EMR chưa (config/config.json → url_login, dùng chung với các màn
// bệnh phòng). Đã biết thì màn Phòng khám / Nghỉ ốm không hỏi URL nữa.
//   null  chưa hỏi xong (ẩn ô nhập để không nháy) · true  đã khai sẵn · false  cần nhập tay
import { useCallback, useEffect, useState } from 'react';
import * as api from '../api.js';
import { useOnTabReturn } from './useTabActivity.js';

export function useEmrUrlDefault() {
  const [hasDefault, setHasDefault] = useState(null);
  const load = useCallback(() => {
    api.getClinicEmrDefaults()
      .then(r => setHasDefault(Boolean(r?.has_login_url)))
      .catch(() => setHasDefault(prev => (prev === null ? false : prev)));
  }, []);
  useEffect(() => { load(); }, [load]);
  useOnTabReturn(load);
  return hasDefault;
}
