import React,{useRef,useState} from 'react';
import type {PublicEvidence,DocumentReceipt,DocumentSearchResult} from '@unai/domain';
import {Navigation} from './Navigation';

/** The design screen "Upload a document", plus the source detail the earlier
 * evidence slice delivered.
 *
 * The drawn states are: empty, uploading, stored and immediately searchable with
 * full extraction deferred, full extraction running because the user asked, full
 * extraction running because the document is workflow-related, deadline-bearing
 * or high-value, extraction failed while the document stays retrievable, and an
 * unsupported format stored as source-only evidence. Each is reachable from
 * props, and the copy never claims more than the receipt says. */
const PLAN_TEXT:Record<string,string>={
  USER_REQUESTED:'Full extraction is running because you asked for it.',
  ACTIVE_WORKFLOW_RELATED:'Full extraction is running because this document belongs to an open memory thread.',
  DEADLINE_BEARING:'Full extraction is running because the document carries a deadline.',
  HIGH_VALUE:'Full extraction is running because you classified it as high value.',
  NO_FULL_EXTRACTION_TRIGGER:'Stored and searchable now. Full extraction is deferred until something needs it.',
  UNSUPPORTED_FORMAT_STORED_AS_SOURCE_ONLY:'No text could be read from this format, so it is stored as source-only evidence. It stays retrievable.',
};

const PROCESSING_TEXT:Record<NonNullable<PublicEvidence['processing']>['status'],string>={
  PENDING:'Processing is pending.',EXTRACTED:'Meaning extracted. Preparing memory.',
  CANONICALIZED:'Memory prepared. Checking its support.',GOVERNED:'Memory checks recorded. Updating views.',
  SUCCEEDED:'Processing completed.',NEEDS_REVIEW:'Processing needs review.',
};
function ProcessingStatus({processing}:{processing:PublicEvidence['processing']}){
  return <section aria-label="Source processing"><h3>Processing</h3>
    <p role="status">{processing?PROCESSING_TEXT[processing.status]:'Processing status is not available.'}</p>
    {processing&&processing.unresolvedClaims>0&&<p>{processing.unresolvedClaims} unresolved statement{processing.unresolvedClaims===1?'':'s'}. <a href="/memory/inbox">Review what needs attention</a>.</p>}
    {processing?.lastError&&<p>Processing needs attention. Your stored source is still available. <a href="/ops/jobs">View processing jobs</a>.</p>}
    {processing?.completedAt&&<p>Completed <time dateTime={processing.completedAt}>{processing.completedAt}</time>. Processing does not make the original information more recent.</p>}
  </section>;
}

