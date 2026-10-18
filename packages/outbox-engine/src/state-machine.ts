import type { OutboxStatus } from '@wai-bridge/database';
const transitions:Record<OutboxStatus,readonly OutboxStatus[]>={
  REQUESTED:['QUEUED','FAILED','CANCELLED'],QUEUED:['CLAIMED','FAILED','CANCELLED'],CLAIMED:['TARGET_VERIFIED','QUEUED','FAILED','CANCELLED'],
  TARGET_VERIFIED:['COMPOSED','FAILED','CANCELLED'],COMPOSED:['WAITING_AUTO_SEND','WAITING_USER','FAILED','CANCELLED'],
  WAITING_AUTO_SEND:['SENDING','UNKNOWN','FAILED','CANCELLED'],WAITING_USER:['SENT','UNKNOWN','FAILED','CANCELLED'],
  SENDING:['SENT','UNKNOWN','FAILED'],SENT:[],UNKNOWN:[],FAILED:[],CANCELLED:[],
};
export class OutboxStateMachine {
  canTransition(from:OutboxStatus,to:OutboxStatus):boolean{return transitions[from].includes(to);}
  assertTransition(from:OutboxStatus,to:OutboxStatus):void{if(!this.canTransition(from,to))throw new Error(`OUTBOX_TRANSITION_INVALID:${from}:${to}`);}
}
