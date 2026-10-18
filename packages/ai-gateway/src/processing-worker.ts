import { AIResultSchema, type AIResult, type MediaInput } from './contracts.js';
import { AIMessageStateService } from './state-service.js';
import { AIProcessingAuditService } from './audit-service.js';
import { RetryService } from './retry-service.js';
import { AIEventConsumer } from './event-consumer.js';
export interface AIWorkItem { messageId:string; media?:MediaInput; process?: (signal:AbortSignal)=>Promise<AIResult|unknown> }
export class AIProcessingWorker {
  constructor(private readonly state:AIMessageStateService,private readonly audit:AIProcessingAuditService,private readonly retry=new RetryService(),private readonly timeoutMs=30000,private readonly wait:(ms:number)=>Promise<void>=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms))){}
  async process(item:AIWorkItem,signal?:AbortSignal):Promise<'READ'|'FAILED'|'RETRY'>{
    const claim=await this.state.claim(item.messageId);await this.audit.record({messageId:item.messageId,consumerId:this.state.consumerId,action:'CLAIMED',at:new Date().toISOString()});
    const controller=new AbortController();const forwardAbort=()=>controller.abort();signal?.addEventListener('abort',forwardAbort,{once:true});let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      if(!item.process)throw new Error('PROCESSOR_UNAVAILABLE');
      const timedOut=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('AI_PROCESSING_TIMEOUT'));},this.timeoutMs);});
      const result=await Promise.race([item.process(controller.signal),timedOut]);
      const validated=AIResultSchema.safeParse(result);
      if(validated.success){
        await this.audit.record({messageId:item.messageId,consumerId:this.state.consumerId,action:'PROCESSED',at:new Date().toISOString(),provider:validated.data.provider,mediaRef:validated.data.sourceRef});
        for(const limitation of validated.data.limitations)await this.audit.record({messageId:item.messageId,consumerId:this.state.consumerId,action:'LIMITATION',at:new Date().toISOString(),provider:validated.data.provider,mediaRef:validated.data.sourceRef,limitation});
      } else await this.audit.record({messageId:item.messageId,consumerId:this.state.consumerId,action:'PROCESSED',at:new Date().toISOString()});
      await this.state.acknowledge(item.messageId,claim.claimToken);await this.audit.record({messageId:item.messageId,consumerId:this.state.consumerId,action:'ACKNOWLEDGED',at:new Date().toISOString()});return 'READ';
    }catch(error){
      const code=error instanceof Error&&(error.name==='AbortError'||error.message==='AI_PROCESSING_TIMEOUT')?'AI_PROCESSING_TIMEOUT':error instanceof Error&&/^[A-Z0-9_]{1,64}$/.test(error.message)?error.message:'AI_PROCESSING_FAILED';
      await this.state.fail(item.messageId,claim.claimToken,code);
      if(this.retry.shouldRetry(claim.attempts)){await this.audit.record({messageId:item.messageId,consumerId:this.state.consumerId,action:'RETRY_SCHEDULED',at:new Date().toISOString(),errorCode:code});await this.wait(this.retry.nextDelayMs(claim.attempts));return 'RETRY';}
      await this.audit.record({messageId:item.messageId,consumerId:this.state.consumerId,action:'FAILED',at:new Date().toISOString(),errorCode:code});return 'FAILED';
    }finally{if(timer)clearTimeout(timer);signal?.removeEventListener('abort',forwardAbort);}
  }
  async recover(limit=50){return this.state.recoverable(limit);}
  async processEvent(event:unknown,consumer:AIEventConsumer,resolve:(messageId:string)=>Promise<AIWorkItem|undefined>):Promise<'IGNORED'|'DUPLICATE'|'READ'|'FAILED'|'RETRY'>{
    const accepted=await consumer.consume(event);if(!accepted)return 'IGNORED';if(accepted.duplicate)return 'DUPLICATE';
    const work=await resolve(accepted.messageId);if(!work)return 'IGNORED';return this.process(work);
  }
  async runRecovery(resolve:(messageId:string)=>Promise<AIWorkItem|undefined>,limit=50,signal?:AbortSignal):Promise<readonly {messageId:string;result:'IGNORED'|'READ'|'FAILED'|'RETRY'}[]>{
    const items=await this.recover(limit);const results:{messageId:string;result:'IGNORED'|'READ'|'FAILED'|'RETRY'}[]=[];
    for(const item of items){if(signal?.aborted)break;const work=await resolve(item.messageId);results.push({messageId:item.messageId,result:work?await this.process(work,signal):'IGNORED'});}
    return results;
  }
}
