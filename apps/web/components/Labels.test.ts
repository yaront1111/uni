import {expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {memoryLabelSchema,type MemoryLabel} from '@unai/domain';
import {CertaintyBadge,LabelKey,MEMORY_LABELS,displayLabelOf,withoutIdentifiers} from './Labels';

/** CRT-UX-12-A: confirmed, reported, inferred, contested, pending owner
 * assertion, scheduled and resolved render with distinct text and icon labels
 * that stay distinguishable in a grayscale rendering. */

const REQUIRED:MemoryLabel[]=['CONFIRMED','REPORTED','INFERRED','CONTESTED','PENDING_OWNER_ASSERTION','SCHEDULED','RESOLVED'];
const badge=(label:MemoryLabel)=>renderToStaticMarkup(createElement(CertaintyBadge,{label}));
/** What survives a grayscale rendering of a badge: its words and its glyph. Every
 * attribute (class, colour, title) is dropped, so nothing that could only be told
 * apart by hue is left to tell them apart. */
const grayscaleCues=(html:string)=>html.replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim();

it('renders the seven memory states with distinct words, distinct glyphs and distinct border patterns',()=>{
  const rendered=REQUIRED.map(badge);
  for(const [index,label] of REQUIRED.entries()){
    expect(rendered[index]).toContain(MEMORY_LABELS[label].text);
    expect(rendered[index]).toContain('aria-hidden="true">'+MEMORY_LABELS[label].glyph);
    expect(rendered[index]).toContain('data-label="'+label+'"');
  }
  expect(new Set(REQUIRED.map(label=>MEMORY_LABELS[label].text)).size).toBe(REQUIRED.length);
  expect(new Set(REQUIRED.map(label=>MEMORY_LABELS[label].glyph)).size).toBe(REQUIRED.length);
  expect(new Set(REQUIRED.map(label=>MEMORY_LABELS[label].pattern)).size).toBe(REQUIRED.length);
  // The whole vocabulary is distinct, not only the seven.
  const all=memoryLabelSchema.options;
  expect(new Set(all.map(label=>MEMORY_LABELS[label].text)).size).toBe(all.length);
  expect(new Set(all.map(label=>MEMORY_LABELS[label].glyph)).size).toBe(all.length);
  expect(new Set(all.map(label=>MEMORY_LABELS[label].pattern)).size).toBe(all.length);
});

it('stays distinguishable in a grayscale rendering: no label depends on colour',()=>{
  const cues=REQUIRED.map(label=>grayscaleCues(badge(label)));
  expect(new Set(cues).size).toBe(REQUIRED.length);
  for(const cue of cues)expect(cue.length).toBeGreaterThan(3);
  // No badge carries a colour of its own.
  for(const label of memoryLabelSchema.options)expect(badge(label)).not.toMatch(/style=|color|colour/i);
  // The stylesheet draws every label rule in black, grey and white only, so the
  // grayscale rendering is the same rendering.
  const css=readFileSync(resolve('apps/web/styles/global.css'),'utf8');
  const rules=css.match(/\.label[^{]*\{[^}]*\}/g)??[];
  expect(rules.length).toBeGreaterThan(REQUIRED.length);
  for(const rule of rules){
    for(const hex of rule.match(/#[0-9a-f]{6}\b/gi)??[]){
      const [r,g,b]=[1,3,5].map(offset=>hex.slice(offset,offset+2).toLowerCase());
      expect(r===g&&g===b,rule+' uses '+hex).toBe(true);
    }
    expect(rule).not.toMatch(/rgb|hsl|\b(red|green|blue|orange|yellow|purple)\b/i);
  }
  // Each pattern class has a rule, and the patterns are border styles a grayscale
  // rendering keeps.
  for(const label of REQUIRED)expect(css).toContain('.label-'+MEMORY_LABELS[label].pattern+'{');
});

it('announces each label in words and describes it in the key',()=>{
  const html=renderToStaticMarkup(createElement(LabelKey,{labels:REQUIRED}));
  expect(html).toContain('<details');
  expect(html).toContain('What the labels mean');
  for(const label of REQUIRED)expect(html).toContain(MEMORY_LABELS[label].description);
});

it('maps Ask statements onto the labels a reader sees',()=>{
  expect(displayLabelOf({label:'CONFLICTING',kind:'CONFLICT'})).toBe('CONTESTED');
  expect(displayLabelOf({label:'REPORTED',kind:'OWNER_ASSERTION_PENDING'})).toBe('PENDING_OWNER_ASSERTION');
  expect(displayLabelOf({label:'CONFIRMED',kind:'RESOLUTION'})).toBe('RESOLVED');
  expect(displayLabelOf({label:'SCHEDULED',kind:'SELECTED_STATE'})).toBe('SCHEDULED');
  expect(displayLabelOf({label:'INFERRED',kind:'SELECTED_STATE'})).toBe('INFERRED');
});

it('keeps technical identifiers out of the reading path',()=>{
  expect(withoutIdentifiers('entity 0192f3a0-0000-7000-8000-000000000001 owes')).toBe('entity (see the advanced inspector) owes');
});
