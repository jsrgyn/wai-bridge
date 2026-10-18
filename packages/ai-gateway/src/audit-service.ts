import { z } from 'zod';
import type { StructuredLogger } from './contracts.js';
import { stderrLogger } from './contracts.js';
const AuditSchema=z.object({messageId:z.string().min(1).max(128),consumerId:z.string().min(1).max(128),action:z.enum(['CLAIMED','PROCESSED','ACKNOWLEDGED','FAILED','RETRY_SCHEDULED','LIMITATION']),at:z.iso.datetime(),provider:z.enum(['cloud','local','mock']).optional(),mediaRef:z.string().max(256).optional(),errorCode:z.string().regex(/^[A-Z0-9_]{1,64}$/).optional(),limitation:z.string().max(256).optional()}).strict();
export type AIProcessingAudit=z.infer<typeof AuditSchema>;
export class AIProcessingAuditService {
  constructor(private readonly logger:StructuredLogger=stderrLogger,private readonly sink?:(entry:AIProcessingAudit)=>Promise<void>|void){}
  async record(input:AIProcessingAudit):Promise<void>{const item=AuditSchema.parse(input);if(this.sink)await this.sink(item);else this.logger.info(item,'ai.processing.audit');}
}
