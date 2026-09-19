/** Ask has no owner-zone declaration. State the UTC boundary instead of silently
 * treating every period question as this month or guessing a personal zone. */
export function changeWindow(query:string,worldTime:string,explicit?:{from:string|null;to:string|null}|null) {
  let from:string|null=null,to:string|null=null;
  if(explicit&&(explicit.from||explicit.to))return {...explicit,description:'Changes learned within the declared date range.'};
  const at=new Date(worldTime),text=query.toLowerCase();
  const day=new Date(Date.UTC(at.getUTCFullYear(),at.getUTCMonth(),at.getUTCDate()));
  if(/\b(this|last) month\b/.test(text)){
    const current=new Date(Date.UTC(at.getUTCFullYear(),at.getUTCMonth(),1));
    from=new Date(Date.UTC(at.getUTCFullYear(),at.getUTCMonth()-(/\blast month\b/.test(text)?1:0),1)).toISOString();
    to=/\blast month\b/.test(text)?current.toISOString():null;
  }else if(/\b(this|last) week\b/.test(text)){
    const start=new Date(day.getTime()-((day.getUTCDay()+6)%7)*86400000);
    from=new Date(start.getTime()-(/\blast week\b/.test(text)?7*86400000:0)).toISOString();
    to=/\blast week\b/.test(text)?start.toISOString():null;
  }else if(/\b(today|yesterday)\b/.test(text)){
    from=new Date(day.getTime()-(/\byesterday\b/.test(text)?86400000:0)).toISOString();
    to=/\byesterday\b/.test(text)?day.toISOString():null;
  }
  return {from,to,description:from
    ? 'Changes learned in the requested period, using UTC date boundaries.'
    : 'No exact date range was resolved; these are changes in the retrieved records.'};
}
