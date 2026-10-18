import { randomUUID } from 'node:crypto';
import { OutboxRepository,type OutboxCommand } from '@wai-bridge/database';
import type { OutboxService } from './service.js';

export interface RecipientResolution {status:'VERIFIED'|'AMBIGUOUS'|'NOT_FOUND';contactId?:string}
export interface RecipientResolver {resolve(recipientId:string):Promise<RecipientResolution>}
export interface AuthorizationVerifier {verify(command:OutboxCommand):Promise<boolean>}
export class DenyAutoAuthorizationVerifier implements AuthorizationVerifier {async verify():Promise<boolean>{return false;}}
export class DatabaseRecipientResolver implements RecipientResolver {
  constructor(private readonly repository:OutboxRepository){}
  async resolve(recipientId:string):Promise<RecipientResolution>{const contact=this.repository.getContact(recipientId);if(!contact)return{status:'NOT_FOUND'};return contact.identityStatus==='KNOWN'?{status:'VERIFIED',contactId:contact.id}:{status:'AMBIGUOUS'};}
}
export interface SendResult {status:'SENT'|'UNKNOWN'|'FAILED';resultRef?:string;code?:string}
export interface SendExecutor {execute(input:{commandId:string;recipientId:string;text:string;mode:'AUTO'},signal:AbortSignal):Promise<SendResult>}
export interface Waiter {wait(ms:number,signal:AbortSignal):Promise<void>}
export class SimulatedSendExecutor implements SendExecutor {
  readonly kind='simulated';
  async execute(input:{commandId:string;recipientId:string;text:string;mode:'AUTO'},signal:AbortSignal):Promise<SendResult>{if(signal.aborted)throw new Error('EXECUTOR_ABORTED');return{status:'SENT',resultRef:`simulated:${input.commandId}`};}
}
const defaultWaiter:Waiter={wait(ms,signal){return new Promise((resolve,reject)=>{if(signal.aborted){reject(new Error('WAIT_CANCELLED'));return;}const timer=setTimeout(resolve,ms);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('WAIT_CANCELLED'));},{once:true});});}};
export class OutboxDispatcher {
  private readonly activeWaits=new Map<string,AbortController>();private readonly workerId:string;private stopped=false;
  constructor(private readonly repository:OutboxRepository,private readonly service:OutboxService,private readonly resolver:RecipientResolver,private readonly authorization:AuthorizationVerifier,private readonly executor:SendExecutor=new SimulatedSendExecutor(),private readonly waiter:Waiter=defaultWaiter,private readonly now:()=>string=()=>new Date().toISOString(),private readonly autoDelayMs=5000,private readonly leaseMs=30000,private readonly executionTimeoutMs=15000){this.workerId=`outbox-worker-${randomUUID()}`;}
  cancelWait(commandId:string):void{this.activeWaits.get(commandId)?.abort();}
  stop():void{this.stopped=true;for(const controller of this.activeWaits.values())controller.abort();}
  async run(pollIntervalMs=500):Promise<void>{this.stopped=false;await this.recoverAfterRestart();while(!this.stopped){try{const processed=await this.dispatchOne();if(!processed)await new Promise((resolve)=>setTimeout(resolve,pollIntervalMs));}catch(error){process.stderr.write(`${JSON.stringify({level:'error',message:'outbox.dispatch.failed',errorCode:code(error)})}\n`);await new Promise((resolve)=>setTimeout(resolve,pollIntervalMs));}}}
  async dispatchOne():Promise<OutboxCommand|undefined>{
    this.repository.recoverExpired(this.now(),this.workerId,false);
    const requested=this.repository.nextRequested();if(requested){try{this.service.transition(requested.id,'QUEUED',this.workerId,'COMMAND_QUEUED');}catch(error){if(this.repository.get(requested.id)?.status==='REQUESTED')throw error;}}
    const command=this.repository.claimNext(this.workerId,this.now(),this.leaseMs);if(!command)return undefined;
    try{return await this.prepareAndDispatch(command);}catch(error){const current=this.repository.get(command.id);if(current&&current.leaseOwner===this.workerId&&current.leaseUntil&&current.leaseUntil>this.now()&&['CLAIMED','TARGET_VERIFIED','COMPOSED'].includes(current.status))return this.service.transition(command.id,'FAILED',this.workerId,'DISPATCH_FAILURE',{leaseOwner:null,leaseUntil:null,resultCode:code(error),requiredLeaseOwner:this.workerId});throw error;}
  }
  async recoverAfterRestart():Promise<number>{return this.repository.recoverExpired(this.now(),this.workerId);}
  private async prepareAndDispatch(command:OutboxCommand):Promise<OutboxCommand>{
    const payload=command.payload as {recipientId:string;text:string;mode:'AUTO'|'SUPERVISED';explicitAuthorization:true};
    const resolution=await this.resolver.resolve(payload.recipientId);
    if(resolution.status!=='VERIFIED')return this.service.transition(command.id,'FAILED',this.workerId,resolution.status==='AMBIGUOUS'?'RECIPIENT_AMBIGUOUS':'RECIPIENT_NOT_FOUND',{leaseOwner:null,leaseUntil:null,resultCode:resolution.status,requiredLeaseOwner:this.workerId});
    this.service.transition(command.id,'TARGET_VERIFIED',this.workerId,'RECIPIENT_VERIFIED',{requiredLeaseOwner:this.workerId});
    this.service.transition(command.id,'COMPOSED',this.workerId,'MESSAGE_PREPARED',{requiredLeaseOwner:this.workerId});
    if(payload.mode==='SUPERVISED')return this.service.transition(command.id,'WAITING_USER',this.workerId,'MANUAL_SEND_REQUIRED',{leaseOwner:null,leaseUntil:null,requiredLeaseOwner:this.workerId});
    if(!payload.explicitAuthorization||!await this.authorization.verify(command))return this.service.transition(command.id,'FAILED',this.workerId,'EXPLICIT_AUTHORIZATION_REQUIRED',{resultCode:'AUTHORIZATION_REQUIRED',leaseOwner:null,leaseUntil:null,requiredLeaseOwner:this.workerId});
    const dueAt=new Date(Date.parse(this.now())+this.autoDelayMs).toISOString();
    this.service.transition(command.id,'WAITING_AUTO_SEND',this.workerId,'AUTO_DELAY_STARTED',{nextAttemptAt:dueAt,leaseOwner:null,leaseUntil:null,requiredLeaseOwner:this.workerId});
    const waitController=new AbortController();this.activeWaits.set(command.id,waitController);
    try{await this.waiter.wait(this.autoDelayMs,waitController.signal);}catch{const cancelled=this.repository.get(command.id);if(!cancelled)throw new Error('COMMAND_NOT_FOUND');return cancelled;}
    finally{this.activeWaits.delete(command.id);}
    const afterWait=this.repository.get(command.id);if(!afterWait)throw new Error('COMMAND_NOT_FOUND');if(afterWait.status!=='WAITING_AUTO_SEND')return afterWait;
    const lockUntil=new Date(Date.parse(this.now())+this.executionTimeoutMs+this.leaseMs).toISOString();
    const acquired=this.repository.acquireInterfaceLease(this.workerId,command.id,this.now(),this.executionTimeoutMs+this.leaseMs);
    if(!acquired)return this.service.transition(command.id,'FAILED',this.workerId,'SENDING_INTERFACE_BUSY',{resultCode:'INTERFACE_BUSY'});
    try{
      const sending=this.service.transition(command.id,'SENDING',this.workerId,'EXECUTION_STARTED',{leaseOwner:this.workerId,leaseUntil:lockUntil,executionStartedAt:this.now(),nextAttemptAt:null});
      const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
      const timeout=new Promise<SendResult>((resolve)=>{timer=setTimeout(()=>{controller.abort();resolve({status:'UNKNOWN',code:'EXECUTION_TIMEOUT'});},this.executionTimeoutMs);});
      let result:SendResult;
      try{result=await Promise.race([this.executor.execute({commandId:command.id,recipientId:payload.recipientId,text:payload.text,mode:'AUTO'},controller.signal),timeout]);}catch{result={status:'UNKNOWN',code:'EXECUTION_RESULT_UNKNOWN'};}finally{if(timer)clearTimeout(timer);}
      return this.service.transition(sending.id,result.status,this.workerId,result.code??`EXECUTION_${result.status}`,{leaseOwner:null,leaseUntil:null,resultCode:result.code??result.status,resultRef:result.resultRef??null});
    }finally{this.repository.releaseInterfaceLease(this.workerId,command.id);}
  }
}
function code(error:unknown):string{return error instanceof Error&&/^[A-Z0-9_]{1,64}$/.test(error.message)?error.message:'DISPATCH_FAILURE';}
