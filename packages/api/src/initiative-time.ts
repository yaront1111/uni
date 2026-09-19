import { addLocalDays, assertTimeZone, ownerLocalDate, startOfLocalDate } from '@unai/review';

/** One run per local calendar day: choose the first occurrence on overlaps,
 * and the first valid later minute when the configured minute is skipped. */
export function nextInitiativeRun(after: Date, timeZone: string, localTime: string): Date {
  assertTimeZone(timeZone);
  if (!Number.isFinite(after.getTime()) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime)) throw new Error('INITIATIVE_TIME_INVALID');
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  for (let day = 0; day < 3; day++) {
    const date = addLocalDays(ownerLocalDate(after,timeZone),day);
    const start = startOfLocalDate(date,timeZone).getTime();
    for (let minute = 0; minute < 28 * 60; minute++) {
      const instant = new Date(start + minute * 60000);
      const parts = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type,part.value]));
      const calendarDate = parts.year + '-' + parts.month + '-' + parts.day;
      if (calendarDate !== date) continue;
      if (parts.hour + ':' + parts.minute < localTime) continue;
      if (instant.getTime() > after.getTime()) return instant;
      // Today's first occurrence passed: do not choose the duplicate hour.
      break;
    }
  }
  throw new Error('INITIATIVE_TIME_UNRESOLVABLE');
}
