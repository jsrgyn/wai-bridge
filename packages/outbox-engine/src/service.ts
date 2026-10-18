import { createHash,randomUUID } from 'node:crypto';
import { OutboxRepository,OutboxStatusSchema,type OutboxCommand,type OutboxStatus } from '@wai-bridge/database';
import { z } from 'zod';
import { OutboxStateMachine } from './state-machine.js';
const RequestSchema=z.object({recipientId:z.uuid(),text:z.string().trim().min(1).max(10000),mode:z.enum(['AUTO','SUPERVISED']).default('SUPERVISED'),explicitAuthorization:z.literal(true)}).strict();
export interface OutboxCreateInput {recipientId:string;text:string;mode?:'AUTO'|'SUPERVISED';explicitAuthorization:true}
export class OutboxService {
  private readonly machine=new OutboxStateMachine();
  constructor(private readonly repository:OutboxRepository,private readonly now:()=>string=()=>new Date().toISOString()){}
  create(input:OutboxCreateInput,idempotencyScope:string,idempotencyKey:string){
    const value=RequestSchema.parse(input);const scope=z.string().min(1).max(128).parse(idempotencyScope);const key=z.string().min(16).max(128).parse(idempotencyKey);
    const payload={...value};const requestHash=createHash('sha256').update(JSON.stringify({kind:'send',payload:JSON.stringify(payload)})).digest('hex');
    const result=this.repository.create({id:randomUUID(),kind:'send',idempotencyScope:scope,idempotencyKey:key,requestHash,payload,createdAt:this.now()});
    const command=this.repository.get(result.id);if(!command)throw new Error('COMMAND_NOT_FOUND');return{...result,command};
  }
  get(id:string){const command=this.repository.get(id);if(!command)throw new Error('COMMAND_NOT_FOUND');return{command,history:this.repository.history(id)};}
  list(limit=50){return this.repository.list(limit);}
  transition(id:string,to:OutboxStatus,actor:string,reasonCode:string,fields:Parameters<OutboxRepository['transition']>[6]={}){
    const command=this.repository.get(id);if(!command)throw new Error('COMMAND_NOT_FOUND');const target=OutboxStatusSchema.parse(to);this.machine.assertTransition(command.status,target);
    return this.repository.transition(id,command.status,target,z.string().min(1).max(128).parse(actor),this.now(),z.string().regex(/^[A-Z0-9_]{1,64}$/).parse(reasonCode),fields);
  }
  recordManualResult(id:string,result:'SENT'|'UNKNOWN'|'FAILED',evidenceRef?:string){const command=this.repository.get(id);if(!command)throw new Error('COMMAND_NOT_FOUND');if(result==='SENT'&&!evidenceRef)throw new Error('VERIFIED_EVIDENCE_REQUIRED');if(command.status===result&&command.resultRef===(evidenceRef??null))return command;if(command.status!=='WAITING_USER')throw new Error('OUTBOX_STATE_CONFLICT');return this.transition(id,result,'user','MANUAL_RESULT_RECORDED',{resultCode:result,resultRef:evidenceRef??null,leaseOwner:null,leaseUntil:null});}
}

export class OutboxHistoryService {
  constructor(private readonly repository:OutboxRepository){}
  list(commandId:string){if(!this.repository.get(commandId))throw new Error('COMMAND_NOT_FOUND');return this.repository.history(commandId);}
}

export class OutboxCancellationService {
  constructor(private readonly service:OutboxService,private readonly wake:(commandId:string)=>void=()=>{}){}
  cancel(commandId:string,actor='user'){
    const current=this.service.get(commandId).command;if(current.status==='CANCELLED')return current;if(['SENDING','SENT','UNKNOWN','FAILED'].includes(current.status))throw new Error('OUTBOX_CANNOT_CANCEL');
    const result=this.service.transition(commandId,'CANCELLED',actor,'USER_CANCELLED',{nextAttemptAt:null,leaseOwner:null,leaseUntil:null,resultCode:'CANCELLED'});this.wake(commandId);return result;
  }
}

export type { OutboxCommand,OutboxStatus };
