import { AsyncLocalStorage } from 'node:async_hooks';
import { BufferedFlowReporter, emitFlow, flowCode, type FlowLogInput,type FlowLogSink } from '@wai-bridge/shared';
import { z } from 'zod';

const PageSchema = z.object({ items: z.array(z.unknown()), nextCursor: z.string().nullable() });
const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly enableFlowLogs?: boolean;
  readonly flowSink?:FlowLogSink;
}

export class LocalApiClient {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly traces = new AsyncLocalStorage<string>();
  private readonly reporter: BufferedFlowReporter;

  constructor(private readonly options: ApiClientOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new Error('MCP API URL must use HTTP on localhost');
    }
    if (options.token.length < 32)
      throw new Error('MCP API token must contain at least 32 characters');
    this.baseUrl = url;
    this.timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 30000) {
      throw new Error('MCP API timeout must be between 100 and 30000 milliseconds');
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.reporter = new BufferedFlowReporter(
      async (events) => {
        const response = await this.fetchImpl(new URL('/api/diagnostics/logs', this.baseUrl), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.options.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ events }),
          signal: AbortSignal.timeout(1500),
        });
        if (!response.ok) throw new Error('LOG_TRANSPORT_UNAVAILABLE');
      },
      options.flowSink ?? ((event) => {
        process.stderr.write(JSON.stringify({ type: 'wai.flow', ...event }) + '\n');
      }),
    );
  }

  withTrace<T>(traceId: string, run: () => Promise<T>): Promise<T> {
    return this.traces.run(traceId, run);
  }
  log(input: FlowLogInput): void {
    if (this.options.enableFlowLogs) emitFlow(this.reporter.emit, input);
  }
  async flushLogs(): Promise<void> {
    await this.reporter.flush();
  }
  closeLogs(): void {
    this.reporter.dispose();
  }
  async request(
    path: string,
    schema: z.ZodType = z.unknown(),
    init: RequestInit = {},
  ): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl.origin || !url.pathname.startsWith('/api/'))
      throw new Error('Invalid Local API path');
    const traceId = this.traces.getStore() ?? crypto.randomUUID();
    const start = performance.now();
    const headers = new Headers(init.headers);
    headers.set('x-wai-trace-id', traceId);
    this.log({
      traceId,
      component: 'MCP',
      phase: 'HTTP_REQUEST',
      outcome: 'STARTED',
      code: 'STARTED',
    });
    headers.set('authorization', `Bearer ${this.options.token}`);
    if (init.body) headers.set('content-type', 'application/json');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { ...init, headers, signal: controller.signal });
      const body: unknown = response.status === 204 ? null : await response.json();
      if (!response.ok) {
        const parsed = ErrorSchema.safeParse(body);
        throw new Error(
          parsed.success
            ? `${parsed.data.error.code}: ${parsed.data.error.message}`
            : `Local API returned HTTP ${response.status}`,
        );
      }
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw new Error('Local API response contract validation failed');
      this.log({
        traceId,
        component: 'MCP',
        phase: 'HTTP_REQUEST',
        outcome: 'SUCCEEDED',
        code: 'OK',
        durationMs: Math.round(performance.now() - start),
      });
      const value=parsed.data as {id?:unknown;items?:unknown[];messages?:unknown[]}|null;
      const records=value && (Array.isArray(value.items)?value.items:Array.isArray(value.messages)?value.messages:[]);
      const ids=new Set<string>();
      for(const item of (records||[]).slice(0,50)){const id=z.uuid().safeParse((item as {sourceObservationId?:unknown})?.sourceObservationId);if(id.success)ids.add(id.data);}
      for(const id of ids)this.log({traceId:id,resourceId:id,relatedTraceId:traceId,component:'MCP',phase:'CAPTURE_READ',outcome:'SUCCEEDED',code:'OK'});
      return parsed.data;
    } catch (error) {
      this.log({
        traceId,
        component: 'MCP',
        phase: 'HTTP_REQUEST',
        outcome: 'FAILED',
        code: error instanceof Error && error.name === 'AbortError' ? 'TIMEOUT' : flowCode(error),
        durationMs: Math.round(performance.now() - start),
      });
      if (error instanceof Error && error.name === 'AbortError')
        throw new Error('Local API request timed out', { cause: error });
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
