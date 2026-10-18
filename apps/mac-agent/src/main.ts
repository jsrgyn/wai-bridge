import { stderr, stdin, stdout } from 'node:process';
import { resolve } from 'node:path';
import { LocalApiClient } from './api-client.js';
import { readHostConfig } from './config.js';
import { runNativeHost } from './host.js';

const configPath = process.env.WAI_BRIDGE_HOST_CONFIG;
const callerOrigin = process.argv[2] ?? '';
if (!configPath) throw new Error('WAI_BRIDGE_HOST_CONFIG is required');
const config = await readHostConfig(resolve(configPath));
try {
  await runNativeHost({ input: stdin, output: stdout, stderr, callerOrigin, config, api: new LocalApiClient(config) });
} catch (error) {
  stderr.write(`Native host stopped: ${error instanceof Error ? error.message : 'UNKNOWN'}\n`);
  process.exitCode = 1;
}
