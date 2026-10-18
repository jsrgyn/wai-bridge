import { z } from 'zod';
import type { AIProcessingApi, ClaimResult } from './contracts.js';

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const ClaimSchema = z.object({ state: z.literal('CLAIMED'), claimToken: z.uuid(), leaseUntil: z.iso.datetime(), attempts: z.number().int().positive() });
const RecoverableSchema = z.array(z.object({ messageId: z.uuid(), leaseExpired: z.boolean() }));
const ConsumerStateSchema=z.object({messageId:z.uuid(),consumerId:z.string(),state:z.enum(['UNREAD','CLAIMED','READ','FAILED']),version:z.number().int().nonnegative(),leaseUntil:z.iso.datetime().nullable(),lastErrorCode:z.string().nullable()});
const EventsSchema = z.object({ items: z.array(z.unknown()), nextCursor: z.string().nullable() });

export interface LocalAIAPIOptions { baseUrl: string; token: string; timeoutMs?: number; fetchImpl?: typeof fetch }
export class LocalAIAPIClient implements AIProcessingApi {
  private readonly root: URL; private readonly timeoutMs: number; private readonly fetcher: typeof fetch;
  constructor(private readonly options: LocalAIAPIOptions) {
    this.root = new URL(options.baseUrl);
    if (this.root.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(this.root.hostname)) throw new Error('AI Gateway API URL must be HTTP localhost');
    if (options.token.length < 32) throw new Error('AI Gateway API token must contain at least 32 characters');
    this.timeoutMs = options.timeoutMs ?? 5000; if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 30000) throw new Error('Invalid AI Gateway API timeout');
    this.fetcher = options.fetchImpl ?? fetch;
  }
  private async call<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
    const url = new URL(path, this.root); if (url.origin !== this.root.origin || !url.pathname.startsWith('/api/')) throw new Error('Invalid Local API path');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = new Headers(init.headers); headers.set('authorization', `Bearer ${this.options.token}`); if (init.body) headers.set('content-type','application/json');
    try {
      const response = await this.fetcher(url,{...init,headers,signal:controller.signal});
      const body: unknown = await response.json();
      if (!response.ok) { const e=ErrorSchema.safeParse(body); throw new Error(e.success ? `${e.data.error.code}: ${e.data.error.message}` : `Local API HTTP ${response.status}`); }
      return schema.parse(body);
    } catch (error) { if (error instanceof Error && error.name==='AbortError') throw new Error('Local API request timed out',{cause:error}); throw error; }
    finally { clearTimeout(timer); }
  }
  claim(messageId:string,consumerId:string,leaseMs:number,idempotencyKey:string):Promise<ClaimResult> { return this.call('/api/ai/consumer-claims',ClaimSchema,{method:'POST',headers:{'idempotency-key':idempotencyKey},body:JSON.stringify({messageId,consumerId,leaseMs})}); }
  getState(messageId:string,consumerId:string) { return this.call(`/api/ai/messages/${messageId}/state?consumerId=${encodeURIComponent(consumerId)}`,ConsumerStateSchema); }
  async acknowledge(messageId:string,consumerId:string,claimToken:string,idempotencyKey:string):Promise<void> { await this.call('/api/ai/consumer-ack',z.object({state:z.literal('READ')}),{method:'POST',headers:{'idempotency-key':idempotencyKey},body:JSON.stringify({messageId,consumerId,claimToken})}); }
  async fail(messageId:string,consumerId:string,claimToken:string,errorCode:string,idempotencyKey:string):Promise<void> { await this.call('/api/ai/consumer-fail',z.object({state:z.literal('FAILED')}),{method:'POST',headers:{'idempotency-key':idempotencyKey},body:JSON.stringify({messageId,consumerId,claimToken,errorCode})}); }
  recoverable(consumerId:string,limit:number) { return this.call(`/api/ai/consumers/${encodeURIComponent(consumerId)}/recoverable?limit=${Math.min(100,Math.max(1,limit))}`,RecoverableSchema); }
  pendingEvents(cursor?:string) { const params=new URLSearchParams({limit:'100'}); if(cursor)params.set('cursor',cursor); return this.call(`/api/events?${params}`,EventsSchema); }
}
