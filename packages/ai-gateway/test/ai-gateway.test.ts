import { describe,expect,it,vi } from 'vitest';
import { AIEventConsumer } from '../src/event-consumer.js';
import { AIMessageStateService } from '../src/state-service.js';
import { AIProcessingWorker } from '../src/processing-worker.js';
import { AIProcessingAuditService } from '../src/audit-service.js';
import { RetryService } from '../src/retry-service.js';
import { AudioTranscriptionService,DocumentAnalysisService,ImageAnalysisService,VideoAnalysisService } from '../src/media-services.js';
import { HTTPAIProviderAdapter,MockAIProviderAdapter } from '../src/provider-adapter.js';
import type { AIProcessingApi } from '../src/contracts.js';

const msgId='11111111-1111-4111-8111-111111111111'; const token='22222222-2222-4222-8222-222222222222';
function fakeApi(overrides:Partial<AIProcessingApi>={}):AIProcessingApi{return {getState:vi.fn(async(messageId,consumerId)=>({messageId,consumerId,state:'UNREAD',version:0,leaseUntil:null,lastErrorCode:null})),claim:vi.fn(async()=>({state:'CLAIMED',claimToken:token,leaseUntil:'2026-10-17T12:01:00.000Z',attempts:1})),acknowledge:vi.fn(async()=>{}),fail:vi.fn(async()=>{}),recoverable:vi.fn(async()=>[]),pendingEvents:vi.fn(async()=>({items:[],nextCursor:null})),...overrides};}
const media=(mimeType:string,bytes=new TextEncoder().encode('synthetic'))=>({mediaId:'media-synthetic',mimeType,bytes,originalContentRef:'message:synthetic'});
const validResult={text:'processed',provider:'mock' as const,model:'fixture',limitations:[],sourceRef:'message:synthetic'};

