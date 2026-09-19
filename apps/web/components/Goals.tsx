import React,{useState} from 'react';
import type {Goal,GoalPriority,GoalsView} from '@unai/domain';
import {Shell} from './Shell';

/** The Goals screen (design journey J7, "Goals"; PRD §7.4, §37.7; ADR 0029 §2).
 * Every drawn state is reachable from props alone: the goal list with its
 * current priority, a priority change kept as history, a temporary override
 * recorded and respected, and a goal the mentor flagged. */
export interface GoalsProps {
  view:GoalsView;
  error?:string;
}

export const priorityText:Record<GoalPriority,string>={HIGH:'High',MEDIUM:'Medium',LOW:'Low',PAUSED:'Paused'};
export const domainText={FINANCE:'Finance',FAMILY:'Family',WORK:'Work',HEALTH:'Health',ADMIN:'Admin',PERSONAL:'Personal'} as const;
const changeText={INITIAL:'Set when the goal was created',CHANGE:'Priority changed',TEMPORARY_OVERRIDE:'Temporary override'} as const;
const PRIORITIES=Object.keys(priorityText) as GoalPriority[];
const DOMAINS=Object.keys(domainText) as (keyof typeof domainText)[];
const day=(iso:string|null)=>iso?iso.slice(0,10):'';

/** The browser write convention of this app: same-origin proxy, a purpose, a
 * correlation id and an idempotency key; 401 goes to sign-in. */
async function write(path:string,body:unknown):Promise<'ok'|'expired'|'refused'>{
  const response=await fetch('/api/platform/'+path,{method:'POST',headers:{'content-type':'application/json','x-purpose':'goals.manage',
    'x-correlation-id':crypto.randomUUID(),'idempotency-key':crypto.randomUUID().replaceAll('-','')},body:JSON.stringify(body)});
  if(response.status===401)return 'expired';
  return response.ok?'ok':'refused';
}

function Flag({goal}:{goal:Goal}){
  const flag=goal.contradiction;
  if(!flag)return null;
  return <p className="notice"><strong>Flagged:</strong> your calendar on {day(flag.decidedAt)} did not match this goal’s stated priority.
    {' '}{flag.decision==='ASK'?<>The <a href="/mentor">mentor card</a> shows the evidence, the inference and a recommendation.</>
      :<>The mentor card was withheld to keep within today’s attention budget; it is listed on the <a href="/mentor">mentor</a> screen.</>}</p>;
}

function PriorityChange({goal,busy,onSubmit}:{goal:Goal;busy:boolean;onSubmit:(body:Record<string,string>)=>void}){
  const id='change-'+goal.goalId;
  const [priority,setPriority]=useState<GoalPriority>(goal.currentPriority);
  const [reason,setReason]=useState('');
  const [until,setUntil]=useState('');
  return <form aria-labelledby={id} onSubmit={event=>{event.preventDefault();
    onSubmit({priority,reason,...(until?{until:until+'T23:59:59.000Z'}:{})});}}>
    <h3 id={id}>Change the priority<span className="sr-only"> of {goal.title}</span></h3>
    <p className="muted">A change is added to the history below; the earlier priority is kept, never overwritten. With an end date it is a temporary override and your stated priority stays as it is.</p>
    <label htmlFor={id+'-priority'}>New priority</label>
    <select id={id+'-priority'} value={priority} onChange={event=>setPriority(event.target.value as GoalPriority)}>
      {PRIORITIES.map(value=><option key={value} value={value}>{priorityText[value]}</option>)}
    </select>
    <label htmlFor={id+'-reason'}>Reason</label>
    <input id={id+'-reason'} required maxLength={500} value={reason} onChange={event=>setReason(event.target.value)}/>
    <label htmlFor={id+'-until'}>Temporary until (optional)</label>
    <input id={id+'-until'} type="date" value={until} onChange={event=>setUntil(event.target.value)}/>
    <button type="submit" disabled={busy}>Record the change<span className="sr-only"> for {goal.title}</span></button>
  </form>;
}

