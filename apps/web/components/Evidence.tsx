import React,{useRef,useState} from 'react';
import type {PublicEvidence} from '@unai/domain';
import {Navigation} from './Navigation';
export function Evidence(props:{evidence:PublicEvidence|null;connector:{connectorType:string;status:string;evidence:PublicEvidence[]}|null;error:string|null}){
  const [busy,setBusy]=useState(false),[error,setError]=useState(props.error??'');
  const attempt=useRef<{file:File;key:string;externalId:string}|null>(null);
  async function upload(event:React.FormEvent<HTMLFormElement>){
    event.preventDefault();setError('');setBusy(true);
    try{
      const data=new FormData(event.currentTarget),file=data.get('document');
      if(!(file instanceof File)||file.size===0||file.size>512*1024)throw new Error('Choose a nonempty document up to 512 KB.');
      if(!attempt.current)attempt.current={file,key:crypto.randomUUID(),externalId:'upload:'+crypto.randomUUID()};
      const {key,externalId}=attempt.current;
      const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
      const response=await fetch('/api/platform/evidence',{method:'POST',headers:{'content-type':'application/json','x-purpose':'evidence.ingest','x-correlation-id':crypto.randomUUID(),'idempotency-key':key},
        body:JSON.stringify({sourceType:'DOCUMENT',connectorId:null,externalId,occurredAt:null,
          content:{base64:btoa(binary),fileName:file.name,mediaType:file.type||'application/octet-stream'},
          sensitivity:data.get('sensitivity'),allowedPurposes:['PERSONAL_ASSISTANCE']})});
      if(response.status===401){window.location.assign('/signin?reason=expired');return;}
      if(!response.ok)throw new Error('The document was not acknowledged as stored. Please retry.');
      const receipt=await response.json();window.location.assign('/sources?evidence='+encodeURIComponent(receipt.evidenceId));
    }catch(e){setError(e instanceof Error?e.message:'The upload could not be completed.');}finally{setBusy(false);}
  }
  return <div className="shell"><a className="skip" href="#content">Skip to content</a>
    <header><a href="/" className="brand">Uai</a><span>Your personal memory</span></header><Navigation current="sources"/>
    <main id="content" tabIndex={-1}><h1>Documents and sources</h1>
      <form className="card" onSubmit={upload}><h2>Upload a document</h2>
        <label htmlFor="document">Document (up to 512 KB)</label><input type="file" name="document" id="document" required disabled={busy} onChange={()=>{attempt.current=null;}}/>
        <label htmlFor="sensitivity">Sensitivity</label><select name="sensitivity" id="sensitivity" defaultValue="PRIVATE" disabled={busy}><option value="NORMAL">Normal</option><option value="PRIVATE">Private</option><option value="RESTRICTED">Restricted</option></select>
        <p>Allowed purpose: personal assistance.</p><p className="muted">Your original document is stored securely. Search and semantic extraction are not available on this screen yet.</p>
        <button disabled={busy} type="submit">{busy?'Storing document…':'Upload document'}</button><p role="status" aria-live="polite">{busy?'Waiting for durable storage confirmation.':''}</p>
      </form>
      {error&&<p role="alert">{error}</p>}
      {props.evidence&&<section className="card"><h2>Source detail</h2><p role="status">Stored. Semantic extraction has not been requested by this upload.</p>
        <dl><dt>Source</dt><dd>{props.evidence.sourceType}</dd><dt>Observed</dt><dd>{props.evidence.observedAt}</dd><dt>Occurred</dt><dd>{props.evidence.occurredAt??'Not supplied'}</dd><dt>Sensitivity</dt><dd>{props.evidence.sensitivity}</dd><dt>Allowed purposes</dt><dd>{props.evidence.allowedPurposes.join(', ')}</dd></dl>
        {props.evidence.connectorId&&<a href={'/sources?connector='+encodeURIComponent(props.evidence.connectorId)}>View connector source detail</a>}
      </section>}
      {props.connector&&<section className="card"><h2>{props.connector.connectorType} source</h2><p>Connection status: {props.connector.status}</p><p>Most recent permitted stored items (up to 50):</p><ul>{props.connector.evidence.map(item=><li key={item.evidenceId}><a href={'/sources?evidence='+encodeURIComponent(item.evidenceId)}>{item.sourceType} · {item.observedAt}</a></li>)}</ul></section>}
    </main></div>;
}
