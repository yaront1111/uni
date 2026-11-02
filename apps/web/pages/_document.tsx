import Document,{Html,Head,Main,NextScript,type DocumentContext} from 'next/document';

/** The document every page is served in. Its language is declared so a screen
 * reader speaks the product's English copy with the right voice and rules
 * (WCAG 3.1.1; CRT-UX-14-A). Head and NextScript carry the request's CSP nonce,
 * which `lib/security-headers.ts` writes to the `x-nonce` request header; a
 * page prerendered at build time (Next's 404 and 500) has no request and so no
 * nonce. */
export default class UaiDocument extends Document<{nonce?:string}>{
  static async getInitialProps(ctx:DocumentContext){
    const initial=await Document.getInitialProps(ctx);
    const value=ctx.req?.headers['x-nonce'];
    return typeof value==='string'&&/^[A-Za-z0-9+/]{22}==$/.test(value)?{...initial,nonce:value}:initial;
  }
  render(){
    return <Html lang="en"><Head nonce={this.props.nonce}/><body><Main/><NextScript nonce={this.props.nonce}/></body></Html>;
  }
}
