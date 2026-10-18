import { chmod, mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { URL } from 'node:url';

const directory = process.env.WAI_BRIDGE_SUPPORT_DIR;
const extensionId = process.env.WAI_BRIDGE_EXTENSION_ID;
const apiToken = process.env.WAI_BRIDGE_API_TOKEN;
const apiOrigin = process.env.WAI_BRIDGE_API_ORIGIN ?? 'http://127.0.0.1:47831';
if (!directory || !extensionId || !apiToken) throw new Error('Missing install configuration');
if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('Invalid Chrome extension ID');
if (apiToken.length < 32) throw new Error('API token must contain at least 32 characters');
const parsed = new URL(apiOrigin);
if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
  throw new Error('API origin must be loopback HTTP');
}
await mkdir(directory, { recursive: true, mode: 0o700 });
const configPath = `${directory}/host-config.json`;
await writeFile(configPath, `${JSON.stringify({ extensionId, apiToken, apiOrigin }, null, 2)}\n`, { mode: 0o600 });
await chmod(configPath, 0o600);
