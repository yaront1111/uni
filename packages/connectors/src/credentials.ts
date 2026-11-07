import { isSecretHandle, parseSecretHandle } from '@unai/secrets';
import { ConnectorError } from './manifests.js';

/** The connector-credential namespace (ADR 0013, amendment 2026-11-07).
 *
 * A connector's credential handle is
 * `secret://<provider>/connectors/<ownerScopeId>/<label>[#<field>]`. Runtime
 * credentials never live under `connectors/`, so the prefix alone separates a
 * connector token from every runtime handle, and the owner segment separates one
 * owner's tokens from another's. The rule lives here, not in `@unai/secrets`,
 * which owns only the handle grammar. No I/O: nothing here reads a secret.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** True only for a valid handle whose name lies strictly below
 * `connectors/<ownerScopeId>/`. Only the owner argument is lowercased: the
 * handle's owner segment must already be the lowercase canonical form
 * PostgreSQL prints, and it is never case-folded. */
export function isConnectorCredentialHandle(handle: unknown, ownerScopeId: string): boolean {
  if (!isUuid(ownerScopeId) || !isSecretHandle(handle)) return false;
  const prefix = `connectors/${ownerScopeId.toLowerCase()}/`;
  const { name } = parseSecretHandle(handle);
  return name.startsWith(prefix) && name.length > prefix.length;
}

/** Builds the owner's handle for `label`. Throws the bare code
 * CONNECTOR_SECRET_REF_INVALID, with no detail since an input may be a pasted
 * credential, unless the result is in the namespace and parses back to exactly
 * the provider, label and field asked for: without that round trip the label
 * `a#b` would silently become label `a` with field `b`. */
export function connectorCredentialHandle(ownerScopeId: string, label: string,
  options: { readonly provider?: string; readonly field?: string | undefined } = {}): string {
  if (!isUuid(ownerScopeId)) throw new ConnectorError('CONNECTOR_SECRET_REF_INVALID');
  const provider = options.provider ?? 'mounted';
  const field = options.field;
  const name = `connectors/${ownerScopeId.toLowerCase()}/${label}`;
  const handle = `secret://${provider}/${name}${field === undefined ? '' : `#${field}`}`;
  if (!isConnectorCredentialHandle(handle, ownerScopeId)) throw new ConnectorError('CONNECTOR_SECRET_REF_INVALID');
  const parsed = parseSecretHandle(handle);
  if (parsed.provider !== provider || parsed.name !== name || parsed.field !== (field ?? null)) {
    throw new ConnectorError('CONNECTOR_SECRET_REF_INVALID');
  }
  return handle;
}
