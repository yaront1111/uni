import {expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as access from './Access';
import {Evidence} from './Evidence';
it('links the authenticated common navigation to the designed upload screen',()=>{
  const html=renderToStaticMarkup(createElement(access.Access,{state:'desktop',devices:[],registered:true}));
  expect(html).toContain('href="/sources"');expect(html).toContain('Documents');
});
it('renders a labeled upload form and truthful storage/processing state',()=>{
  const html=renderToStaticMarkup(createElement(Evidence,{evidence:null,connector:null,error:'Upload failed'}));
  expect(html).toContain('type="file"');expect(html).toContain('for="document"');
  expect(html).toContain('Allowed purpose: personal assistance');
  expect(html).toContain('Search and semantic extraction are not available');
  expect(html).toContain('role="alert"');expect(html).toContain('Upload failed');
});