function GoalCard({goal,busy,onChange}:{goal:Goal;busy:boolean;onChange:(goal:Goal,body:Record<string,string>)=>void}){
  const id='goal-'+goal.goalId;
  const override=goal.temporaryOverride;
  return <section className="card" aria-labelledby={id}>
    <h2 id={id}>{goal.title}</h2>
    <dl>
      <dt>Area of life</dt><dd>{domainText[goal.domain]}</dd>
      <dt>Stated priority</dt><dd>{priorityText[goal.currentPriority]}</dd>
      <dt>Priority that applies now</dt><dd>{priorityText[goal.effectivePriority]}
        {goal.overrideActive&&override?<> (temporary override until {day(override.validTo)}: “{override.reason}”)</>:null}</dd>
      {goal.retiredAt?<><dt>Retired</dt><dd>{day(goal.retiredAt)}</dd></>:null}
    </dl>
    {goal.overrideActive&&override?<p>Your temporary override is respected: until {day(override.validTo)} this goal is treated as {priorityText[override.priority].toLowerCase()} priority, and the mentor does not measure your calendar against the stated priority.</p>:null}
    <Flag goal={goal}/>
    <table>
      <caption>Priority history, oldest first ({goal.priorityHistory.length} {goal.priorityHistory.length===1?'entry':'entries'}; entries are kept, never overwritten)</caption>
      <thead><tr><th scope="col">Recorded</th><th scope="col">What happened</th><th scope="col">Priority</th><th scope="col">Applies from</th><th scope="col">Applies until</th><th scope="col">Reason</th></tr></thead>
      <tbody>{goal.priorityHistory.map(entry=><tr key={entry.goalPriorityHistoryId}>
        <td>{day(entry.recordedAt)}</td><td>{changeText[entry.changeKind]}</td><td>{priorityText[entry.priority]}</td>
        <td>{day(entry.validFrom)}</td><td>{entry.validTo?day(entry.validTo):'Until changed'}</td><td>{entry.reason}</td>
      </tr>)}</tbody>
    </table>
    {goal.retiredAt?null:<PriorityChange goal={goal} busy={busy} onSubmit={body=>onChange(goal,body)}/>}
  </section>;
}

function NewGoal({busy,onSubmit}:{busy:boolean;onSubmit:(body:Record<string,string>)=>void}){
  const [title,setTitle]=useState('');
  const [domain,setDomain]=useState<keyof typeof domainText>('PERSONAL');
  const [priority,setPriority]=useState<GoalPriority>('MEDIUM');
  const [reason,setReason]=useState('');
  return <form className="card" aria-labelledby="new-goal" onSubmit={event=>{event.preventDefault();
    onSubmit({title,domain,priority,...(reason?{reason}:{})});}}>
    <h2 id="new-goal">Add a goal</h2>
    <label htmlFor="new-goal-title">Goal</label>
    <input id="new-goal-title" required maxLength={200} value={title} onChange={event=>setTitle(event.target.value)}/>
    <label htmlFor="new-goal-domain">Area of life</label>
    <select id="new-goal-domain" value={domain} onChange={event=>setDomain(event.target.value as keyof typeof domainText)}>
      {DOMAINS.map(value=><option key={value} value={value}>{domainText[value]}</option>)}
    </select>
    <label htmlFor="new-goal-priority">Priority</label>
    <select id="new-goal-priority" value={priority} onChange={event=>setPriority(event.target.value as GoalPriority)}>
      {PRIORITIES.map(value=><option key={value} value={value}>{priorityText[value]}</option>)}
    </select>
    <label htmlFor="new-goal-reason">Why it matters (optional)</label>
    <input id="new-goal-reason" maxLength={500} value={reason} onChange={event=>setReason(event.target.value)}/>
    <button type="submit" disabled={busy}>Add the goal</button>
  </form>;
}

export function Goals(props:GoalsProps){
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState(props.error??'');
  const [status,setStatus]=useState('');
  async function submit(path:string,body:unknown,failure:string){
    setBusy(true);setError('');setStatus('Saving…');
    try{
      const result=await write(path,body);
      if(result==='expired'){window.location.assign('/signin?reason=expired');return;}
      if(result!=='ok')throw new Error('refused');
      // The server render re-reads the goals and their history.
      window.location.reload();
    }catch{setStatus('');setError(failure);}
    finally{setBusy(false);}
  }
  const {goals}=props.view;
  return <Shell current="goals" eyebrow="GOALS" title="Goals" status={status}
    footer="A priority change adds a history entry. Nothing already recorded about a goal is edited in place.">
    <p>What you have said matters to you, and how much. Reviews and the mentor compare your time against these priorities.</p>
    {goals.length===0?<section className="card"><p>No goals recorded yet.</p></section>:null}
    {goals.map(goal=><GoalCard key={goal.goalId} goal={goal} busy={busy}
      onChange={(target,body)=>void submit('goals/'+target.goalId+'/priority',body,'The priority change could not be recorded. Nothing changed. Please retry.')}/>)}
    <NewGoal busy={busy} onSubmit={body=>void submit('goals',body,'The goal could not be added. Nothing changed. Please retry.')}/>
    {goals.length>0?<details className="advanced">
      <summary>Advanced inspector: goal and history identifiers</summary>
      <dl>{goals.map(goal=><React.Fragment key={goal.goalId}>
        <dt>{goal.title}</dt><dd><code>{goal.goalId}</code>{goal.priorityHistory.map(entry=><React.Fragment key={entry.goalPriorityHistoryId}> · <code>{entry.goalPriorityHistoryId}</code></React.Fragment>)}</dd>
      </React.Fragment>)}</dl>
    </details>:null}
    {error?<p role="alert">{error}</p>:null}
  </Shell>;
}
