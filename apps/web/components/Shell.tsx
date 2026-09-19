import React from 'react';
import {Navigation} from './Navigation';

/**
 * The web shell (design "nextjs web application shell with accessible design
 * system"; non-functional accessibility requirements).
 *
 * One layout for the product screens: a skip link to the main content, the
 * banner, the main navigation, one `main` landmark that can take focus, the
 * content info footer, and a polite live region the screen fills with the state
 * of anything asynchronous (an answer being prepared, a briefing loading). Every
 * landmark is a native element with its own role, so the structure is the same
 * with or without assistive technology.
 */
export interface ShellProps{
  current:React.ComponentProps<typeof Navigation>['current'];
  eyebrow:string;
  title:string;
  /** What the live region announces: a loading or completed state. */
  status?:string;
  footer?:string;
  children:React.ReactNode;
}

export function Shell(props:ShellProps){
  return <div className="shell">
    <a className="skip" href="#content">Skip to content</a>
    <header><a href="/" className="brand">Uai</a><span>Your personal memory</span></header>
    <Navigation current={props.current}/>
    <main id="content" tabIndex={-1} aria-labelledby="page-title">
      <p className="eyebrow">{props.eyebrow}</p>
      <h1 id="page-title">{props.title}</h1>
      <div className="live" role="status" aria-live="polite" aria-atomic="true">{props.status??''}</div>
      {props.children}
    </main>
    <footer>{props.footer??'Uai shows what your memory holds and how sure it is. It never acts for you without your approval.'}</footer>
  </div>;
}
