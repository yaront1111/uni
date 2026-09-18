import { expect,it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as access from './Access';
it.each([
  ['signed-out','Sign in with Google'],['signing-in','Signing in'],
  ['expired','Your session expired'],['refused','Sign-in was refused'],
  ['desktop','Signed in on desktop'],['phone','Signed in on phone'],
])('renders the designed %s state with text', (state,label)=>{
  expect(access).toHaveProperty('Access');
  const html=renderToStaticMarkup(createElement(access.Access,{state:state as access.AccessState,devices:[],registered:true}));
  expect(html).toContain(label);
});
it('renders the single active personal owner scope selector when signed in',()=>{
  const owner='6e6f8a40-6f0d-7b9a-8f6a-2c1a6e2f0000';
  const html=renderToStaticMarkup(createElement(access.Access,{state:'desktop',devices:[],registered:true,ownerScopeId:owner}));
  expect(html).toContain('Owner scope');
  expect(html).toContain('Active workspace');
  expect(html).toContain('Personal workspace');
  expect(html).toContain(owner);
  expect(html).toContain('exactly one active personal owner scope');
  expect(renderToStaticMarkup(createElement(access.Access,{state:'signed-out',devices:[],registered:false,ownerScopeId:owner})))
    .not.toContain('Active workspace');
});
it('renders an accessible device registration form and common navigation',()=>{
  expect(access).toHaveProperty('Access');
  const html=renderToStaticMarkup(createElement(access.Access,{state:'desktop',devices:[],registered:false}));
  expect(html).toContain('Register this device');
  expect(html).toContain('Device name');
  expect(html).toContain('Skip to content');
  expect(html).toContain('Weekly Review');
});
