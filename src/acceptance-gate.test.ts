import {it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';

function check(statuses:string[]){
  const report={testResults:[{name:'acceptance.test.ts',assertionResults:statuses.map((status,index)=>({
    fullName:'[AC44.'+String(index+1).padStart(2,'0')+'] behavior',status}))}]};
  const result=spawnSync(process.execPath,['--input-type=module','-e',
    "import {acceptanceResults} from './scripts/acceptance-gate.mjs'; let text='';for await(const chunk of process.stdin)text+=chunk;process.stdout.write(JSON.stringify(acceptanceResults(JSON.parse(text))));"],
    {input:JSON.stringify(report),encoding:'utf8'});
  expect(result.status,result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {scenario:string;passed:boolean}[];
}
it('CRT-QA-04-A: every one of twenty scenarios must have executed and passed',()=>{
  expect(check(Array(20).fill('passed')).every(row=>row.passed)).toBe(true);
  expect(check(Array(19).fill('passed')).filter(row=>!row.passed)).toEqual([{scenario:'AC44.20',passed:false,cases:[]}]);
});
it.each(['failed','pending','skipped','todo'])('CRT-QA-04-A: a %s scenario fails the acceptance gate',status=>{
  expect(check([...Array(19).fill('passed'),status]).at(-1)?.passed).toBe(false);
});
