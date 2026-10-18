import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { LocalApiClient } from './client.js';
import { createMcpServer } from './server.js';

const token = process.env.WAI_BRIDGE_API_TOKEN;
if (!token) throw new Error('WAI_BRIDGE_API_TOKEN must be configured outside source control');
const api = new LocalApiClient({
  enableFlowLogs: true,
  baseUrl: process.env.WAI_BRIDGE_API_URL ?? 'http://127.0.0.1:47831',
  token,
  ...(process.env.WAI_MCP_API_TIMEOUT_MS
    ? { timeoutMs: Number(process.env.WAI_MCP_API_TIMEOUT_MS) }
    : {}),
});
const handle = serveStdio(() =>
  createMcpServer({
    api,
    allowWrites: process.env.WAI_MCP_ALLOW_WRITES === 'true',
    allowExtensionSends: process.env.WAI_MCP_ALLOW_EXTENSION_SENDS === 'true',
  }),
);
process.once('SIGINT', () => {
  void api.flushLogs().finally(() => {
    api.closeLogs();
    void handle.close();
  });
});
process.once('SIGTERM', () => {
  void api.flushLogs().finally(() => {
    api.closeLogs();
    void handle.close();
  });
});
