import React from 'react';
import type {LoadedRegistryRelease,PublicRegistryContract,PublicShadowRun,RegistryLintReport,RegistryMigrationStatus} from '@unai/domain';
import {Navigation} from './Navigation';

export interface RegistryProps {
  /** The release the runtime is pinned to, read from the materialized snapshot. */
  release:LoadedRegistryRelease|null;
  contracts:PublicRegistryContract[];
  /** The report `uai registry lint --report` wrote, when the deployment keeps one.
   * Lint runs in the CLI and in CI; no request ever lints (CRT-REG-01-B). */
  lint?:RegistryLintReport|null;
  /** Recorded shadow evaluation runs, newest first; null when they could not be read. */
  shadowRuns?:PublicShadowRun[]|null;
  error?:string;
}
const kindLabels:Record<PublicRegistryContract['contractKind'],string>={
  FRAME:'Frame',PREDICATE:'Predicate',TRANSITION:'Transition',
};
/** Each refusal states what failed in words; status is never colour alone. */
const issueLabels:Record<string,string>={
  REGISTRY_FIELD_REQUIRED:'Required contract field missing',
  REGISTRY_FIELD_UNKNOWN:'Unknown contract field',
  REGISTRY_FIELD_INVALID:'Contract field value not accepted',
  REGISTRY_CARDINALITY_INVALID:'Cardinality outside FUNCTIONAL, SET and EVENT',
  OUTCOME_STATUS_PREDICATE_FORBIDDEN:'Outcome status predicate: outcome state belongs to resolution assertions',
  OBLIGATION_PRINCIPAL_NOT_MONETARY:'Obligation principal is not monetary',
  REGISTRY_MIGRATION_MANIFEST_REQUIRED:'Migration manifest missing for an identity-, transition-affecting or breaking change',
  REGISTRY_MIGRATION_MANIFEST_INVALID:'Migration manifest does not describe this release pair',
  REGISTRY_MIGRATION_CLASS_UNDERSTATED:'Migration manifest understates the computed change class',
  REGISTRY_MIGRATION_SHADOW_DIFF_REQUIRED:'Shadow diff missing',
  REGISTRY_MIGRATION_SHADOW_DIFF_INVALID:'Shadow diff is not for this release pair',
  REGISTRY_MIGRATION_PROJECTION_REPLAY_REQUIRED:'Projection replay output missing',
  REGISTRY_MIGRATION_PROJECTION_REPLAY_INVALID:'Projection replay output is not a passing replay of this release',
  REGISTRY_MIGRATION_ROLLBACK_PLAN_REQUIRED:'Rollback plan missing',
};
const failureLabels:Record<string,string>={
  REGISTRY_CONTENT_HASH_MISMATCH:'The release content hash differs from the hash recorded for that version, so the release was refused.',
  REGISTRY_LINT_FAILED:'The release did not pass lint.',
  REGISTRY_RELEASE_NOT_RECORDED:'The release directory is not recorded in the release index.',
  REGISTRY_TAG_MISSING:'No immutable Git tag exists for that version.',
  REGISTRY_MIGRATION_EVIDENCE_REQUIRED:'An identity-affecting, transition-affecting or breaking change lacks its migration evidence, so CI blocked it.',
};
const classLabels:Record<NonNullable<RegistryMigrationStatus['changeClass']>,string>={
  ADDITIVE:'Additive',COMPATIBLE_BEHAVIORAL:'Compatible behavioral',IDENTITY_AFFECTING:'Identity-affecting',
  TRANSITION_AFFECTING:'Transition-affecting',BREAKING:'Breaking',
};
const evidenceLabels:Record<RegistryMigrationStatus['manifest'],string>={
  PRESENT:'Present',MISSING:'Missing',INVALID:'Invalid',NOT_REQUIRED:'Not required',
};
const diffLabels:ReadonlyArray<[keyof PublicShadowRun['changed'],string]>=[['instanceMatch','Instance match'],
  ['slotCollision','Slot collision'],['proposition','Proposition'],['beliefStatus','Belief status'],['resolution','Resolution'],
  ['projection','Projection']];
function timestamp(value:string){return new Date(value).toISOString().slice(0,19).replace('T',' ')+' UTC';}

