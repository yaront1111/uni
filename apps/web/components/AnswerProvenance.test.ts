import { expect,it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SUPPLIED_CONTEXT_STATEMENT,publicAnswerManifestSchema,type PublicAnswerManifest } from '@unai/domain';
import * as screen from './AnswerProvenance';

/** The Answer provenance screen: one assertion per drawn state, the skip link,
 * and CRT-RD-07-A over the markup -- nothing on it says which item the model
 * used, relied on or was based on. */

const id=(n:number)=>'0192f3a0-0000-7000-8000-'+String(n).padStart(12,'0');
const manifest:PublicAnswerManifest=publicAnswerManifestSchema.parse({
  answerManifestId:id(1),recordKind:'CONTEXT_SUPPLIED_TO_MODEL',recordStatement:SUPPLIED_CONTEXT_STATEMENT,
  question:'Do I still owe Daniel?',
  contextSupplied:{packetId:id(2),packetHash:'a'.repeat(64),beliefIds:[id(3),id(4)],claimIds:[id(5)],evidenceIds:[id(6)],
    overlayDeltaIds:[id(7)],projectionVersions:{obligations_projection:id(8)},
    watermarks:{ownerOverlayWatermark:4,canonicalTransactionWatermark:'2026-03-01T09:00:00.000Z',
      projectionVersions:{obligations_projection:id(8)},registryRelease:'0.1.0'},
    registryRelease:'0.1.0',registryReleaseId:id(9)},
  suppliedTo:{modelProvider:'anthropic',modelId:'claude-sonnet-5',promptVersion:'answer-phrasing-0.1.0',composerVersion:'ask-composer-0.1.0'},
  conversationMessageId:id(10),
  groundingValidator:{validatorVersion:'grounding-validator-0.1.0',action:'DOWNGRADED',finalSource:'MODEL',
    attempts:[{attempt:1,candidateSource:'MODEL',outcome:'DOWNGRADED',violations:[]}],violations:[]},
  reconsideration:{isCandidate:false,changes:[]},
  manifestVersion:'answer-manifest-0.1.0',createdAt:'2026-03-02T09:00:00.000Z',
});
const render=(props:Partial<screen.AnswerProvenanceProps>)=>
  renderToStaticMarkup(createElement(screen.AnswerProvenance,{manifest:null,...props}));
/** Words that would assert which item the model used. The one fixed sentence that
 * says the record does *not* know that is removed before the check. */
const USE_CLAIMS=/\bused\b|\buses\b|relied|reliance|based on|drew on|attribut|contribut|influenc|most relevant|cited by the model/i;

it('lists the context supplied to the model: ids, projection versions, watermarks, release, model and prompt, packet id and hash',()=>{
  const html=render({manifest});
  expect(html).toContain('Answer provenance');
  expect(html).toContain('Context supplied to the model');
  for(const value of [id(2),'a'.repeat(64),id(3),id(4),id(5),id(6),id(7),id(8),'obligations_projection','ownerOverlayWatermark',
    '2026-03-01T09:00:00.000Z','0.1.0','claude-sonnet-5','anthropic','answer-phrasing-0.1.0'])expect(html,value).toContain(value);
  expect(html).toContain('Beliefs supplied (2)');
  expect(html).toContain('Evidence supplied (1)');
  expect(html).toContain('Downgraded: some wording was made less certain');
  expect(html).toContain('Skip to content');
});

it('states that it records the context supplied and not which item the model used, and asserts no use anywhere else',()=>{
  const html=render({manifest});
  expect(html).toContain(SUPPLIED_CONTEXT_STATEMENT);
  expect(html.replace(SUPPLIED_CONTEXT_STATEMENT,'')).not.toMatch(USE_CLAIMS);
  expect(html).not.toMatch(/Reconsider:/);
  expect(html).toContain('No belief supplied in this context has changed materially');
});

it('shows the reconsideration badge after a belief in this packet changed materially, in words',()=>{
  const html=render({manifest:{...manifest,reconsideration:{isCandidate:true,changes:[{changedObjectType:'belief',
    changedObjectId:id(3),changeKind:'CLAIM_CORRECTED',detectedAt:'2026-03-05T10:00:00.000Z'}]}}});
  expect(html).toContain('Reconsider: context in this answer has changed');
  expect(html).toContain('A claim behind it was corrected');
  expect(html).toContain('role="status"');
  expect(html).toContain('The answer itself is kept');
  expect(html.replace(SUPPLIED_CONTEXT_STATEMENT,'')).not.toMatch(USE_CLAIMS);
});

it('renders a refusal as a fixed sentence and no manifest',()=>{
  const html=render({error:'That is not an answer this memory recorded.'});
  expect(html).toContain('role="alert"');
  expect(html).toContain('That is not an answer this memory recorded.');
  expect(html).not.toContain('Items supplied');
});
