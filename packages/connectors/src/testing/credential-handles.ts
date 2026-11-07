/** TEST DATA ONLY: no production module imports this file.
 *
 * The one list of connector credential handle vectors (ADR 0013, amendment
 * 2026-11-07). Every layer that decides namespace membership is checked against
 * it: `isConnectorCredentialHandle` (credentials.test.ts), the
 * connectors.secret_ref CHECK of migration 0048 (packages/api connectors.test.ts),
 * and later the secret_ref trigger and the connector-only resolver.
 *
 * `accepted` is the expected `isConnectorCredentialHandle(handle, owner)`.
 * `storable` is the expected verdict of migration 0048's CHECK, which is a
 * shape check binding no owner. Every accepted vector is storable. No vector
 * uses a realistic token format: secret scanners flag one.
 */
export interface CredentialHandleVector {
  readonly title: string;
  readonly handle: string;
  readonly accepted: boolean;
  readonly storable: boolean;
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `owner` is the namespace under test and `otherOwner` a second owner scope;
 * both must be lowercase canonical UUIDs, as PostgreSQL prints a `uuid`. */
export function credentialHandleVectors(owner: string, otherOwner: string): readonly CredentialHandleVector[] {
  if (!CANONICAL_UUID.test(owner) || !CANONICAL_UUID.test(otherOwner)) throw new Error('CREDENTIAL_HANDLE_VECTOR_OWNER_INVALID');
  const own = `secret://mounted/connectors/${owner}`;
  const vector = (title: string, handle: string, accepted: boolean, storable: boolean): CredentialHandleVector =>
    Object.freeze({ title, handle, accepted, storable });
  return Object.freeze([
    // Accepted, and therefore storable.
    vector('own namespace without #field', `${own}/gmail`, true, true),
    vector('own namespace with #field', `${own}/gmail#refresh`, true, true),
    vector('own namespace, nested label', `${own}/google/work#refresh`, true, true),
    vector('own namespace, another provider', `secret://vault/connectors/${owner}/github`, true, true),
    vector('own namespace, dot-led label segment', `${own}/.hidden`, true, true),
    vector('own namespace, 256-character name', `${own}/${'a'.repeat(208)}`, true, true),
    vector('own namespace, 64-character field', `${own}/gmail#${'f'.repeat(64)}`, true, true),
    // Refused, but storable: the CHECK binds no owner and keeps every 0018 value.
    vector('runtime credential handle', 'secret://mounted/api-database-url', false, true),
    vector('runtime credential handle (worker)', 'secret://mounted/worker-database-url', false, true),
    vector('runtime OAuth client handle', 'secret://mounted/google-connector-client#client_secret', false, true),
    vector('flat legacy handle', 'secret://mounted/gmail#refresh', false, true),
    vector('pre-namespace runbook handle', 'secret://mounted/connectors/gmail', false, true),
    vector("another owner's prefix", `secret://mounted/connectors/${otherOwner}/gmail`, false, true),
    vector('prefix without a label', own, false, true),
    vector('uppercase owner segment', `secret://mounted/connectors/${owner.toUpperCase()}/gmail`, false, true),
    vector("owner id as a longer segment's prefix", `${own}x/gmail`, false, true),
    vector('namespace below the root', `secret://mounted/tenant/connectors/${owner}/gmail`, false, true),
    vector('capitalized root', `secret://mounted/Connectors/${owner}/gmail`, false, true),
    vector('colon label (0018 grammar only)', `${own}/a:b`, false, true),
    vector('provider outside the @unai/secrets grammar', `secret://my_vault.v2/connectors/${owner}/gmail`, false, true),
    // Refused, and not storable.
    vector('empty segment', `${own}//gmail`, false, false),
    vector('dot segment', `${own}/./gmail`, false, false),
    vector("dot-dot segment into another owner's namespace", `${own}/../${otherOwner}/gmail`, false, false),
    vector('trailing slash', `${own}/`, false, false),
    vector('leading slash', `secret://mounted//connectors/${owner}/gmail`, false, false),
    vector('whitespace', `${own}/gm ail`, false, false),
    vector('257-character name', `${own}/${'a'.repeat(209)}`, false, false),
    vector('65-character field', `${own}/gmail#${'f'.repeat(65)}`, false, false),
    vector('uppercase provider', `secret://Mounted/connectors/${owner}/gmail`, false, false),
    vector('literal credential', 'literal-refresh-token-value', false, false),
  ]);
}
