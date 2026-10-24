import { randomUUID } from 'node:crypto';
import { ConversationIdentityRepository } from '../src/repositories/conversation-identities.js';
import { expect, it } from 'vitest';
import { openDatabase, ExtensionSendRepository, applyMigrations, migrations } from '../src/index.js';

it('registers a visible reference with sends disabled and never claims a send',()=>{
  const db=openDatabase(':memory:');
  try {
    const identity={version:1 as const,type:'UI_CONTEXT' as const,source:'VISIBLE_UI' as const,accountId:randomUUID(),contextId:randomUUID(),conversationKey:randomUUID(),conversationKind:'GROUP' as const,confirmedAt:new Date().toISOString()};
    const repo=new ExtensionSendRepository(db);
    const instance=randomUUID();
    expect(repo.poll({extensionInstanceId:instance,identity,allowClaim:false})).toEqual({command:null});
    const refs=new ConversationIdentityRepository(db);
    const first=refs.resolve(identity,'Synthetic group',identity.confirmedAt);
    expect(refs.resolve({...identity,contextId:randomUUID()},'Synthetic group',identity.confirmedAt)).toEqual(first);
    expect(refs.resolve({...identity,conversationKey:randomUUID()},'Synthetic group',identity.confirmedAt).conversationId).not.toBe(first.conversationId);
    const pending=repo.create({conversationId:first.conversationId,text:'Synthetic unsent reply',mode:'AUTO',explicitAuthorization:true},'synthetic-autocontext-00001');
    expect(pending.status).toBe('QUEUED');
    expect(repo.poll({extensionInstanceId:instance,identity,allowClaim:false})).toEqual({command:null});
    expect(db.prepare('SELECT status FROM wa_outbox').get()).toEqual({status:'QUEUED'});
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {db.close();}
});

it('migrations 9 and 10 preserve existing confirmed schema 8 references',()=>{
  const db=openDatabase(':memory:',{migrate:false});
  try {
    applyMigrations(db,migrations.slice(0,8));
    const identity={version:1 as const,type:'PHONE' as const,source:'PROFILE_PHONE' as const,accountId:randomUUID(),contextId:randomUUID(),phone:'+12025550123',confirmedAt:new Date().toISOString()};
    const first={conversationId:randomUUID(),peerContactId:randomUUID()};
    db.prepare("INSERT INTO wa_contacts(id,connector,account_scope,display_name,identity_status,created_at,updated_at) VALUES(?,'fixture','synthetic','Synthetic person','PARTIAL',?,?)").run(first.peerContactId,identity.confirmedAt,identity.confirmedAt);
    db.prepare("INSERT INTO wa_conversations(id,connector,account_scope,kind,title,created_at,updated_at) VALUES(?,'fixture','synthetic','DIRECT','Synthetic person',?,?)").run(first.conversationId,identity.confirmedAt,identity.confirmedAt);
    db.prepare("INSERT INTO wa_conversation_identities VALUES(?,?,'PHONE',?,?,'PROFILE_PHONE',?)").run(first.conversationId,identity.accountId,identity.phone,first.peerContactId,identity.confirmedAt);
    const before=db.prepare('SELECT * FROM wa_conversation_identities').all();
    applyMigrations(db);
    expect(db.prepare('SELECT * FROM wa_conversation_identities').all()).toEqual(before);
    expect(db.prepare('SELECT phone_number FROM wa_contacts WHERE id=?').get(first.peerContactId)).toEqual({phone_number:identity.phone});
    expect(new ConversationIdentityRepository(db).resolve(identity,'Synthetic person',identity.confirmedAt)).toEqual(first);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check',{simple:true})).toBe('ok');
  } finally {db.close();}
});

it('enriches a pending visible contact with phone/name without splitting the conversation',()=>{
  const db=openDatabase(':memory:');
  try {
    const refs=new ConversationIdentityRepository(db);
    const identity={version:1 as const,type:'UI_CONTEXT' as const,source:'VISIBLE_UI' as const,accountId:randomUUID(),contextId:randomUUID(),conversationKey:randomUUID(),conversationKind:'UNKNOWN' as const,confirmedAt:'2026-10-18T12:00:00.000Z'};
    const first=refs.resolve(identity,'Synthetic contact',identity.confirmedAt);
    expect(first.peerContactId).toBeNull();
    const identified={...identity,conversationKind:'INDIVIDUAL' as const,phone:'+12025550123'};
    const next=refs.resolve(identified,'Synthetic contact',identity.confirmedAt);
    expect(next.conversationId).toBe(first.conversationId);
    expect(db.prepare('SELECT display_name,phone_number FROM wa_contacts').get()).toEqual({display_name:'Synthetic contact',phone_number:'+12025550123'});
    expect(()=>refs.resolve({...identified,phone:'+12025550124'},'Synthetic contact',identity.confirmedAt)).toThrow('CONTACT_PHONE_CONFLICT');
    expect(()=>refs.resolve({...identity,conversationKind:'GROUP'},'Synthetic group',identity.confirmedAt)).toThrow('CONVERSATION_KIND_CONFLICT');
    expect(db.pragma('foreign_key_check')).toEqual([]);
  }finally{db.close();}
});

it('claims phone-search commands from another open chat only in the requested account',()=>{
  const db=openDatabase(':memory:');
  try {
    const refs=new ConversationIdentityRepository(db);
    const at=new Date().toISOString();
    const accountId=randomUUID();
    const recipient={version:1 as const,type:'UI_CONTEXT' as const,source:'VISIBLE_UI' as const,accountId,contextId:randomUUID(),conversationKey:randomUUID(),conversationKind:'INDIVIDUAL' as const,phone:'+12025550123',confirmedAt:at};
    const registered=refs.resolve(recipient,'Synthetic recipient',at);
    const other={...recipient,conversationKey:randomUUID(),contextId:randomUUID(),phone:'+12025550124'};
    const repo=new ExtensionSendRepository(db);
    const request={conversationId:registered.conversationId,text:'Synthetic reply',mode:'AUTO' as const,explicitAuthorization:true as const,locateByPhone:true};
    const created=repo.create(request,'synthetic-phone-search-request');
    const extensionInstanceId=randomUUID();
    expect(repo.poll({extensionInstanceId,identity:{...other,accountId:randomUUID()}})).toEqual({command:null});
    expect(repo.poll({extensionInstanceId,identity:other,allowClaim:false})).toEqual({command:null});
    expect(repo.poll({extensionInstanceId,identity:other}).command).toMatchObject({id:created.id,contextId:other.contextId,locateByPhone:true,recipientPhone:recipient.phone,target:{referenceKey:recipient.conversationKey,accountId}});
    const group=refs.resolve({...recipient,conversationKey:randomUUID(),conversationKind:'GROUP',phone:undefined},'Synthetic group',at);
    expect(()=>repo.create({...request,conversationId:group.conversationId},'synthetic-group-phone-search')).toThrow('RECIPIENT_PHONE_REQUIRED');
    const missing=refs.resolve({...recipient,conversationKey:randomUUID(),phone:undefined},'Synthetic without phone',at);
    expect(()=>repo.create({...request,conversationId:missing.conversationId},'synthetic-missing-phone-search')).toThrow('RECIPIENT_PHONE_REQUIRED');
  }finally{db.close();}
});
