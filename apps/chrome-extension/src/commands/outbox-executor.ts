import { z } from 'zod';

export const ExtensionOutboxCommandSchema=z.object({id:z.uuid(),version:z.literal(1),mode:z.enum(['AUTO','SUPERVISED']),recipientId:z.string().trim().min(1).max(256),recipientLabel:z.string().trim().min(1).max(256),conversationKind:z.enum(['INDIVIDUAL','GROUP']),text:z.string().trim().min(1).max(10000),explicitAuthorization:z.boolean(),idempotencyKey:z.string().min(16).max(128)}).strict();
export type ExtensionOutboxCommand=z.infer<typeof ExtensionOutboxCommandSchema>;
export type SendOutcome='SENT'|'UNKNOWN'|'FAILED'|'CANCELLED';
export interface ConversationResolver {find(label:string,kind:'INDIVIDUAL'|'GROUP'):HTMLElement[];open(conversation:HTMLElement):void}
export interface RecipientVerifier {verify(conversation:HTMLElement,command:ExtensionOutboxCommand):boolean}
export interface MessageComposer {prepare(conversation:HTMLElement,text:string):boolean}
export interface SendResultVerifier {verify(conversation:HTMLElement,command:ExtensionOutboxCommand):{outcome:SendOutcome;evidence?:string}}
export interface CommandPersistence {claim(commandId:string,idempotencyKey:string):Promise<boolean>;update(commandId:string,transition:string,details?:Record<string,string>):Promise<void>}
export interface ExecutorSettings {autoEnabled:boolean;composerEnabled:boolean;countdownMs?:number;countdownTick?:(remainingMs:number)=>void;delay?:(ms:number,signal:AbortSignal)=>Promise<void>}

