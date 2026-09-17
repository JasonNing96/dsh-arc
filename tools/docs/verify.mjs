/** Check only this document's layout in an owned headless browser. */
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const packageRoot = process.env.ARC_DOC_NODE_MODULES;
const require = createRequire(packageRoot
  ? join(resolve(packageRoot), '__arc_docs__.cjs')
  : resolve(directory, '../../distribution/dsh-arc-cli/package.json'));
const { chromium } = require('playwright');
const executablePath = process.env.ARC_DOC_CHROMIUM;
const output = resolve(directory, '../../artifacts/docs-check');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('http://**/*', route => route.abort());
  await page.route('https://**/*', route => route.abort());
  await page.goto(pathToFileURL(resolve(directory, '../../docs/design.html')).href);
  await page.evaluate(() => document.fonts.ready);
  const layout = await page.evaluate(() => {
    const issues = [];
    for (const svg of document.querySelectorAll('svg')) {
      const id = svg.querySelector('title')?.id;
      const view = svg.viewBox.baseVal;
      const texts = [...svg.querySelectorAll('text')].map(e => ({ text: e.textContent, b: e.getBBox() }));
      for (const t of texts) {
        if (t.b.x < 0 || t.b.y < 0 || t.b.x + t.b.width > view.width + 1 || t.b.y + t.b.height > view.height + 1) issues.push({ id, type: 'out-of-bounds', text: t.text });
      }
      for (let i = 0; i < texts.length; i++) {
        for (let j = i + 1; j < texts.length; j++) {
          const a = texts[i], b = texts[j];
          const dx = Math.min(a.b.x + a.b.width, b.b.x + b.b.width) - Math.max(a.b.x, b.b.x);
          const dy = Math.min(a.b.y + a.b.height, b.b.y + b.b.height) - Math.max(a.b.y, b.b.y);
          if (dx > 2 && dy > 2) issues.push({ id, type: 'text-overlap', a: a.text, b: b.text });
        }
      }
    }
    return {
      title: document.title,
      figures: document.querySelectorAll('figure').length,
      sections: document.querySelectorAll('h2').length,
      remoteResources: [...document.querySelectorAll('[src],link[href],script[href]')].map(e => e.getAttribute('src') ?? e.getAttribute('href')).filter(x => /^https?:/.test(x)),
      bodyOverflow: document.documentElement.scrollWidth > innerWidth,
      issues,
    };
  });
  await page.screenshot({ path: join(output, 'preview-cover.png') });
  for (const id of ['01-current-runtime', '02-handoff-sequence', '03-plugin-assembly', '04-target-architecture', '05-trust-boundaries']) {
    await page.locator(`[id="${id}"] .diagram`).screenshot({ path: join(output, id + '.png') });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: join(output, 'preview-mobile.png') });
  const mobile = await page.evaluate(() => ({ bodyOverflow: document.documentElement.scrollWidth > innerWidth, figures: document.querySelectorAll('figure').length }));
  const passed = layout.figures === 5 && layout.sections === 11 && layout.issues.length === 0 && errors.length === 0 && layout.remoteResources.length === 0 && !layout.bodyOverflow && !mobile.bodyOverflow;
  const result = { passed, ...layout, errors, mobile };
  writeFileSync(join(output, 'layout-check.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  await browser.close();
}
