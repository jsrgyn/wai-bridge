import { cp, mkdir, rm } from 'node:fs/promises';
import process from 'node:process';
import { URL } from 'node:url';
import { build, context } from 'esbuild';

const out = new URL('../dist/', import.meta.url);
const watch = process.argv.includes('--watch');
const entries = {
  'service-worker': new URL('../src/background/service-worker.ts', import.meta.url).pathname,
  'content-script': new URL('../src/content/content-script.ts', import.meta.url).pathname,
  popup: new URL('../src/popup/popup.ts', import.meta.url).pathname,
  options: new URL('../src/options/options.ts', import.meta.url).pathname,
};

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(new URL('../manifest.json', import.meta.url), new URL('manifest.json', out));
await cp(new URL('../src/popup/popup.html', import.meta.url), new URL('popup.html', out));
await cp(new URL('../src/popup/popup.css', import.meta.url), new URL('popup.css', out));
await cp(new URL('../src/options/options.html', import.meta.url), new URL('options.html', out));
await cp(new URL('../src/options/options.css', import.meta.url), new URL('options.css', out));

const options = { entryPoints: entries, outdir: out.pathname, bundle: true, format: 'iife', platform: 'browser', target: 'chrome120' };
if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
