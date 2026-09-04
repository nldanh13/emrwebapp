export function getValue(selector, root = document) {
  return root.querySelector(selector)?.value?.trim() || '';
}

export function setValue(selector, value, root = document) {
  const el = root.querySelector(selector);
  if (!el) return false;
  el.value = String(value ?? '');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

export function getSelectText(id, root = document) {
  const rendered = root.querySelector(`#select2-${id}-container`);
  if (rendered) return rendered.innerText.replace('×', '').trim();
  const el = root.querySelector(`#${id}`);
  return el?.selectedOptions?.[0]?.textContent?.trim() || '';
}

export function setSelectValue(selector, value, root = document) {
  const el = root.querySelector(selector);
  if (!el) return false;
  el.value = String(value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

export function setRadioValue(name, value, root = document) {
  const el = root.querySelector(`input[name="${name}"][value="${value}"]`);
  if (!el) return false;
  if (!el.checked) el.click();
  return true;
}

export function wait(ms = 300) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForElement(selector, timeoutMs = 10000, root = document) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const el = root.querySelector(selector);
    if (el) return el;
    await wait(150);
  }
  return null;
}
