import { afterEach,describe,expect,it,vi } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase,OutboxRepository } from '@wai-bridge/database';
import { DatabaseRecipientResolver,DenyAutoAuthorizationVerifier,OutboxCancellationService,OutboxDispatcher,OutboxService,SimulatedSendExecutor,type SendExecutor,type Waiter } from '../src/index.js';

const now='2026-10-17T12:00:00.000Z';const recipientId='11111111-1111-4111-8111-111111111111';const dirs:string[]=[];const dbs:ReturnType<typeof openDatabase>[]=[];
function setup(){const dir=mkdtempSync(join(tmpdir(),'wai-outbox-'));dirs.push(dir);const db=openDatabase(join(dir,'outbox.sqlite'));dbs.push(db);db.prepare(`INSERT INTO wa_contacts(id,connector,account_scope,external_id,display_name,identity_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`).run(recipientId,'fixture','local','synthetic-contact','Synthetic recipient','KNOWN',now,now);const repository=new OutboxRepository(db);const service=new OutboxService(repository,()=>now);return{db,repository,service};}
function create(service:OutboxService,mode:'AUTO'|'SUPERVISED'='SUPERVISED',key='outbox-idempotency-000001'){return service.create({recipientId,text:'Synthetic message',mode,explicitAuthorization:true},'test-scope',key).command;}
function dispatcher(repository:OutboxRepository,service:OutboxService,options:{executor?:SendExecutor;waiter?:Waiter;authorize?:boolean;resolver?:DatabaseRecipientResolver;now?:()=>string}={}){return new OutboxDispatcher(repository,service,options.resolver??new DatabaseRecipientResolver(repository),{verify:async()=>options.authorize??false},options.executor??new SimulatedSendExecutor(),options.waiter,options.now??(()=>now),5000,3000,50);}
afterEach(()=>{for(const db of dbs.splice(0))if(db.open)db.close();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});

