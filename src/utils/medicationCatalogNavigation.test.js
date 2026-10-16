import { describe, it, expect } from 'vitest';
import { MAIN_SECTIONS, SOURCE_SECTIONS, TOOL_SECTIONS, SECTION_DESCRIPTIONS, SOURCE_DESCRIPTIONS } from './medicationCatalogNavigation.js';

describe('three-level medication catalog navigation', () => {
  it('shows only three workflows, not seven competing catalogs', () => {
    expect(MAIN_SECTIONS.map(x => x.value)).toEqual(['drugs', 'sources', 'tools']);
    expect(SOURCE_SECTIONS.map(x => x.value)).toEqual(['hospital', 'new', 'builtin']);
    expect(TOOL_SECTIONS.map(x => x.value)).toEqual(['check', 'ingredients', 'cleanup', 'routes']);
    for (const section of MAIN_SECTIONS) expect(SECTION_DESCRIPTIONS[section.value]).toBeTruthy();
    for (const section of SOURCE_SECTIONS) expect(SOURCE_DESCRIPTIONS[section.value]).toBeTruthy();
  });
  it('explains that source lookup cannot automatically activate a medicine', () => {
    expect(SECTION_DESCRIPTIONS.sources).toMatch(/không tự kích hoạt/);
    expect(SECTION_DESCRIPTIONS.drugs).toMatch(/duy nhất/);
    expect(SOURCE_DESCRIPTIONS.hospital).toMatch(/kiểm tra rồi lưu/);
  });
});
