import { expect, it } from 'vitest';
import { CaptureObservationSchema } from '@wai-bridge/shared';
import { AutomaticContext } from '../../src/identity/automatic-context.js';

it('timestamps the first automatic identity no later than the observation being enriched',()=>{
  const root={dataset:{waiConversationType:'GROUP'},querySelector:()=>({textContent:'Synthetic group'})} as unknown as HTMLElement;
  const doc={querySelectorAll:(selector:string)=>selector.includes('#main')?[root]:[],querySelector:()=>null} as unknown as Document;
  const context=new AutomaticContext('11111111-1111-4111-8111-111111111111',doc);
  const observedAt=new Date(Date.now()-100).toISOString();
  const observation=CaptureObservationSchema.parse({kind:'CAPTURE_OBSERVATION',observationId:'22222222-2222-4222-8222-222222222222',observedAt,observationType:'MESSAGE',captureState:'CAPTURED',conversation:{label:'Synthetic group',kind:'GROUP'},senderLabel:null,direction:'OUTBOUND',content:'Synthetic phone sync',contentAvailability:'AVAILABLE',media:[]});
  const enriched=context.enrich(observation,root);
  expect(CaptureObservationSchema.safeParse(enriched).success).toBe(true);
  expect(enriched.identity?.confirmedAt).toBe(observedAt);
  expect(context.current()).toEqual(enriched.identity);
});