export function Registry(props:RegistryProps){
  const lint=props.lint??null;
  return <div className="shell">
    <a className="skip" href="#content">Skip to content</a>
    <header><a href="/" className="brand">Uai</a><span>Your personal memory</span></header>
    <Navigation current="registry"/>
    <main id="content" tabIndex={-1}>
      <p className="eyebrow">OPERATIONS</p>
      <h1>Registry release and migration</h1>
      <section className="card" aria-labelledby="loaded-release">
        <h2 id="loaded-release">Loaded release</h2>
        {props.error?<p role="alert">{props.error}</p>:
         props.release?<>
          <dl>
            <dt>Version</dt><dd>{props.release.semanticVersion}</dd>
            <dt>Git tag</dt><dd>{props.release.gitTag}</dd>
            <dt>Content hash</dt><dd><code>{props.release.contentHash}</code></dd>
            <dt>Git commit</dt><dd><code>{props.release.gitCommit}</code></dd>
            <dt>Loaded</dt><dd>{timestamp(props.release.releasedAt)}</dd>
            <dt>Contracts</dt><dd>{props.contracts.length}</dd>
          </dl>
          <p>
            Read-only. This view shows the snapshot the registry CLI materialized from the immutable tag
            {' '}{props.release.gitTag}. Contracts are YAML files in Git, and a release whose content hash differs
            from the hash recorded for its version is refused at load. Nothing in this deployment loads, lints,
            edits or publishes a release: there is no registry service endpoint anywhere in it.
          </p>
          <table><caption className="sr-only">Contracts in the loaded release</caption>
            <thead><tr><th scope="col">Contract</th><th scope="col">Kind</th><th scope="col">Version</th><th scope="col">Content hash</th></tr></thead>
            <tbody>{props.contracts.map(contract=><tr key={contract.contractKind+contract.contractId}>
              <th scope="row">{contract.contractId}</th>
              <td>{kindLabels[contract.contractKind]}</td>
              <td>{contract.contractVersion}</td>
              <td><code>{contract.contentHash.slice(0,16)}</code></td>
            </tr>)}</tbody>
          </table>
        </>:<p>
          No registry release is loaded in this deployment. A release is materialized only by
          <code> uai registry publish</code> from its immutable Git tag, never by a request.
        </p>}
      </section>
      <section className="card" aria-labelledby="lint">
        <h2 id="lint">Registry lint</h2>
        {!lint?<p>
          No lint report is available to this deployment. <code>uai registry lint</code> runs in the CLI and in CI,
          because linting a contract over the network would make this deployment a registry service.
        </p>:lint.result==='PASS'?<p>
          Lint passed for {lint.releases.map(release=>release.version).join(', ')||'the recorded releases'}, checked {timestamp(lint.checkedAt)}.
        </p>:<>
          <p role="alert">
            Lint failed, checked {timestamp(lint.checkedAt)}.
            {lint.code?' '+(failureLabels[lint.code]??'Refused with '+lint.code+'.'):''}
          </p>
          {lint.issues.length>0&&<table><caption className="sr-only">Lint violations by contract and field</caption>
            <thead><tr><th scope="col">Violation</th><th scope="col">Contract</th><th scope="col">Field</th><th scope="col">Code</th></tr></thead>
            <tbody>{lint.issues.map((issue,index)=><tr key={issue.code+issue.contract+issue.path+index}>
              <th scope="row">{issueLabels[issue.code]??'Contract refused'}</th>
              <td>{issue.contract}</td>
              <td>{issue.path||'(whole contract)'}</td>
              <td>{issue.code}</td>
            </tr>)}</tbody>
          </table>}
          <p>A release that fails lint is never published, so the loaded release above is unchanged by this report.</p>
        </>}
      </section>
      <section className="card" aria-labelledby="migrations">
        <h2 id="migrations">Migration evidence</h2>
        {!lint?.migrations||lint.migrations.length===0?<p>
          Only one release is recorded, so there is no migration to govern. A later release that changes identity or
          transitions lands only with a migration manifest, a shadow diff, a projection replay output and a rollback plan.
        </p>:<table><caption className="sr-only">Migration evidence by release pair</caption>
          <thead><tr><th scope="col">Migration</th><th scope="col">Change class</th><th scope="col">Manifest</th>
            <th scope="col">Shadow diff</th><th scope="col">Projection replay</th><th scope="col">Rollback plan</th></tr></thead>
          <tbody>{lint.migrations.map(migration=><tr key={migration.from+'-'+migration.to}>
            <th scope="row">{migration.from} to {migration.to}</th>
            <td>{migration.changeClass?classLabels[migration.changeClass]:'No contract change'}</td>
            <td>{evidenceLabels[migration.manifest]}</td><td>{evidenceLabels[migration.shadowDiff]}</td>
            <td>{evidenceLabels[migration.projectionReplay]}</td><td>{evidenceLabels[migration.rollbackPlan]}</td>
          </tr>)}</tbody>
        </table>}
      </section>
      <section className="card" aria-labelledby="shadow">
        <h2 id="shadow">Shadow evaluation</h2>
        {props.shadowRuns===null?<p role="alert">The shadow evaluation runs could not be read. Please reload to retry.</p>
          :!props.shadowRuns||props.shadowRuns.length===0?<p>
            No shadow run is recorded for this owner scope. <code>uai registry shadow-diff</code> runs a candidate release or
            extractor against a sample and records what would change, without changing production state.
          </p>:props.shadowRuns.map(run=><article key={run.shadowRunId} aria-labelledby={'run-'+run.shadowRunId}>
            <h3 id={'run-'+run.shadowRunId}>{run.runKind==='REGISTRY'?'Registry':'Extractor'} {run.baselineVersion} to {run.candidateVersion}</h3>
            <p>{run.productionUnchanged===true?'Production tables unchanged: the digest before and after the run is identical.'
              :run.productionUnchanged===false?'Production tables changed during the run: the run is invalid.'
              :'Corpus sample: no production table was read.'} Sample of {run.sampleRef.claims} claims across
              {' '}{run.sampleRef.frameInstances} frame instances.</p>
            <table><caption className="sr-only">Diff counts for this run</caption>
              <thead><tr><th scope="col">Diff</th><th scope="col">Changed</th></tr></thead>
              <tbody>{diffLabels.map(([key,label])=><tr key={key}><th scope="row">{label}</th><td>{run.changed[key]}</td></tr>)}
                <tr><th scope="row">Cost and latency</th><td>{run.costAndLatency.deltaCostMicrounits} microunits,
                  {' '}{run.costAndLatency.deltaLatencyMs} ms</td></tr></tbody>
            </table>
          </article>)}
      </section>
    </main>
    <footer>Registry releases are immutable Git tags. Migration evidence for an identity- or transition-affecting change is required by CI before the release lands.</footer>
  </div>;
}
