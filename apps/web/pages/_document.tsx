import {Html,Head,Main,NextScript} from 'next/document';

/** The document every page is served in. Its language is declared so a screen
 * reader speaks the product's English copy with the right voice and rules
 * (WCAG 3.1.1; CRT-UX-14-A). */
export default function Document(){
  return <Html lang="en"><Head/><body><Main/><NextScript/></body></Html>;
}
