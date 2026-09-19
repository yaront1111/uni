import React from 'react';
import {LABEL_CATEGORIES,type CorpusResults,type CorpusStatus,type KeyingRule,type LabelCategory} from '@unai/domain';
import {Navigation} from './Navigation';

export interface CorpusProps {
  /** The report `uai corpus status --report` wrote, when the deployment keeps one.
   * The private corpus never reaches a server: this screen shows counts and rates. */
  status:CorpusStatus|null;
  error?:string;
}

const ruleLabels:Record<KeyingRule,string>={
  'entity.strong_alias_exact':'Entity: exact strong-alias match only',
  'frame_instance.confirmed_match':'Frame instance: confirmed match only',
  'belief_slot.descriptor_identity':'Belief slot: descriptor identity',
  'proposition.normalized_value_identity':'Proposition: normalized value identity',
};
const failureLabels:Record<string,string>={
  REAL_RESULTS_MISSING:'No real-corpus results are recorded.',
  REAL_RESULTS_INVALID:'The recorded real-corpus results could not be read.',
  REAL_RESULTS_NOT_REAL:'The recorded results are not from the real corpus.',
  REAL_THREADS_INSUFFICIENT:'Fewer real threads are labelled than the thresholds require.',
  REAL_RESULTS_THRESHOLDS_STALE:'The results were recorded under older thresholds.',
  KEYING_RULE_NOT_EVALUATED:'A production keying rule has no real-corpus result.',
  KEYING_RULE_VERSION_STALE:'A keying rule changed since its real-corpus result was recorded.',
  KEYING_RULE_THRESHOLD_FAILED:'A keying rule does not meet its identity threshold on the real corpus.',
  CORPUS_CATEGORY_MISSING:'A label category is missing from the corpus.',
  REAL_RESULTS_FAILED:'The recorded real-corpus run failed.',
};
const categoryLabels:Record<LabelCategory,string>={
  sourceSpans:'Source spans',entities:'Entities',frameInstances:'Frame instances',slots:'Slots',propositions:'Propositions',
  commitments:'Commitments',resolutions:'Resolutions',nonMemoryItems:'Unknowns and non-memory items',
};
const percent=(rate:number)=>(rate*100).toFixed(1)+' %';

function RuleTable({results,caption}:{results:CorpusResults;caption:string}){
  return <table><caption className="sr-only">{caption}</caption>
    <thead><tr><th scope="col">Keying rule</th><th scope="col">Version</th><th scope="col">Observations</th>
      <th scope="col">False merges</th><th scope="col">False splits</th><th scope="col">Threshold</th></tr></thead>
    <tbody>{results.rules.map(rule=><tr key={rule.ruleId}>
      <th scope="row">{ruleLabels[rule.ruleId]}</th><td>{rule.ruleVersion}</td><td>{rule.observations}</td>
      <td>{percent(rule.falseMergeRate)}</td><td>{percent(rule.falseSplitRate)}</td>
      <td>{rule.meetsThresholds?'Met':'Not met: '+rule.failures.join(', ')}</td>
    </tr>)}</tbody>
  </table>;
}

