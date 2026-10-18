import { chmod, mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';

const directory = process.env.WAI_BRIDGE_NATIVE_MANIFEST_DIR;
const hostPath = process.env.WAI_BRIDGE_NATIVE_HOST_PATH;
const extensionId = process.env.WAI_BRIDGE_EXTENSION_ID;
if (!directory || !hostPath || !extensionId || !/^[a-p]{32}$/.test(extensionId)) {
  throw new Error('Native host manifest configuration is invalid');
}
await mkdir(directory, { recursive: true, mode: 0o700 });
const manifest = {
  name: 'com.wai_bridge.mac_agent',
  description: 'WAI Bridge local Native Messaging host',
  path: hostPath,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${extensionId}/`],
};
const manifestPath = `${directory}/com.wai_bridge.mac_agent.json`;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
await chmod(manifestPath, 0o600);
