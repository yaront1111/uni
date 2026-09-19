import {randomUUID} from 'node:crypto';
import {weeklyReviewRequestSchema,weeklyReviewSchema} from '@unai/domain';
import type {WeeklyReviewProps} from '../components/WeeklyReview';
import {DATA_PURPOSE,MAXIMUM_SENSITIVITY,type ApiCall,type Caller} from './screens';

/**
 * The read behind the Weekly review screen (ADR 0029), as a plain function over
 * an API call. `getServerSideProps` passes `apiRequest` from `lib/server.ts`; the
 * end-to-end test passes the real platform API over an in-process transport, so
 * the links the rendered review carries are the ones a page would. The review
 * reads memory through the Context Broker with the evidence context every memory
 * read from this app pins.
 */
export const WEEKLY_REVIEW_UNAVAILABLE='The weekly review could not be prepared. Please reload to retry.';

/** The Monday of the week before the one `now` falls in: the last complete week. */
export function lastWeek(now=new Date()){
  const monday=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-((now.getUTCDay()+6)%7)-7));
  return monday.toISOString().slice(0,10);
}

/** A requested week start, or the last complete week when it does not parse. */
export function weekStartFrom(value:unknown){
  const requested=weeklyReviewRequestSchema.shape.weekStart.safeParse(value);
  return requested.success?requested.data:lastWeek();
}

export async function loadWeeklyReview(call:ApiCall,caller:Caller,weekStart:string):Promise<{kind:'expired'}|{kind:'props';props:WeeklyReviewProps}>{
  try{
    const review=await call('/v1/weekly-review?weekStart='+encodeURIComponent(weekStart)+'&timeZone=UTC','GET',{cookie:caller.cookie,
      'x-owner-scope-id':caller.ownerScopeId,'x-purpose':'review.weekly','x-correlation-id':randomUUID(),
      'x-data-purpose':DATA_PURPOSE,'x-maximum-sensitivity':MAXIMUM_SENSITIVITY});
    if(review.status===401)return {kind:'expired'};
    if(review.status!==200)return {kind:'props',props:{weekStart,review:null,error:WEEKLY_REVIEW_UNAVAILABLE}};
    return {kind:'props',props:{weekStart,review:weeklyReviewSchema.parse(review.body)}};
  }catch{
    return {kind:'props',props:{weekStart,review:null,error:WEEKLY_REVIEW_UNAVAILABLE}};
  }
}