describe('transactional outbox engine',()=>{
  it('prevents a stale resolver from changing a command reclaimed by another worker',async()=>{
    const {repository,service}=setup();const command=create(service);
    let clock=now;const liveService=new OutboxService(repository,()=>clock);
    let entered!:()=>void;const resolved=new Promise<void>((resolve)=>{entered=resolve;});
    let release!:()=>void;const held=new Promise<void>((resolve)=>{release=resolve;});
    const worker=dispatcher(repository,liveService,{now:()=>clock,resolver:{resolve:async()=>{entered();await held;return{status:'VERIFIED'};}}});
    const running=worker.dispatchOne();await resolved;
    clock='2026-10-17T12:00:04.000Z';
    repository.recoverExpired(clock,'recovery',false);repository.claimNext('new-worker',clock,3000);
    release();await expect(running).rejects.toThrow('OUTBOX_LEASE_EXPIRED');
    expect(repository.get(command.id)).toMatchObject({status:'CLAIMED',leaseOwner:'new-worker'});
  });
  it('recovers preparation on a later poll when restart precedes lease expiry',async()=>{
    const {repository,service}=setup();const command=create(service,'AUTO');
    service.transition(command.id,'QUEUED','test','QUEUE');repository.claimNext('crashed',now,1000);
    service.transition(command.id,'TARGET_VERIFIED','crashed','VERIFY');
    let clock=now;const execute=vi.fn();const worker=dispatcher(repository,service,{now:()=>clock,executor:{execute}});
    expect(await worker.recoverAfterRestart()).toBe(0);
    expect(await worker.dispatchOne()).toBeUndefined();
    clock='2026-10-17T12:00:02.000Z';
    expect(await worker.dispatchOne()).toBeUndefined();
    expect(repository.get(command.id)?.resultCode).toBe('PREPARATION_INTERRUPTED');
    expect(execute).not.toHaveBeenCalled();
  });
  it('does not cancel a live AUTO countdown during periodic lease recovery',async()=>{
    const {repository,service}=setup();const command=create(service,'AUTO');
    let entered!:()=>void;const waitEntered=new Promise<void>((resolve)=>{entered=resolve;});
    let release!:()=>void;const held=new Promise<void>((resolve)=>{release=resolve;});
    const worker=dispatcher(repository,service,{authorize:true,waiter:{wait:async()=>{entered();await held;}}});
    const running=worker.dispatchOne();await waitEntered;
    expect(await dispatcher(repository,service).dispatchOne()).toBeUndefined();
    expect(repository.get(command.id)?.status).toBe('WAITING_AUTO_SEND');
    release();expect((await running)?.status).toBe('SENT');
  });
  it.each(['TARGET_VERIFIED','COMPOSED'] as const)('terminates interrupted %s preparation after reopening SQLite',async(status)=>{
    const {db,repository,service}=setup();const command=create(service,'AUTO');
    service.transition(command.id,'QUEUED','test','QUEUE');repository.claimNext('crashed',now,1000);
    service.transition(command.id,'TARGET_VERIFIED','crashed','VERIFY');
    if(status==='COMPOSED')service.transition(command.id,'COMPOSED','crashed','COMPOSE');
    const path=db.name;db.close();const reopened=openDatabase(path);dbs.push(reopened);
    const repo=new OutboxRepository(reopened);const restored=new OutboxService(repo,()=> '2026-10-17T12:00:02.000Z');
    const execute=vi.fn();const worker=dispatcher(repo,restored,{now:()=> '2026-10-17T12:00:02.000Z',executor:{execute}});
    expect(await worker.recoverAfterRestart()).toBe(1);
    expect(repo.get(command.id)).toMatchObject({status:'FAILED',resultCode:'PREPARATION_INTERRUPTED',leaseOwner:null,leaseUntil:null});
    expect(await worker.recoverAfterRestart()).toBe(0);
    expect(await worker.dispatchOne()).toBeUndefined();expect(execute).not.toHaveBeenCalled();
    expect(restored.get(command.id).history.at(-1)).toMatchObject({fromStatus:status,toStatus:'FAILED',reasonCode:'PREPARATION_INTERRUPTED'});
  });
  it.each(['TARGET_VERIFIED','COMPOSED'] as const)('recovers legacy %s without a lease but preserves a live lease',async(status)=>{
    const {repository,service}=setup();const command=create(service);
    service.transition(command.id,'QUEUED','test','QUEUE');repository.claimNext('live',now,3000);
    service.transition(command.id,'TARGET_VERIFIED','live','VERIFY');
    if(status==='COMPOSED')service.transition(command.id,'COMPOSED','live','COMPOSE');
    expect(await dispatcher(repository,service).recoverAfterRestart()).toBe(0);
    repository.transition(command.id,status,status,'test',now,'LEGACY_FIXTURE',{leaseOwner:null,leaseUntil:null});
    expect(await dispatcher(repository,service).recoverAfterRestart()).toBe(1);
    expect(repository.get(command.id)?.status).toBe('FAILED');
  });
  it('defaults to SUPERVISED and deduplicates by idempotency key',()=>{const{db,service}=setup();const first=create(service);const duplicate=service.create({recipientId,text:'Synthetic message',explicitAuthorization:true},'test-scope','outbox-idempotency-000001');expect(first.status).toBe('REQUESTED');expect((first.payload as {mode:string}).mode).toBe('SUPERVISED');expect(duplicate.inserted).toBe(false);expect(duplicate.id).toBe(first.id);expect(db.prepare('SELECT count(*) AS n FROM wa_outbox').get()).toEqual({n:1});expect(db.prepare('SELECT count(*) AS n FROM wa_outbox_history WHERE command_id=?').get(first.id)).toEqual({n:1});});
  it('queues, claims, verifies and prepares SUPERVISED without invoking executor',async()=>{const{service,repository}=setup();const command=create(service);const execute=vi.fn();const result=await dispatcher(repository,service,{executor:{execute} as SendExecutor}).dispatchOne();expect(result?.status).toBe('WAITING_USER');expect(execute).not.toHaveBeenCalled();expect(service.get(command.id).history.map((x)=>x.toStatus)).toEqual(['REQUESTED','QUEUED','CLAIMED','TARGET_VERIFIED','COMPOSED','WAITING_USER']);});
  it('AUTO requires explicit authorization, waits five cancelable seconds, and uses only simulation',async()=>{const{service,repository}=setup();const command=create(service,'AUTO');const wait=vi.fn(async(ms:number)=>{expect(ms).toBe(5000);});const result=await dispatcher(repository,service,{authorize:true,waiter:{wait} as Waiter}).dispatchOne();expect(result?.status).toBe('SENT');expect(result?.resultRef).toBe(`simulated:${command.id}`);expect(wait).toHaveBeenCalledOnce();});
  it('denies AUTO when authorization is not independently verified',async()=>{const{service,repository}=setup();create(service,'AUTO');const result=await dispatcher(repository,service,{waiter:{wait:async()=>{throw new Error('must not wait');}}}).dispatchOne();expect(result?.status).toBe('FAILED');expect(result?.resultCode).toBe('AUTHORIZATION_REQUIRED');});
  it('cancels during AUTO wait and does not invoke the executor',async()=>{const{service,repository}=setup();const command=create(service,'AUTO');let entered!:()=>void;const waitEntered=new Promise<void>((resolve)=>{entered=resolve;});const waiter:Waiter={wait(_ms,signal){entered();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('WAIT_CANCELLED')),{once:true}));}};const instance=dispatcher(repository,service,{authorize:true,waiter});const cancellation=new OutboxCancellationService(service,(id)=>instance.cancelWait(id));const running=instance.dispatchOne();await waitEntered;cancellation.cancel(command.id);expect((await running)?.status).toBe('CANCELLED');});
  it('rejects ambiguous recipients without invoking the executor',async()=>{const{service,repository}=setup();create(service);const result=await dispatcher(repository,service,{resolver:{resolve:async()=>({status:'AMBIGUOUS'})}}).dispatchOne();expect(result?.status).toBe('FAILED');expect(result?.resultCode).toBe('AMBIGUOUS');});
  it('records executor failures and never retries UNKNOWN automatically',async()=>{const{service,repository}=setup();const command=create(service,'AUTO');expect(command.payload).toMatchObject({mode:'AUTO'});const unknownExecutor:SendExecutor={execute:async()=>({status:'UNKNOWN',code:'RESULT_UNCERTAIN'})};const result=await dispatcher(repository,service,{authorize:true,executor:unknownExecutor,waiter:{wait:async()=>{}}}).dispatchOne();expect(result?.status).toBe('UNKNOWN');expect(await dispatcher(repository,service,{authorize:true}).dispatchOne()).toBeUndefined();expect(service.get(command.id).history.at(-1)?.toStatus).toBe('UNKNOWN');});
  it('records a certain executor failure and marks timeout as UNKNOWN',async()=>{const{service,repository}=setup();create(service,'AUTO');const failed=await dispatcher(repository,service,{authorize:true,executor:{execute:async()=>({status:'FAILED',code:'EXECUTOR_REJECTED'})},waiter:{wait:async()=>{}}}).dispatchOne();expect(failed?.status).toBe('FAILED');
    const second=create(service,'AUTO','outbox-idempotency-000008');const hung:SendExecutor={execute:()=>new Promise(()=>{})};const timed=await dispatcher(repository,service,{authorize:true,executor:hung,waiter:{wait:async()=>{}}}).dispatchOne();expect(timed?.status).toBe('UNKNOWN');expect(timed?.resultCode).toBe('EXECUTION_TIMEOUT');expect(second.status).toBe('REQUESTED');});
  it('records supervised result only with evidence and rejects prepared-as-sent',async()=>{const{service,repository}=setup();const command=create(service);await dispatcher(repository,service).dispatchOne();expect(()=>service.recordManualResult(command.id,'SENT')).toThrow('VERIFIED_EVIDENCE_REQUIRED');expect(service.get(command.id).command.status).toBe('WAITING_USER');expect(service.recordManualResult(command.id,'SENT','manual-observation:synthetic').status).toBe('SENT');});
  it('recovers expired claims for retry and converts interrupted execution/wait to terminal states',async()=>{const{service,repository}=setup();const claim=create(service);service.transition(claim.id,'QUEUED','test','QUEUE');repository.claimNext('crashed-worker',now,1000);expect(await dispatcher(repository,service,{now:()=> '2026-10-17T12:00:02.000Z'}).recoverAfterRestart()).toBe(1);expect(service.get(claim.id).command.status).toBe('QUEUED');new OutboxCancellationService(service).cancel(claim.id);
    const auto=create(service,'AUTO','outbox-idempotency-000002');service.transition(auto.id,'QUEUED','test','QUEUE');repository.claimNext('worker', '2026-10-17T12:00:03.000Z',3000);service.transition(auto.id,'TARGET_VERIFIED','worker','VERIFY');service.transition(auto.id,'COMPOSED','worker','PREPARE');service.transition(auto.id,'WAITING_AUTO_SEND','worker','WAIT',{nextAttemptAt:'2026-10-17T12:00:10.000Z'});await dispatcher(repository,service).recoverAfterRestart();expect(service.get(auto.id).command.status).toBe('CANCELLED');});
  it('serializes concurrent access to the single send interface',async()=>{const{service,repository}=setup();create(service,'AUTO','outbox-idempotency-000003');create(service,'AUTO','outbox-idempotency-000004');let active=0;let maxActive=0;let entered!:()=>void;const firstEntered=new Promise<void>((resolve)=>{entered=resolve;});let release!:()=>void;const held=new Promise<void>((resolve)=>{release=resolve;});const executor:SendExecutor={async execute(){active++;maxActive=Math.max(active,maxActive);entered();await held;active--;return{status:'SENT',resultRef:'simulated:one'};}};const one=dispatcher(repository,service,{authorize:true,executor,waiter:{wait:async()=>{}}});const two=dispatcher(repository,service,{authorize:true,executor,waiter:{wait:async()=>{}}});const first=one.dispatchOne();await firstEntered;const second=await two.dispatchOne();expect(second?.status).toBe('FAILED');release();await first;expect(maxActive).toBe(1);});
  it('does not mass dispatch: each call processes at most one request',async()=>{const{service,repository}=setup();create(service,'SUPERVISED','outbox-idempotency-000005');create(service,'SUPERVISED','outbox-idempotency-000006');const worker=dispatcher(repository,service);expect((await worker.dispatchOne())?.status).toBe('WAITING_USER');expect(repository.list(10).filter((x)=>x.status==='REQUESTED')).toHaveLength(1);});
  it('keeps AUTO denied by default without an authorization verifier',async()=>{const{service,repository}=setup();create(service,'AUTO','outbox-idempotency-000007');const result=await dispatcher(repository,service,{waiter:{wait:async()=>{}}}).dispatchOne();expect(result?.status).toBe('FAILED');const safe=new DenyAutoAuthorizationVerifier();expect(await safe.verify(result!)).toBe(false);});
});
