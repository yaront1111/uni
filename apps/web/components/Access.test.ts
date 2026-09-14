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
it('renders an accessible device registration form and common navigation',()=>{
  expect(access).toHaveProperty('Access');
  const html=renderToStaticMarkup(createElement(access.Access,{state:'desktop',devices:[],registered:false}));
  expect(html).toContain('Register this device');
  expect(html).toContain('Device name');
  expect(html).toContain('Skip to content');
  expect(html).toContain('Weekly Review');
});
