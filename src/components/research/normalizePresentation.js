export function normalizeSchemaOutdated(schemaVersion, expectedSchemaVersion) {
  const actual = Number(schemaVersion || 0);
  const expected = Number(expectedSchemaVersion || 0);
  return actual > 0 && expected > 0 && actual < expected;
}

export function normalizeStagePresentation({ normalize = {}, qa = {} } = {}) {
  const items = Array.isArray(qa.blocking_items) ? qa.blocking_items : [];
  const blocking = Number(qa.blocking || items.length || 0);
  const onlyInputChanged = items.length > 0
    && items.every(item => String(item?.code || '') === 'input_changed_during_normalize');
  const hasRun = Boolean(
    normalize.at
    || normalize.schema_version
    || (normalize.status && normalize.status !== 'not_run')
  );

  if (normalize.status === 'complete') {
    return {
      state: blocking ? `${blocking} lỗi chặn` : Number(qa.warning || 0) ? `${Number(qa.warning)} cảnh báo` : 'đạt',
      tone: blocking ? 'warn' : Number(qa.warning || 0) ? 'warn' : 'ok',
      hasRun,
      transientInputChange: false,
    };
  }

  if (normalize.integrity_status === 'failed_integrity') {
    if (onlyInputChanged) {
      return {
        state: 'nguồn vừa thay đổi',
        tone: 'warn',
        hasRun: true,
        transientInputChange: true,
      };
    }
    return {
      state: `${blocking || 1} lỗi chặn`,
      tone: 'warn',
      hasRun: true,
      transientInputChange: false,
    };
  }

  if (hasRun) {
    return {
      state: 'cần chạy lại',
      tone: 'warn',
      hasRun: true,
      transientInputChange: false,
    };
  }

  return {
    state: 'chưa chạy',
    tone: 'neutral',
    hasRun: false,
    transientInputChange: false,
  };
}
