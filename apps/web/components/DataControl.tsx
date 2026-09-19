import React, {useState} from 'react';
import type {CascadeCounts, DeletionReceipt} from '@unai/domain';
import {Navigation} from './Navigation';
import {platformWrite, RefusedWrite} from './controlWrite';

/** The design screen "Export and delete my data" (PRD §7.8, §30.7;
 * CRT-NFR-04-A, CRT-SEC-06-A).
 *
 * The drawn states -- idle, export requested, export ready, embeddings deleted
 * and regenerated, the deletion scope confirmation, deletion running, deletion
 * complete with its cascade receipt, and the "no longer retrievable" statement --
 * are all reachable from props, because the component tests render static markup
 * and never run a handler. */
export type DataControlState = 'IDLE' | 'EXPORT_REQUESTED' | 'EXPORT_READY' | 'REINDEXED' | 'CONFIRM_DELETION'
  | 'DELETING' | 'DELETED';
export interface DataControlProps {
  state: DataControlState;
  exportSummary: {requestId: string; counts: Record<string, number>} | null;
  reindex: {dropped: number; indexed: number} | null;
  /** What the deletion would remove, counted inside a rolled-back cascade. */
  preview: DeletionReceipt | null;
  receipt: DeletionReceipt | null;
  error: string | null;
}

const CASCADE_LABELS: [keyof CascadeCounts, string][] = [
  ['rawObjects', 'Raw objects'], ['parsedContent', 'Parsed content'], ['anchors', 'Source anchors'],
  ['claims', 'Claims'], ['unsupportedBeliefs', 'Beliefs left with no support'], ['embeddings', 'Embeddings'],
  ['summaries', 'Summaries'], ['searchIndexEntries', 'Search index entries'], ['projectionRows', 'Projection rows'],
  ['resolutionAssertions', 'Resolution assertions'], ['threadMemberships', 'Memory thread memberships'],
  ['aliases', 'Entity aliases taken from it'],
];
const REFUSAL_TEXT: Record<string, string> = {
  EVIDENCE_NOT_FOUND: 'That item is not in your memory, or it was already deleted.',
  CONTROL_REQUEST_INVALID: 'Enter one or more item identifiers, and type DELETE to confirm.',
  DELETION_STORAGE_UNAVAILABLE: 'Deletion is unavailable because object storage cannot be reached. Nothing was deleted.',
  EXPORT_STORAGE_UNAVAILABLE: 'Export is unavailable because object storage cannot be reached.',
};

function Cascade({counts}: {counts: CascadeCounts}) {
  return <dl>{CASCADE_LABELS.map(([key, label]) => <React.Fragment key={key}><dt>{label}</dt><dd>{counts[key]}</dd></React.Fragment>)}</dl>;
}

