import { z } from 'zod';
import type { AIProcessingApi } from './contracts.js';
const MessageEventSchema = z.object({ id:z.uuid(), type:z.string(), aggregateType:z.literal('message'), aggregateId:z.uuid(), sequence:z.number().int().positive(), payload:z.record(z.string(),z.unknown()) });
export class AIEventConsumer {
  constructor(private readonly api: AIProcessingApi) {}
  async consume(event: unknown): Promise<{ messageId: string; duplicate: boolean } | undefined> {
    const parsed=MessageEventSchema.safeParse(event); if(!parsed.success) return undefined;
    if(!parsed.data.type.startsWith('message.')) return undefined;
    // Notification receipt is not completion. Durable state and claims decide retries.
    return {messageId:parsed.data.aggregateId,duplicate:false};
  }
  async recoverMissedEvents(cursor?:string) { return this.api.pendingEvents(cursor); }
}