export function Corpus({status,error}:CorpusProps){
  return <div className="shell">
    <a className="skip" href="#content">Skip to content</a>
    <header><a href="/" className="brand">Uai</a><span>Your personal memory</span></header>
    <Navigation current="corpus"/>
    <main id="content" tabIndex={-1}>
      <p className="eyebrow">OPERATIONS</p>
      <h1>Corpus and evaluation</h1>
      {error?<p role="alert">{error}</p>:!status?<p>
        No corpus status is available to this deployment. <code>uai corpus status --report</code> writes it from the
        repository that holds the corpus; the corpus itself never passes through a server.
      </p>:<>
        <section className="card" aria-labelledby="corpus-private">
          <h2 id="corpus-private">Private corpus</h2>
          <dl>
            <dt>Location</dt><dd>{status.privatePath.location==='EXTERNAL'?'Outside the repository (encrypted volume)':'Local to the repository, never committed'}</dd>
            <dt>Gitignored</dt><dd>{status.privatePath.gitignored?'Yes':'No: nothing may be imported until it is'}</dd>
            <dt>Commit block</dt><dd>{status.privatePath.precommitBlockInstalled
              ?'Installed: a commit adding a file under the private corpus path is refused'
              :'Not installed here: run pnpm hooks:install; CI refuses a tracked private file either way'}</dd>
            <dt>Tracked private files</dt><dd>{status.privatePath.trackedFiles}</dd>
            <dt>Real Gmail threads</dt><dd>{status.realThreads.imported} imported, {status.realThreads.annotated} labelled
              (at least {status.thresholds.minimumRealThreads} required)</dd>
            <dt>Synthetic equivalents</dt><dd>{status.syntheticThreads.annotated} labelled threads, committed</dd>
          </dl>
        </section>
        <section className="card" aria-labelledby="corpus-annotation">
          <h2 id="corpus-annotation">Annotation</h2>
          <p>Annotation is done locally, on the machine that holds the private corpus, through the command line. This
            screen does not edit labels: the real threads never pass through a server. Label a thread in its annotation
            file, which covers source spans, expected entities, frame instances, slots and propositions, commitments and
            resolutions, and unknowns and non-memory items.</p>
          <ol>
            <li>Import an exported Gmail thread: <code>pnpm uai corpus import --source &lt;export.json&gt;</code></li>
            <li>Write its label file and list the categories it lacks: <code>pnpm uai corpus annotate --thread &lt;ref&gt;</code></li>
            <li>List every thread with its missing categories: <code>pnpm uai corpus annotate</code></li>
            <li>Refresh this screen's report: <code>pnpm uai corpus status --report &lt;path&gt;</code></li>
          </ol>
          <table><caption className="sr-only">Label coverage by category, from the status report</caption>
            <thead><tr><th scope="col">Category</th>
              <th scope="col">Real corpus: items</th><th scope="col">Real threads lacking it</th>
              <th scope="col">Synthetic: items</th><th scope="col">Synthetic threads lacking it</th></tr></thead>
            <tbody>{LABEL_CATEGORIES.map(category=><tr key={category}>
              <th scope="row">{categoryLabels[category]}</th>
              <td>{status.labelCoverage.real.items[category]}</td>
              <td>{status.labelCoverage.real.threadsMissing[category]} of {status.labelCoverage.real.threads}</td>
              <td>{status.labelCoverage.synthetic.items[category]}</td>
              <td>{status.labelCoverage.synthetic.threadsMissing[category]} of {status.labelCoverage.synthetic.threads}</td>
            </tr>)}</tbody>
          </table>
        </section>
        <section className="card" aria-labelledby="corpus-thresholds">
          <h2 id="corpus-thresholds">Identity acceptance thresholds</h2>
          <p>Recorded in CI as {status.thresholds.version}. No rule may merge falsely; splits are the under-merge default.</p>
          <table><caption className="sr-only">Thresholds by keying rule</caption>
            <thead><tr><th scope="col">Keying rule</th><th scope="col">Maximum false merges</th><th scope="col">Maximum false splits</th>
              <th scope="col">Minimum observations</th></tr></thead>
            <tbody>{Object.entries(status.thresholds.rules).map(([rule,threshold])=><tr key={rule}>
              <th scope="row">{ruleLabels[rule as KeyingRule]}</th><td>{percent(threshold.maxFalseMergeRate)}</td>
              <td>{percent(threshold.maxFalseSplitRate)}</td><td>{threshold.minObservations}</td></tr>)}</tbody>
          </table>
        </section>
        <section className="card" aria-labelledby="corpus-real">
          <h2 id="corpus-real">Real-corpus evaluation</h2>
          {status.verification.result==='PASS'&&status.real?<>
            <p>Every production keying rule is evaluated on {status.real.threadCount} real threads, not only on synthetic tests.</p>
            <RuleTable results={status.real} caption="Real-corpus results by keying rule"/>
          </>:<>
            <p role="alert">Real-corpus evaluation is incomplete, so no keying rule is approved on real data yet.</p>
            <ul>{status.verification.failures.map(code=><li key={code}>{failureLabels[code]??code}</li>)}</ul>
          </>}
        </section>
        {status.synthetic&&<section className="card" aria-labelledby="corpus-synthetic">
          <h2 id="corpus-synthetic">Synthetic equivalents</h2>
          <p>{status.synthetic.result==='PASS'?'Meets':'Does not meet'} the recorded thresholds over
            {' '}{status.synthetic.threadCount} threads. Synthetic results alone never approve a keying rule.</p>
          <RuleTable results={status.synthetic} caption="Synthetic results by keying rule"/>
        </section>}
      </>}
    </main>
    <footer>Checked {status?status.checkedAt.slice(0,19).replace('T',' ')+' UTC':'never'}. Counts and rates only: no thread, address or quote leaves the private corpus.</footer>
  </div>;
}