/** Uses only semantic DOM markers in the synthetic fixture. Real UI support remains disabled. */
export class SyntheticConversationResolver implements ConversationResolver {
  find(label:string,kind:'INDIVIDUAL'|'GROUP'):HTMLElement[]{return Array.from(document.querySelectorAll<HTMLElement>('[data-wai-conversation]')).filter((node)=>node.dataset.waiConversationLabel===label&&node.dataset.waiConversationKind===kind);}
  open(conversation:HTMLElement):void{conversation.click();}
}
export class SyntheticRecipientVerifier implements RecipientVerifier {
  verify(conversation:HTMLElement,command:ExtensionOutboxCommand):boolean{return conversation.dataset.waiRecipientId===command.recipientId&&conversation.dataset.waiConversationKind===command.conversationKind;}
}
export class SyntheticMessageComposer implements MessageComposer {
  prepare(conversation:HTMLElement,text:string):boolean{const field=conversation.querySelector<HTMLTextAreaElement>('[data-wai-composer]');if(!field)return false;field.value=text;field.dispatchEvent(new Event('input',{bubbles:true}));return field.value===text;}
}
export class SyntheticSendResultVerifier implements SendResultVerifier {
  verify(conversation:HTMLElement,command:ExtensionOutboxCommand){const marker=conversation.querySelector<HTMLElement>('[data-wai-send-result]');if(!marker)return{outcome:'UNKNOWN' as const};const result=marker.dataset.waiSendResult;if(result==='SENT'&&marker.dataset.waiCommandId===command.id)return{outcome:'SENT' as const,evidence:`simulator:${command.id}`};if(result==='FAILED')return{outcome:'FAILED' as const};return{outcome:'UNKNOWN' as const};}
}
export class CountdownController {
  constructor(private readonly settings:ExecutorSettings){}
  async wait(signal:AbortSignal):Promise<void>{const duration=this.settings.countdownMs??5000;const delay=this.settings.delay??abortableDelay;const until=Date.now()+duration;while(Date.now()<until){if(signal.aborted)throw new Error('COMMAND_CANCELLED');const remaining=Math.max(0,until-Date.now());const target=document.querySelector<HTMLElement>('[data-wai-countdown]');if(target)target.textContent=String(Math.ceil(remaining/1000));this.settings.countdownTick?.(remaining);await delay(Math.min(100,remaining),signal);}const target=document.querySelector<HTMLElement>('[data-wai-countdown]');if(target)target.textContent='Sending…';this.settings.countdownTick?.(0);}
}
export class CancellationController {
  private readonly active=new Map<string,{controller:AbortController;listener:(event:MouseEvent)=>void}>();
  begin(id:string):AbortSignal{const controller=new AbortController();const listener=(event:MouseEvent)=>{const target=event.target;if(target instanceof Element&&target.closest<HTMLElement>('[data-wai-cancel-command]')?.dataset.waiCancelCommand===id)this.cancel(id);};document.addEventListener('click',listener);this.active.set(id,{controller,listener});return controller.signal;}
  cancel(id:string):boolean{const item=this.active.get(id);if(!item)return false;item.controller.abort();return true;}
  finish(id:string):void{const item=this.active.get(id);if(item)document.removeEventListener('click',item.listener);this.active.delete(id);}
}
export class AutoSendController {
  constructor(private readonly resolver:ConversationResolver,private readonly verifier:RecipientVerifier,private readonly composer:MessageComposer,private readonly resultVerifier:SendResultVerifier,private readonly persistence:CommandPersistence,private readonly settings:ExecutorSettings,private readonly cancellation:CancellationController){}
  async execute(command:ExtensionOutboxCommand):Promise<SendOutcome>{if(command.mode!=='AUTO')throw new Error('AUTO_MODE_REQUIRED');if(!command.explicitAuthorization)return this.record(command,'FAILED','AUTO_AUTHORIZATION_REQUIRED');if(!this.settings.autoEnabled||!this.settings.composerEnabled)return this.record(command,'FAILED','AUTO_EXECUTION_DISABLED');return this.executeAuthorized(command);}
  private async executeAuthorized(command:ExtensionOutboxCommand):Promise<SendOutcome>{const signal=this.cancellation.begin(command.id);try{const conversation=this.resolveUnique(command);this.resolver.open(conversation);if(!this.verifier.verify(conversation,command))return this.record(command,'FAILED','RECIPIENT_MISMATCH');if(!this.composer.prepare(conversation,command.text))return this.record(command,'FAILED','COMPOSE_FAILED');await this.persistence.update(command.id,'COMPOSED');await this.persistence.update(command.id,'WAITING_AUTO_SEND');await new CountdownController(this.settings).wait(signal);if(!conversation.isConnected||this.resolveUnique(command)!==conversation||!this.verifier.verify(conversation,command))return this.record(command,'FAILED','RECIPIENT_CHANGED');await this.persistence.update(command.id,'SENDING');const send=conversation.querySelector<HTMLButtonElement>('[data-wai-send]');if(!send)return this.record(command,'UNKNOWN','SEND_CONTROL_UNAVAILABLE');send.click();const result=this.resultVerifier.verify(conversation,command);if(result.outcome==='SENT'&&!result.evidence)return this.record(command,'UNKNOWN','SEND_EVIDENCE_MISSING');return this.record(command,result.outcome,result.evidence??result.outcome);}catch(error){if(signal.aborted)return this.record(command,'CANCELLED','CANCELLED_BY_USER');return this.record(command,'UNKNOWN',error instanceof Error?safeCode(error.message):'EXECUTION_UNKNOWN');}finally{this.cancellation.finish(command.id);}}
  private resolveUnique(command:ExtensionOutboxCommand):HTMLElement{const matches=this.resolver.find(command.recipientLabel,command.conversationKind);if(matches.length!==1)throw new Error(matches.length?'AMBIGUOUS_RECIPIENT':'RECIPIENT_NOT_FOUND');return matches[0]!;}
  private async record(command:ExtensionOutboxCommand,outcome:SendOutcome,reason:string):Promise<SendOutcome>{await this.persistence.update(command.id,outcome,outcome==='SENT'?{evidence:reason}:{reason});return outcome;}
}
export class SupervisedSendController {
  constructor(private readonly resolver:ConversationResolver,private readonly verifier:RecipientVerifier,private readonly composer:MessageComposer,private readonly resultVerifier:SendResultVerifier,private readonly persistence:CommandPersistence,private readonly settings:ExecutorSettings){}
  async prepare(command:ExtensionOutboxCommand):Promise<'WAITING_USER'|'FAILED'>{if(command.mode!=='SUPERVISED')throw new Error('SUPERVISED_MODE_REQUIRED');const matches=this.resolver.find(command.recipientLabel,command.conversationKind);if(matches.length!==1){await this.persistence.update(command.id,'FAILED',{reason:matches.length?'AMBIGUOUS_RECIPIENT':'RECIPIENT_NOT_FOUND'});return'FAILED';}const conversation=matches[0]!;this.resolver.open(conversation);if(!this.verifier.verify(conversation,command)){await this.persistence.update(command.id,'FAILED',{reason:'RECIPIENT_MISMATCH'});return'FAILED';}if(!this.settings.composerEnabled||!this.composer.prepare(conversation,command.text)){await this.persistence.update(command.id,'FAILED',{reason:'COMPOSE_FAILED'});return'FAILED';}await this.persistence.update(command.id,'COMPOSED');await this.persistence.update(command.id,'WAITING_USER');return'WAITING_USER';}
  async verifyResult(command:ExtensionOutboxCommand):Promise<SendOutcome>{const matches=this.resolver.find(command.recipientLabel,command.conversationKind);if(matches.length!==1)return this.record(command,'UNKNOWN','CONVERSATION_UNAVAILABLE');const result=this.resultVerifier.verify(matches[0]!,command);if(result.outcome==='SENT'&&!result.evidence)return this.record(command,'UNKNOWN','SEND_EVIDENCE_MISSING');return this.record(command,result.outcome,result.evidence??result.outcome);}
  private async record(command:ExtensionOutboxCommand,outcome:SendOutcome,reason:string):Promise<SendOutcome>{await this.persistence.update(command.id,outcome,outcome==='SENT'?{evidence:reason}:{reason});return outcome;}
}
export class OutboxCommandExecutor {
  constructor(private readonly auto:AutoSendController,private readonly supervised:SupervisedSendController,private readonly persistence:CommandPersistence){}
  async execute(raw:unknown):Promise<SendOutcome|'WAITING_USER'|'DUPLICATE'>{const command=ExtensionOutboxCommandSchema.parse(raw);if(!await this.persistence.claim(command.id,command.idempotencyKey))return'DUPLICATE';await this.persistence.update(command.id,'CLAIMED');if(command.mode==='SUPERVISED')return this.supervised.prepare(command);return this.auto.execute(command);}
}
function safeCode(value:string):string{return/^[A-Z0-9_]{1,64}$/.test(value)?value:'EXECUTION_UNKNOWN';}
function abortableDelay(ms:number,signal:AbortSignal):Promise<void>{return new Promise((resolve,reject)=>{if(signal.aborted){reject(new Error('COMMAND_CANCELLED'));return;}const timer=setTimeout(resolve,ms);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('COMMAND_CANCELLED'));},{once:true});});}
