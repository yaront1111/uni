/** The harness calls this on Vitest's completed JSON report. A test merely
 * existing, or being skipped/todo, never counts as an accepted scenario. */
export function acceptanceResults(report){
  const tests=(report.testResults??[]).flatMap(file=>(file.assertionResults??[]).map(test=>({...test,file:file.name})));
  return Array.from({length:20},(_,index)=>{
    const id='AC44.'+String(index+1).padStart(2,'0');
    const cases=tests.filter(test=>(test.fullName??test.title??'').includes('['+id+']'));
    return {scenario:id,passed:cases.length>0&&cases.every(test=>test.status==='passed'),
      cases:cases.map(test=>({name:test.fullName??test.title,file:test.file,status:test.status}))};
  });
}
