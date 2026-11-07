import { z } from 'zod';
import type { SecretsManager } from '@unai/secrets';
import { connectorCursorSchema, type ConnectorCursor } from '@unai/domain';
import { ConnectorError } from './manifests.js';
import { providerFailure, providerFetch } from './http.js';
import type { ConnectorClient } from './providers.js';

// ---------------------------------------------------------------------------
// Omi (ADR 0041 D2, D7). One GET, ever: the developer API's conversation list,
// transcripts included. Nothing here writes to Omi, reads another Omi endpoint
// or keeps a provider response body (FR-104).
// ---------------------------------------------------------------------------

const OMI = 'https://api.omi.me/v1/dev/user/conversations';
const DAY_MS = 86_400_000;
// Printable ASCII only, so JSON-escaping can never push the cursor past
// `connectorCursorSchema`'s 2048 characters.
// A position must also be a date whose 24 h lookback is a date: a stored `hwm`
// that is not would make every later sync fail with CONNECTOR_CURSOR_INVALID, and
// `toISOString()` throws a non-connector error on an out-of-range value.
const omiStamp = z.string().min(1).max(64).regex(/^[\x20-\x7e]+$/)
  .refine(stamp => !Number.isNaN(new Date(Date.parse(stamp) - DAY_MS).getTime()));
const omiId = z.string().min(1).max(128).regex(/^[\x20-\x7e]+$/);
const omiItemKey = z.object({ id: omiId, created_at: omiStamp });

/** `hwm`/`hwmId`: newest conversation of the last closed window. `top`/`topId`:
 * the same for the window in progress. `before`: the next page's `end_date`.
 * `offset`: the tie skip. */
const omiStateSchema = z.strictObject({
  v: z.literal(1),
  hwm: omiStamp.nullable(), hwmId: omiId.nullable(),
  top: omiStamp.nullable(), topId: omiId.nullable(),
  before: omiStamp.nullable(),
  offset: z.number().int().min(0).max(1_000_000),
}).refine(state =>
  (state.hwm === null) === (state.hwmId === null)
  && (state.top === null) === (state.topId === null)
  && (state.top === null || state.before !== null));
type OmiState = z.infer<typeof omiStateSchema>;
const OMI_EMPTY: OmiState = { v: 1, hwm: null, hwmId: null, top: null, topId: null, before: null, offset: 0 };

function omiStateOf(from: ConnectorCursor | null): OmiState {
  if (from === null) return OMI_EMPTY;
  try {
    return omiStateSchema.parse(JSON.parse(from.providerToken ?? ''));
  } catch {
    // Never echo the token: it is the cursor's own text, not the owner's, but a
    // corrupt or foreign one is refused by name before any request is made.
    throw new ConnectorError('CONNECTOR_CURSOR_INVALID');
  }
}

function omiQuery(state: OmiState, limit: number): URLSearchParams {
  const query = new URLSearchParams({
    include_transcript: 'true', limit: String(limit), offset: String(state.offset),
  });
  // The 24 h lookback re-reads a conversation that was still processing when the
  // last window closed: its created_at is older than ones already read.
  if (state.hwm !== null) query.set('start_date', new Date(Date.parse(state.hwm) - DAY_MS).toISOString());
  if (state.top !== null && state.before !== null) query.set('end_date', state.before);
  return query;
}

interface OmiList {
  readonly items: readonly unknown[];
  readonly hasMore: string | null;
  readonly truncated: string | null;
}

/** The single request. Only the status and `Retry-After` of a failed response are
 * ever kept, and its body is cancelled unread: Omi error text can carry the
 * owner's own words. Never sleeps and never retries. */
async function omiGet(key: string, query: URLSearchParams): Promise<OmiList> {
  const response = await providerFetch(OMI + '?' + query.toString(), {
    method: 'GET', headers: { authorization: 'Bearer ' + key, accept: 'application/json' }, redirect: 'error',
  });
  if (!response.ok) throw providerFailure(response);
  let items: unknown;
  try { items = await response.json(); } catch { throw new ConnectorError('CONNECTOR_PROVIDER_RESPONSE_INVALID'); }
  if (!Array.isArray(items)) throw new ConnectorError('CONNECTOR_PROVIDER_RESPONSE_INVALID');
  const header = (name: string) => response.headers.get(name)?.trim().toLowerCase() ?? null;
  return { items, hasMore: header('x-omi-has-more'), truncated: header('x-omi-list-truncated') };
}

/** D7 rule 3: more pages when either header says so; only when neither header is
 * present does a full page mean more. */
function omiHasMore(list: OmiList, limit: number): boolean {
  if (list.hasMore === 'true' || list.truncated === 'true') return true;
  return list.hasMore === null && list.truncated === null && list.items.length === limit;
}

/** The pure state step of D7 (rules 1-4). `usable` are the page's items that carry
 * a plain id and created_at, newest first. */
function omiAdvance(
  state: OmiState, usable: readonly { id: string; created_at: string }[], count: number, more: boolean,
): OmiState {
  const first = usable[0], last = usable.at(-1);
  if (!more) {
    // Close the window: the newest conversation of the window becomes the new
    // high-water mark. An empty page leaves it where it was.
    const head = state.top !== null
      ? { at: state.top, id: state.topId }
      : first ? { at: first.created_at, id: first.id } : { at: state.hwm, id: state.hwmId };
    return { ...state, hwm: head.at, hwmId: head.id, top: null, topId: null, before: null, offset: 0 };
  }
  // An empty truncated page is never the end: keep the state and let the run stop.
  if (count === 0) return state;
  const opened = state.top === null && first
    ? { ...state, top: first.created_at, topId: first.id } : state;
  // A page whose oldest created_at did not move (a tie, or nothing usable) must
  // grow the offset, or the next request would be the same one.
  if (!last || last.created_at === state.before) return { ...opened, offset: state.offset + count };
  return { ...opened, before: last.created_at, offset: 0 };
}

function omiCursor(state: OmiState): ConnectorCursor {
  const at = (value: string | null) => value ?? 'none';
  return connectorCursorSchema.parse({
    position: `omi:hwm=${at(state.hwm)}/${at(state.hwmId)};before=${at(state.before)};offset=${state.offset}`,
    providerToken: JSON.stringify(state),
  });
}

/** Omi, read-only (ADR 0041 D2, D7): the owner's completed conversations, newest
 * first, paged by keyset on `created_at` with a 24 h lookback. The provider's
 * objects are returned untouched, because the parser hashes their content. */
export function createOmiClient(secrets: SecretsManager, secretRef: string): ConnectorClient {
  return {
    async fetchPage(request) {
      const state = omiStateOf(request.cursor);
      const key = await secrets.resolve(secretRef);
      const list = await omiGet(key, omiQuery(state, request.limit));
      const more = omiHasMore(list, request.limit);
      const usable = list.items.flatMap(item => {
        const found = omiItemKey.safeParse(item);
        return found.success ? [found.data] : [];
      });
      const next = omiAdvance(state, usable, list.items.length, more);
      return {
        payloads: list.items,
        // Nothing read: hand back the input cursor (null on a first, empty sync).
        nextCursor: JSON.stringify(next) === JSON.stringify(state) ? request.cursor : omiCursor(next),
        ...(more ? {} : { exhausted: true }),
      };
    },
  };
}