export function Evidence(props:{
  evidence:PublicEvidence|null;
  connector:{connectorType:string;status:string;evidence:PublicEvidence[]}|null;
  receipt?:DocumentReceipt|null;
  search?:DocumentSearchResult|null;
  /** A later extraction attempt that failed. The stored document is unaffected. */
  extractionFailed?:boolean;
  error:string|null;
}){
  const [busy,setBusy]=useState(false),[error,setError]=useState(props.error??'');
  const [receipt,setReceipt]=useState<DocumentReceipt|null>(props.receipt??null);
  const attempt=useRef<{file:File;key:string;documentId:string}|null>(null);
  async function upload(event:React.FormEvent<HTMLFormElement>){
    event.preventDefault();setError('');setBusy(true);
    try{
      const data=new FormData(event.currentTarget),file=data.get('document');
      if(!(file instanceof File)||file.size===0||file.size>512*1024)throw new Error('Choose a nonempty document up to 512 KB.');
      if(!attempt.current)attempt.current={file,key:crypto.randomUUID(),documentId:'upload-'+crypto.randomUUID()};
      const {key,documentId}=attempt.current;
      const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
      // Text formats are indexed page by page; anything else is stored with its
      // original bytes and no extracted text, which is the source-only state.
      const mediaType=file.type||'application/octet-stream';
      const textual=mediaType.startsWith('text/')||mediaType==='application/json';
      const pages=textual?[{page:1,text:new TextDecoder().decode(bytes)}]:[];
      const response=await fetch('/api/platform/documents',{method:'POST',
        headers:{'content-type':'application/json','x-purpose':'evidence.ingest',
          'x-correlation-id':crypto.randomUUID(),'idempotency-key':key},
        body:JSON.stringify({documentId,title:file.name,mediaType,pages,base64:btoa(binary),
          sensitivity:data.get('sensitivity'),allowedPurposes:['PERSONAL_ASSISTANCE'],
          requestFullExtraction:data.get('requestFullExtraction')==='on',
          valueClassification:data.get('valueClassification')==='on'?'HIGH_VALUE':'ORDINARY'})});
      if(response.status===401){window.location.assign('/signin?reason=expired');return;}
      if(!response.ok)throw new Error('The document was not acknowledged as stored. Please retry.');
      setReceipt(await response.json() as DocumentReceipt);
    }catch(e){setError(e instanceof Error?e.message:'The upload could not be completed.');}finally{setBusy(false);}
  }
  return <div className="shell"><a className="skip" href="#content">Skip to content</a>
    <header><a href="/" className="brand">Uai</a><span>Your personal memory</span></header><Navigation current="sources"/>
    <main id="content" tabIndex={-1}><h1>Documents and sources</h1>
      <form className="card" onSubmit={upload}><h2>Upload a document</h2>
        <label htmlFor="document">Document (up to 512 KB)</label><input type="file" name="document" id="document" required disabled={busy} onChange={()=>{attempt.current=null;}}/>
        <label htmlFor="sensitivity">Sensitivity</label><select name="sensitivity" id="sensitivity" defaultValue="PRIVATE" disabled={busy}><option value="NORMAL">Normal</option><option value="PRIVATE">Private</option><option value="RESTRICTED">Restricted</option></select>
        <label htmlFor="requestFullExtraction"><input type="checkbox" name="requestFullExtraction" id="requestFullExtraction" disabled={busy}/> Extract meaning from this document now</label>
        <label htmlFor="valueClassification"><input type="checkbox" name="valueClassification" id="valueClassification" disabled={busy}/> This is a high-value document</label>
        <p>Allowed purpose: personal assistance.</p>
        <p className="muted">Your original document is stored securely and its text is searchable as soon as it is stored. Meaning is extracted later unless you ask now, the document belongs to an open thread, carries a deadline, or is high value.</p>
        <button disabled={busy} type="submit">{busy?'Storing document…':'Upload document'}</button>
        <p role="status" aria-live="polite">{busy?'Uploading. Waiting for durable storage confirmation.':''}</p>
      </form>
      {error&&<p role="alert">{error}</p>}
      {receipt&&<section className="card"><h2>Upload receipt</h2>
        <p role="status">Stored. {receipt.indexedAnchors} page(s) indexed and searchable immediately.</p>
        <p>{PLAN_TEXT[receipt.extractionPlanReason]??receipt.extractionPlanReason}</p>
        <dl><dt>Extraction plan</dt><dd>{receipt.extractionPlan}</dd>
          <dt>Triage route</dt><dd>{receipt.triageRoute}</dd>
          <dt>Queued extraction job</dt><dd>{receipt.extractionJobId??'None queued'}</dd></dl>
        {props.extractionFailed&&<p role="alert">Extraction failed. The stored document is unchanged and stays retrievable and searchable.</p>}
        <a href={'/sources?evidence='+encodeURIComponent(receipt.evidenceId)}>View source detail</a>
      </section>}
      {props.search&&<section className="card"><h2>Search stored documents</h2>
        <form method="GET" action="/sources"><label htmlFor="q">Search your documents</label>
          <input type="search" name="q" id="q" defaultValue={props.search.query}/><button type="submit">Search</button></form>
        {props.search.hits.length===0
          ?<p role="status">No stored document matches that text.</p>
          :<ul>{props.search.hits.map(hit=><li key={hit.evidenceId+':'+String(hit.page)}>
            <a href={'/sources?evidence='+encodeURIComponent(hit.evidenceId)}>Page {hit.page??1}</a>
            <p>{hit.excerpt}</p>
            <p>Meaning extraction: {hit.extractionPlan==='FULL'?'requested':'deferred'}</p>
          </li>)}</ul>}
      </section>}
      {props.evidence&&<section className="card"><h2>Source detail</h2><p>Source stored.</p><ProcessingStatus processing={props.evidence.processing}/>
        <dl><dt>Source</dt><dd>{props.evidence.sourceType}</dd><dt>Observed</dt><dd>{props.evidence.observedAt}</dd><dt>Occurred</dt><dd>{props.evidence.occurredAt??'Not supplied'}</dd><dt>Sensitivity</dt><dd>{props.evidence.sensitivity}</dd><dt>Allowed purposes</dt><dd>{props.evidence.allowedPurposes.join(', ')}</dd></dl>
        {props.evidence.connectorId&&<a href={'/connectors?connector='+encodeURIComponent(props.evidence.connectorId)}>View connected source</a>}
      </section>}
      {props.connector&&<section className="card"><h2>{props.connector.connectorType} source</h2><p>Connection status: {props.connector.status}</p><p>Most recent permitted stored items (up to 50):</p><ul>{props.connector.evidence.map(item=><li key={item.evidenceId}><a href={'/sources?evidence='+encodeURIComponent(item.evidenceId)}>{item.sourceType} · {item.observedAt}</a></li>)}</ul></section>}
    </main></div>;
}
