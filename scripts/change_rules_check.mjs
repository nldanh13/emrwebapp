#!/usr/bin/env node
// Safeguard contributor guidelines. This verifies the instructions exist and
// remain discoverable; it cannot prove that a code change is clinically safe.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const read = name => readFileSync(resolve(root, name), 'utf8');
const errors = [];

const requiredFiles = [
  'AGENTS.md',
  'CLAUDE.md',
  'PRODUCT.md',
  'DESIGN.md',
  'docs/CHANGE_RULES.md',
  'docs/UX_RULES.md',
  'docs/EMR_ACCESS_SAFETY.md',
  'docs/PERSISTENT_CHROME_WORKER.md',
  'docs/PARALLEL_CARE_INFUSION.md',
  'docs/RESEARCH_DATA_SAFETY.md',
  '.github/pull_request_template.md',
  '.github/workflows/ci.yml',
];
for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) errors.push(`Thiếu file bắt buộc: ${file}`);
}
if (!errors.length) {
  const agents = read('AGENTS.md');
  const claude = read('CLAUDE.md');
  const rules = read('docs/CHANGE_RULES.md');
  const template = read('.github/pull_request_template.md');
  const ci = read('.github/workflows/ci.yml');

  const present = (body, words, name) => {
    for (const word of words) {
      if (!body.includes(word)) errors.push(`${name}: thiếu nội dung/đường dẫn ${word}`);
    }
  };

  present(agents, ['docs/CHANGE_RULES.md', 'docs/UX_RULES.md', 'docs/EMR_ACCESS_SAFETY.md',
    'docs/PERSISTENT_CHROME_WORKER.md', 'npm run test:ci'], 'AGENTS.md');
  present(claude, ['AGENTS.md', 'docs/CHANGE_RULES.md', 'npm run test:ci'], 'CLAUDE.md');
  present(rules, ['npm run test:ci', 'npm run build', '429/503', 'POST', 'Selenium',
    'rollback', 'Pull Request', 'CI'], 'docs/CHANGE_RULES.md');
  present(template, ['## Mục tiêu', '## Ảnh hưởng', '## Kiểm thử',
    '## Triển khai', 'npm run test:ci', 'rollback'], 'PR template');
  present(ci, ['pull_request:', 'npm run test:ci',
    'node scripts/change_rules_check.mjs'], 'CI');

  // Every Markdown relative link from the AI entrypoints must resolve within
  // this repository, preventing broken or confusing instructions.
  for (const [filename, body] of [['AGENTS.md', agents], ['CLAUDE.md', claude]]) {
    for (const match of body.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      const href = match[1].trim();
      if (/^(https?:|mailto:|#)/i.test(href)) continue;
      const full = resolve(root, href);
      if (!full.startsWith(root + '/') && full !== root) {
        errors.push(`${filename}: link ra ngoài repository: ${href}`);
      } else if (!existsSync(full)) {
        errors.push(`${filename}: link không tồn tại: ${href}`);
      }
    }
  }
}

if (errors.length) {
  console.error('[change-rules] Không đạt kiểm tra tài liệu an toàn:');
  for (const error of errors) console.error(' - ' + error);
  process.exitCode = 1;
} else {
  console.log('[change-rules] OK: quy tắc cho người/AI, PR checklist và bước CI hiện diện.');
}
