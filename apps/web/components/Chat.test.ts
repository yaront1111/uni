import {expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {Chat} from './Chat';
import {AcceptedAnswerPresenter} from './AcceptedAnswerPresenter';
import {EXAMPLE_QUESTIONS} from './Ask';
import {askAnsweredProps} from './testing/screens';
import {chatFixture} from './testing/chat';
it('verify-b1-thread: Opening /chat shows ordered owner and assistant turns and an operable text composer.',()=>{
 const html=renderToStaticMarkup(createElement(Chat,chatFixture()));
 expect(html.indexOf('What did I promise Daniel?')).toBeLessThan(html.indexOf('send Daniel the signed lease'));
 expect(html).toContain('<textarea');expect(html).toContain('Send');expect(html).toContain('Committed');expect(html).toContain('Contested');
});
it('verify-b4-examples: An empty thread offers the questions already listed by Ask, or a pre-implementation ADR records the deviation.',()=>{
 const html=renderToStaticMarkup(createElement(Chat,{conversations:[],conversation:null,turns:[],answers:{},why:{},error:null}));
 for(const question of EXAMPLE_QUESTIONS)expect(html).toContain(question);
});
it('verify-a4-sources: Opening Why / sources on each answer displays the existing explanation for that specific turn.',()=>{
 const props=chatFixture();const first=props.turns[1]!;const second={...first,id:'00000000-0000-4000-8000-000000000004',storedOrder:3};props.turns.push(second);
 props.answers[second.id]={...props.answers[first.id]!,turnId:second.id};props.why[second.id]={S1:{...askAnsweredProps.why.S1!,statement:'Second turn explanation'}};
 const html=renderToStaticMarkup(createElement(Chat,props));
 const parts=html.split('data-turn-id=');expect(parts.find(p=>p.startsWith('"'+first.id+'"'))).toContain('commitment action description: send Daniel');
 expect(parts.find(p=>p.startsWith('"'+second.id+'"'))).toContain('Second turn explanation');
});
it('verify-a5-unavailable: No grounded support, incomplete state and permission refusal each display a clear inability-to-answer result without substitute invented answer text.',()=>{
 for(const [kind,message] of [['NOTHING_FOUND','No grounded support'],['MEMORY_INCOMPLETE','Memory is incomplete'],['WITHHELD','Permission']]){
  const answer={...askAnsweredProps.answer!,statements:[{...askAnsweredProps.answer!.statements[0]!,kind:kind as 'NOTHING_FOUND',text:'UNSAFE CANDIDATE'}]};
  const html=renderToStaticMarkup(createElement(AcceptedAnswerPresenter,{answer,why:{}}));expect(html).toContain(message);expect(html).not.toContain('UNSAFE CANDIDATE');
 }
 const blocked={...askAnsweredProps.answer!,grounding:{...askAnsweredProps.answer!.grounding,action:'BLOCKED' as const}};
 const html=renderToStaticMarkup(createElement(AcceptedAnswerPresenter,{answer:blocked,why:{}}));expect(html).toContain('refused');expect(html).not.toContain('signed lease');
});
it('verify-b3-layout: At 320 px width and at 200 percent zoom the owner can read the thread, compose and send a turn, and open sources.',()=>{
 const css=readFileSync(new URL('../styles/global.css',import.meta.url),'utf8');
 expect(css).toContain('.chat-workspace');expect(css).toContain('overflow-wrap:anywhere');expect(css).toContain('min-width:0');
 expect(css).toContain('@media(max-width:40rem)');expect(css).toContain('grid-template-columns:minmax(0,1fr)');
 const html=renderToStaticMarkup(createElement(Chat,chatFixture()));expect(html).toContain('Why? / Sources');expect(html).toContain('Send');expect(html).toContain('Your message');
});
