import type { Pool } from 'pg';

/**
 * Encryption at rest of the database (PRD §30; CRT-SEC-08-A; ADR 0032 §4).
 *
 * PostgreSQL cannot observe the encryption of the volume or the managed service
 * it runs on, so the deployment declares it on the database itself, as the
 * operator who provisioned the encrypted storage:
 *
 *     ALTER DATABASE <name> SET unai.encryption_at_rest = 'volume-kms:<key reference>';
 *
 * The runtime services refuse to start against a database that declares nothing,
 * or something that is not a recognised mechanism with a key or provider
 * reference. The declaration is configuration, not proof: the deployment still
 * keeps the provider's evidence (ADR 0002), and this check is what makes a
 * database without it unusable by mistake. The object store needs no declaration:
 * `@unai/storage` verifies the bucket's SSE-KMS default at startup and the
 * encryption receipt of every read and write.
 */
export const ENCRYPTION_AT_REST_SETTING = 'unai.encryption_at_rest';
const DECLARATION = /^(volume-kms|tde|managed):[A-Za-z0-9:/_.@+-]{1,200}$/;

export async function assertDatabaseEncryptionAtRest(pool: Pool): Promise<string> {
  let declared: unknown;
  try {
    declared = (await pool.query('SELECT current_setting($1,true) AS declared', [ENCRYPTION_AT_REST_SETTING])).rows[0]?.declared;
  } catch {
    // Driver text can carry connection details; only the code leaves.
    throw new Error('DATABASE_ENCRYPTION_AT_REST_UNVERIFIED');
  }
  if (typeof declared !== 'string' || !DECLARATION.test(declared)) throw new Error('DATABASE_ENCRYPTION_AT_REST_REQUIRED');
  return declared;
}
