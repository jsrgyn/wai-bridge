import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const ConfigSchema = z.object({
  extensionId: z.string().regex(/^[a-p]{32}$/),
  apiToken: z.string().min(32).max(512),
  apiOrigin: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  }, 'API origin must use loopback HTTP'),
});

export type HostConfig = z.infer<typeof ConfigSchema>;

export async function readHostConfig(path: string): Promise<HostConfig> {
  const raw = await readFile(path, 'utf8');
  const parsed = ConfigSchema.safeParse(JSON.parse(raw) as unknown);
  if (!parsed.success) throw new Error('INVALID_HOST_CONFIGURATION');
  return parsed.data;
}
