import { describe,it,expect } from 'vitest';
import { requestContextSchema,auditEventSchema } from './index.js';
const context={actorId:'11111111-1111-4111-8111-111111111111',ownerScopeId:'22222222-2222-4222-8222-222222222222',purpose:'device.register',correlationId:'33333333-3333-4333-8333-333333333333'};
describe('bounded public request and audit metadata',()=>{
 it('requires every request context field',()=>{
  for(const key of Object.keys(context)){
   const incomplete={...context};delete incomplete[key as keyof typeof incomplete];
   expect(requestContextSchema.safeParse(incomplete).success).toBe(false);
  }
  expect(requestContextSchema.parse(context)).toEqual(context);
 });
 it('rejects raw keys and evidence content instead of silently stripping them',()=>{
  expect(requestContextSchema.safeParse({...context,rawObjectKey:'private/key'}).success).toBe(false);
  expect(auditEventSchema.safeParse({policyDecision:'ALLOW',codeVersion:'0.1.0',result:'SUCCESS',objects:[{type:'devices',id:context.actorId,fields:['display_name'],content:'secret'}]}).success).toBe(false);
 });
 it('accepts only typed public object references in audit metadata',()=>{
  const event={policyDecision:'ALLOW',codeVersion:'0.1.0',result:'SUCCESS',objects:[{type:'devices',id:context.actorId,fields:['display_name']}]};
  expect(auditEventSchema.parse(event)).toEqual(event);
  expect(auditEventSchema.safeParse({...event,objects:[{type:'devices',id:'private/key',fields:[]}]}).success).toBe(false);
 });
});