export function DataControl(props: DataControlProps) {
  const [state, setState] = useState<DataControlState>(props.state);
  const [error, setError] = useState(props.error ?? '');
  const [exportSummary, setExportSummary] = useState(props.exportSummary);
  const [reindex, setReindex] = useState(props.reindex);
  const [preview, setPreview] = useState(props.preview);
  const [receipt, setReceipt] = useState(props.receipt);
  const [ids, setIds] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const evidenceIds = () => ids.split(/[\s,]+/).map(value => value.trim()).filter(Boolean);
  async function run(next: DataControlState, action: () => Promise<void>) {
    setError(''); setState(next);
    try {await action();}
    catch (caught) {
      setState('IDLE');
      setError(caught instanceof RefusedWrite ? REFUSAL_TEXT[caught.code] ?? 'The request was refused. Nothing was changed.'
        : 'The request could not be completed. Please retry.');
    }
  }
  const exportData = () => run('EXPORT_REQUESTED', async () => {
    const answer = await platformWrite('export', 'data.export', {scope: 'ALL', includeRawEvidence: true});
    if (!answer) return;
    const bundle = answer['bundle'] as {counts: Record<string, number>};
    // The bundle is handed to the owner as a file and kept nowhere else.
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(bundle)], {type: 'application/json'}));
    link.download = 'uai-export-' + String(answer['requestId']) + '.json';
    link.click();
    setExportSummary({requestId: String(answer['requestId']), counts: bundle.counts});
    setState('EXPORT_READY');
  });
  const regenerate = () => run('IDLE', async () => {
    const dropped = await platformWrite('memory/embeddings/regenerate', 'memory.reindex', {dropExisting: true, regenerate: false});
    const rebuilt = await platformWrite('memory/embeddings/regenerate', 'memory.reindex', {dropExisting: false, regenerate: true});
    if (!dropped || !rebuilt) return;
    setReindex({dropped: Number(dropped['dropped']), indexed: Number(rebuilt['indexed'])});
    setState('REINDEXED');
  });
  const review = () => run('IDLE', async () => {
    const answer = await platformWrite('data/deletions/preview', 'data.delete', {evidenceIds: evidenceIds()});
    if (!answer) return;
    setPreview(answer as unknown as DeletionReceipt);
    setState('CONFIRM_DELETION');
  });
  const erase = () => run('DELETING', async () => {
    const answer = await platformWrite('data/deletions', 'data.delete', {evidenceIds: preview?.evidenceIds ?? evidenceIds(), confirmation});
    if (!answer) return;
    setReceipt(answer as unknown as DeletionReceipt);
    setState('DELETED');
  });
  return <div className="shell"><a className="skip" href="#content">Skip to content</a>
    <header><a href="/" className="brand">Uai</a><span>Your personal memory</span></header>
    <Navigation current="data"/>
    <main id="content" tabIndex={-1}>
      <h1>Export and delete my data</h1>
      {error && <p role="alert">{error}</p>}

      <section className="card" aria-labelledby="export-heading"><h2 id="export-heading">Export</h2>
        <p>A file with your raw evidence and your canonical memory: entities, situations, beliefs, claims, assessments,
          support, resolutions, links, threads and summaries. It contains no storage keys or credentials.</p>
        {state === 'IDLE' && <p>No export in progress.</p>}
        {state === 'EXPORT_REQUESTED' && <p role="status" aria-live="polite">Export requested. Preparing your file.</p>}
        {state === 'EXPORT_READY' && exportSummary && <div role="status" aria-live="polite">
          <p>Export ready, containing raw evidence and canonical memory objects.</p>
          <dl>{Object.entries(exportSummary.counts).map(([key, value]) =>
            <React.Fragment key={key}><dt>{key}</dt><dd>{value}</dd></React.Fragment>)}</dl>
        </div>}
        <button type="button" disabled={state === 'EXPORT_REQUESTED' || state === 'DELETING'} onClick={exportData}>Export my data</button>
      </section>

      <section className="card" aria-labelledby="index-heading"><h2 id="index-heading">Search index</h2>
        <p>Embeddings are an index, never memory. Deleting them all and regenerating them from canonical memory
          restores the same semantic search results.</p>
        {state === 'REINDEXED' && reindex && <p role="status" aria-live="polite">
          Embeddings deleted ({reindex.dropped}) and regenerated ({reindex.indexed}). Semantic search results are restored.</p>}
        <button type="button" disabled={state === 'DELETING'} onClick={regenerate}>Delete and regenerate embeddings</button>
      </section>

      <section className="card" aria-labelledby="delete-heading"><h2 id="delete-heading">Delete</h2>
        {state !== 'CONFIRM_DELETION' && state !== 'DELETING' && state !== 'DELETED' && <>
          <label htmlFor="delete-ids">Evidence items to delete (identifiers from Documents or the Memory inspector)</label>
          <input id="delete-ids" value={ids} onChange={event => setIds(event.target.value)}/>
          <button type="button" disabled={evidenceIds().length === 0} onClick={review}>Review what will be removed</button>
        </>}
        {state === 'CONFIRM_DELETION' && preview && <div>
          <h3>Deletion scope</h3>
          <p>Deleting {preview.evidenceIds.length} item(s) will permanently remove:</p>
          <Cascade counts={preview.cascade}/>
          <p>Nothing has been deleted yet.</p>
          <label htmlFor="delete-confirm">Type DELETE to confirm</label>
          <input id="delete-confirm" value={confirmation} onChange={event => setConfirmation(event.target.value)}/>
          <button type="button" disabled={confirmation !== 'DELETE'} onClick={erase}>Delete permanently</button>
        </div>}
        {state === 'DELETING' && <p role="status" aria-live="polite">Deletion running.</p>}
        {state === 'DELETED' && receipt && <div role="status" aria-live="polite">
          <p>Deletion complete. Cascade receipt:</p>
          <Cascade counts={receipt.cascade}/>
          <p>Projections rebuilt from what remains: {receipt.projectionsRebuilt.join(', ') || 'none'}.</p>
          <p>The deleted items are no longer retrievable by any API or search. The audit record keeps only
            identifiers and field names, with no payload content.</p>
        </div>}
      </section>
    </main></div>;
}
