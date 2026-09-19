import type {MemoryInspector as Inspection} from '@unai/domain';

/** One inspected belief for the screen tests: an accepted amount with a competing
 * value, a claim with its four confidences, a derivation, a thread, an access
 * and a recorded operation. Test data only; no page imports it. */
const id=(n:number)=>'0192f3a0-0000-7000-8000-'+String(n).padStart(12,'0');
const at='2026-09-18T10:00:00.000Z';
export function inspection(over:Partial<Inspection>={},explanation:Partial<Inspection['explanation']>={}):Inspection{
  return {
    subject:{requestedType:'proposition',requestedId:id(1),propositionId:id(1),correctionTarget:{objectType:'proposition',objectId:id(1)}},
    explanation:{propositionId:id(1),beliefSlotId:id(2),frameInstanceId:id(3),frameTypeId:'shared.obligation',
      predicateId:'shared.obligation.principal_amount',modality:'ACTUAL',polarity:'POSITIVE',normalizedValue:{amount:'500.00',currency:'ILS'},
      currentAssessment:{assessmentId:id(4),assessmentStatus:'ACCEPTED',recordedAt:at,policyVersion:'local-policy-0.1.0',decisionReason:{code:'X'}},
      claims:[{claimId:id(5),claimOrigin:'USER_STATEMENT',lifecycle:'PROVISIONAL',assertedByEntityId:id(6),extractionRunId:id(7),recordedAt:at,validFrom:null,validTo:null}],
      evidenceAnchors:[],supportGraph:[],independenceGroups:[],
      contradictions:[{kind:'COMPETING_PROPOSITION',objectType:'propositions',objectId:id(8),relation:'SAME_SLOT_DIFFERENT_VALUE',detail:'COMPETING_LIVE_PROPOSITIONS_IN_ONE_SLOT'}],
      temporalHistory:[{assessmentId:id(9),assessmentStatus:'PROVISIONAL',validFrom:'2026-03-01T00:00:00.000Z',validTo:null,recordedAt:'2026-03-01T09:00:00.000Z',
        supersededRecordedAt:at,transactionId:id(10)},{assessmentId:id(4),assessmentStatus:'ACCEPTED',validFrom:'2026-03-01T00:00:00.000Z',
        validTo:null,recordedAt:at,supersededRecordedAt:null,transactionId:id(11)}],
      resolutionLinks:[{objectType:'resolution_assertion',objectId:id(12),linkKind:null,outcomeCode:'PARTIALLY_FULFILLED',effectiveAt:at,lifecycle:'ACCEPTED'}],
      registryVersions:{registryReleaseId:id(13),registryRelease:'0.1.0',normalizationVersion:'normalization-1',canonicalizationVersion:'canonicalization-0.1.0'},
      extractorVersions:[{extractionRunId:id(7),runKind:'TARGETED',modelId:'claude-sonnet-5',promptVersion:'extract-v3',normalizationVersion:'normalization-1',
        entityResolverVersion:'entity-resolver-1',temporalResolverVersion:'temporal-resolver-1',registryReleaseId:id(13)}],
      projectionConsumers:[],ownerOverlayDeltas:[],explanationVersion:'belief-explanation-0.1.0',readAt:at,...explanation},
    assertingActors:[{entityId:id(6),entityKind:'PERSON',canonicalLabel:'Me'}],
    claimConfidences:[{claimId:id(5),extraction:0.9,entityResolution:0.8,temporalResolution:null,instanceResolution:0.7}],
    originalEvidence:[{evidenceId:id(14),sourceType:'CONVERSATION',sensitivity:'PRIVATE',occurredAt:'2026-03-01T08:00:00.000Z',observedAt:at,
      anchors:[{sourceAnchorId:id(15),anchorKind:'MESSAGE_SPAN',text:'I borrowed ILS 500 from Daniel'}]}],
    withheldEvidenceCount:0,
    inferences:[{dependencyId:id(16),role:'INPUT_TO_DERIVED',derivedPropositionId:id(17),derivedAssessmentStatus:'ACCEPTED',inputClaimIds:[id(5)],
      inputPropositionIds:[],evaluatorId:'finance.obligation_remaining',modelOrCodeVersion:'obligations-capability-0.1.0',registryReleaseId:id(13),createdAt:at}],
    connectedThreads:[{memoryThreadId:id(18),displayTitle:'Daniel payment',lifecycle:'ACTIVE',membershipKind:'SUBJECT',memberObjectType:'frame_instance'}],
    accessHistory:[{kind:'AUDIT_EVENT',id:id(19),at,purpose:'memory.read',result:'SUCCESS',fields:['normalized_value']},
      {kind:'ANSWER_MANIFEST',id:id(20),at:'2026-09-17T10:00:00.000Z',purpose:null,result:null,fields:['belief_ids']}],
    memoryOperations:[{memoryOperationId:id(21),operationKind:'CONFIRM',target:{objectType:'proposition',objectId:id(1)},overlayDeltaId:id(22),
      transactionId:null,createdAt:at}],
    inspectorVersion:'memory-inspector-0.1.0',readAt:at,...over,
  };
}
