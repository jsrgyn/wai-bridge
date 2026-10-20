import { test, expect } from '@playwright/test';
import { build, stop } from 'esbuild';
const bundle = await build({
  stdin: {
    contents: `import {uiCompatibility} from './src/adapters/ui-compatibility.ts';globalThis.waiCompatibility=()=>uiCompatibility(document);`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
});
const script = bundle.outputFiles[0]!.text;
stop();
for (const locale of ['pt-BR', 'en-US'])
  test(`diagnoses rendered UI and rejects ambiguous structures (${locale})`, async ({ page }) => {
    await page.setContent(
      `<html lang="${locale}"><body><div id="pane-side"></div><main id="main"><header><span data-testid="conversation-info-header-chat-title">Synthetic</span></header><footer><div contenteditable="true"></div></footer></main></body></html>`,
    );
    await page.addScriptTag({ content: script });
    const inspect = () =>
      page.evaluate(() =>
        (globalThis as unknown as { waiCompatibility: () => unknown }).waiCompatibility(),
      );
    expect(await inspect()).toMatchObject({ status: 'READY', canSync: true, canSend: true });
    await page.locator('#main').evaluate((main) => main.append(document.createElement('header')));
    expect(await inspect()).toMatchObject({
      status: 'UNSUPPORTED',
      canSync: false,
      canSend: false,
    });
    await page.locator('#main').evaluate((main) => {
      main.replaceWith(
        Object.assign(document.createElement('main'), {
          id: 'main',
          innerHTML: '<header></header>',
        }),
      );
    });
    expect(await inspect()).toMatchObject({ status: 'PARTIAL', canCapture: true, canSend: false });
    await page.locator('#main').evaluate((main) => main.remove());
    expect(await inspect()).toMatchObject({ status: 'NO_CONVERSATION', canSync: true });
  });
