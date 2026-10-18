import { z } from 'zod';
import type { AIProcessingApi } from './contracts.js';
const MessageEventSchema = z.object({ id:z.uuid(), type:z.string(), aggregateType:z.string(), aggregateId:z.string().min(1), sequence:z.number().int().positive(), payload:z.record(z.string(),z.unknown()) });
export class AIEventConsumer {
  private readonly seen = new Set<string>();
  constructor(private readonly api: AIProcessingApi) {}
  async consume(event: unknown): Promise<{ messageId: string; duplicate: boolean } | undefined> {
    const parsed=MessageEventSchema.safeParse(event); if(!parsed.success) return undefined;
    if(!parsed.data.type.startsWith('message.')) return undefined;
    if(this.seen.has(parsed.data.id)) return {messageId:parsed.data.aggregateId,duplicate:true};
    this.seen.add(parsed.data.id); if(this.seen.size>10000) this.seen.delete(this.seen.values().next().value as string);
    return {messageId:parsed.data.aggregateId,duplicate:false};
  }
  async recoverMissedEvents(cursor?:string) { return this.api.pendingEvents(cursor); }
}
