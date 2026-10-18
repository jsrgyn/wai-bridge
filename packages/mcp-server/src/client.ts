import { z } from 'zod';

const PageSchema = z.object({ items: z.array(z.unknown()), nextCursor: z.string().nullable() });
const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export class LocalApiClient {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ApiClientOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new Error('MCP API URL must use HTTP on localhost');
    }
    if (options.token.length < 32) throw new Error('MCP API token must contain at least 32 characters');
    this.baseUrl = url;
    this.timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 30000) {
      throw new Error('MCP API timeout must be between 100 and 30000 milliseconds');
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request(path: string, schema: z.ZodType = z.unknown(), init: RequestInit = {}): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl.origin || !url.pathname.startsWith('/api/')) throw new Error('Invalid Local API path');
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${this.options.token}`);
    if (init.body) headers.set('content-type', 'application/json');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { ...init, headers, signal: controller.signal });
      const body: unknown = response.status === 204 ? null : await response.json();
      if (!response.ok) {
        const parsed = ErrorSchema.safeParse(body);
        throw new Error(parsed.success ? `${parsed.data.error.code}: ${parsed.data.error.message}` : `Local API returned HTTP ${response.status}`);
      }
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw new Error('Local API response contract validation failed');
      return parsed.data;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('Local API request timed out', { cause: error });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async page(path: string): Promise<{ items: unknown[]; nextCursor: string | null }> {
    return PageSchema.parse(await this.request(path, PageSchema));
  }
}

export { PageSchema };