describe('AI gateway',()=>{
  it('handles normal and duplicate notifications and recovers missed persisted events',async()=>{
    const api=fakeApi({pendingEvents:vi.fn(async()=>({items:[{id:'event'}],nextCursor:'cursor-1'}))});const consumer=new AIEventConsumer(api);
    const event={id:token,type:'message.captured',aggregateType:'message',aggregateId:msgId,sequence:1,payload:{}};
    expect(await consumer.consume(event)).toEqual({messageId:msgId,duplicate:false});expect(await consumer.consume(event)).toEqual({messageId:msgId,duplicate:false});
    expect(await consumer.consume({...event,type:'conversation.detected'})).toBeUndefined();
    expect(await consumer.consume({...event,aggregateType:'capture-observation'})).toBeUndefined();
    expect(await consumer.recoverMissedEvents()).toMatchObject({nextCursor:'cursor-1'});
  });
  it('uses leases per consumer and ACK is explicit',async()=>{
    const api=fakeApi();const one=new AIMessageStateService(api,'worker-one',5000);const two=new AIMessageStateService(api,'worker-two');
    const claim=await one.claim(msgId);expect(claim.claimToken).toBe(token);expect(api.claim).toHaveBeenCalledWith(msgId,'worker-one',5000,expect.any(String));
    await one.acknowledge(msgId,claim.claimToken);expect(api.acknowledge).toHaveBeenCalledWith(msgId,'worker-one',token,expect.any(String));
    expect(two.consumerId).not.toBe(one.consumerId);
  });
  it('does not ACK after processor failure and records retry for lease recovery',async()=>{
    const api=fakeApi({acknowledge:vi.fn(async()=>{throw new Error('ACK_NETWORK_FAILURE');})});const state=new AIMessageStateService(api,'test-consumer');
    const audit=new AIProcessingAuditService();const worker=new AIProcessingWorker(state,audit,new RetryService({baseDelayMs:1,maxDelayMs:1,maxAttempts:2},()=>0),1000,async()=>{});
    const result=await worker.process({messageId:msgId,process:async()=>validResult});
    expect(result).toBe('RETRY');expect(api.acknowledge).toHaveBeenCalledOnce();expect(api.fail).toHaveBeenCalledWith(msgId,'test-consumer',token,'ACK_NETWORK_FAILURE',expect.any(String));
  });
  it.each([undefined,{}, {text:'incomplete'}])('fails invalid AI result without ACK: %j',async(result)=>{
    const api=fakeApi();
    const worker=new AIProcessingWorker(new AIMessageStateService(api,'invalid-result'),new AIProcessingAuditService(undefined,()=>{}),new RetryService({maxAttempts:1,baseDelayMs:1,maxDelayMs:1}),1000,async()=>{});
    expect(await worker.process({messageId:msgId,process:async()=>result})).toBe('FAILED');
    expect(api.acknowledge).not.toHaveBeenCalled();
    expect(api.fail).toHaveBeenCalledWith(msgId,'invalid-result',token,'AI_RESULT_INVALID',expect.any(String));
  });
  it.each(['resolve','claim','processor','ack'] as const)('retries the same event after a %s failure',async(failure)=>{
    const api=fakeApi();
    const worker=new AIProcessingWorker(new AIMessageStateService(api,'retry-event'),new AIProcessingAuditService(undefined,()=>{}),new RetryService({maxAttempts:2,baseDelayMs:1,maxDelayMs:1}),1000,async()=>{});
    const consumer=new AIEventConsumer(api);
    const event={id:token,type:'message.captured',aggregateType:'message',aggregateId:msgId,sequence:1,payload:{}};
    const process=vi.fn(async()=>validResult);
    const resolve=vi.fn(async()=>({messageId:msgId,process}));
    if(failure==='resolve')resolve.mockRejectedValueOnce(new Error('RESOLVE_FAILED'));
    if(failure==='claim')vi.mocked(api.claim).mockRejectedValueOnce(new Error('CLAIM_FAILED'));
    if(failure==='processor')process.mockRejectedValueOnce(new Error('PROCESSOR_FAILED'));
    if(failure==='ack')vi.mocked(api.acknowledge).mockRejectedValueOnce(new Error('ACK_FAILED'));
    if(failure==='resolve'||failure==='claim')await expect(worker.processEvent(event,consumer,resolve)).rejects.toThrow();
    else expect(await worker.processEvent(event,consumer,resolve)).toBe('RETRY');
    expect(await worker.processEvent(event,consumer,resolve)).toBe('READ');
  });
  it('allows re-resolution after missing work and deduplicates only durable READ state',async()=>{
    const api=fakeApi();const consumer=new AIEventConsumer(api);
    const worker=new AIProcessingWorker(new AIMessageStateService(api,'durable-state'),new AIProcessingAuditService(undefined,()=>{}));
    const event={id:token,type:'message.captured',aggregateType:'message',aggregateId:msgId,sequence:1,payload:{}};
    expect(await worker.processEvent(event,consumer,async()=>undefined)).toBe('IGNORED');
    expect(await worker.processEvent(event,consumer,async()=>({messageId:msgId,process:async()=>validResult}))).toBe('READ');
    vi.mocked(api.getState).mockResolvedValue({messageId:msgId,consumerId:'durable-state',state:'READ',version:2,leaseUntil:null,lastErrorCode:null});
    const resolve=vi.fn();
    expect(await worker.processEvent(event,new AIEventConsumer(api),resolve)).toBe('DUPLICATE');
    expect(resolve).not.toHaveBeenCalled();expect(api.claim).toHaveBeenCalledOnce();
  });
  it('does not downgrade a durable ACK when its audit fails',async()=>{
    const api=fakeApi();
    const worker=new AIProcessingWorker(new AIMessageStateService(api,'audit-failure'),new AIProcessingAuditService(undefined,(entry)=>{if(entry.action==='ACKNOWLEDGED')throw new Error('AUDIT_FAILED');}));
    expect(await worker.process({messageId:msgId,process:async()=>validResult})).toBe('READ');
    expect(api.fail).not.toHaveBeenCalled();
  });
  it('retries with capped jitter and stops at max attempts',()=>{const retry=new RetryService({baseDelayMs:100,maxDelayMs:200,maxAttempts:3},()=>0);expect(retry.nextDelayMs(1)).toBe(80);expect(retry.nextDelayMs(4)).toBe(160);expect(retry.shouldRetry(2)).toBe(true);expect(retry.shouldRetry(3)).toBe(false);});
  it('runs simulated audio, image and text document analysis preserving source references',async()=>{
    const provider=new MockAIProviderAdapter();const audio=await new AudioTranscriptionService(provider).transcribe(media('audio/wav'));const image=await new ImageAnalysisService(provider).analyze(media('image/png'));const document=await new DocumentAnalysisService(provider).analyze(media('text/plain'));
    expect(audio.text).toContain('synthetic');expect(image.sourceRef).toBe('message:synthetic');expect(document.sourceRef).toBe('message:synthetic');
  });
  it('rejects disallowed media and external cloud processing without explicit configuration',async()=>{
    const provider=new HTTPAIProviderAdapter({endpoint:'https://provider.example/api',provider:'cloud',model:'model-x',allowExternalMedia:false,fetchImpl:vi.fn() as typeof fetch});
    await expect(provider.analyze('IMAGE_ANALYSIS',media('image/png'))).rejects.toThrow('EXTERNAL_MEDIA_NOT_AUTHORIZED');
    expect(()=>new ImageAnalysisService(new MockAIProviderAdapter()).analyze(media('application/octet-stream'))).toThrow('MEDIA_TYPE_NOT_ALLOWED');
  });
  it('reports unavailable video analyzer instead of inventing analysis',async()=>{
    const service=new VideoAnalysisService(new MockAIProviderAdapter(),100,1000,{extract:async()=>{throw new Error('VIDEO_ANALYSIS_UNAVAILABLE');}});await expect(service.analyze(media('video/mp4'))).rejects.toThrow('VIDEO_ANALYSIS_UNAVAILABLE');
  });
  it('analyzes synthetic extracted video audio and frame while preserving the source reference',async()=>{
    const provider={provider:'local' as const,acceptsExternalMedia:true,analyze:vi.fn(async(task:'AUDIO_TRANSCRIPTION'|'IMAGE_ANALYSIS',input:{originalContentRef:string})=>({text:`synthetic ${task}`,provider:'local' as const,model:'fixture',limitations:[],sourceRef:input.originalContentRef}))};
    const transcoder={extract:vi.fn(async()=>({audioBytes:new TextEncoder().encode('wav'),frameBytes:new TextEncoder().encode('png')}))};
    const result=await new VideoAnalysisService(provider,1000,1000,transcoder).analyze(media('video/mp4'));
    expect(result.audio?.text).toContain('AUDIO_TRANSCRIPTION');expect(result.frame?.text).toContain('IMAGE_ANALYSIS');expect(result.sourceRef).toBe('message:synthetic');
  });
  it('handles provider timeout explicitly',async()=>{
    const fetchImpl=vi.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')))));
    const provider=new HTTPAIProviderAdapter({endpoint:'http://127.0.0.1:9999',provider:'local',model:'local',allowExternalMedia:true,timeoutMs:100,fetchImpl:fetchImpl as typeof fetch});
    await expect(provider.analyze('AUDIO_TRANSCRIPTION',media('audio/wav'))).rejects.toThrow('AI_PROVIDER_TIMEOUT');
  });
  it('enforces the processing timeout even when a processor ignores cancellation',async()=>{
    const api=fakeApi();const worker=new AIProcessingWorker(new AIMessageStateService(api,'timeout-consumer'),new AIProcessingAuditService(),new RetryService({baseDelayMs:1,maxDelayMs:1,maxAttempts:1},()=>0),10,async()=>{});
    await expect(worker.process({messageId:msgId,process:()=>new Promise(()=>{})})).resolves.toBe('FAILED');
    expect(api.fail).toHaveBeenCalledWith(msgId,'timeout-consumer',token,'AI_PROCESSING_TIMEOUT',expect.any(String));
  });
});
