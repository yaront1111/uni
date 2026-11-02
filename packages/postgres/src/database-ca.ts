/** The trusted PostgreSQL CA for the operator CLIs (`pnpm db:migrate`, `uai registry`).
 * `UNAI_DATABASE_CA_FILE` is canonical because it is the runtime's name. The
 * deprecated `UNAI_DATABASE_CA_PATH` stays because the moe-next verifier still
 * delivers it (scripts/verifier-rehearsal.mjs:20). An empty value counts as unset.
 * Neither set reports the canonical name and returns undefined, so each CLI keeps
 * its own missing-configuration code. Messages are bare codes, never a path. */
export function resolveDatabaseCaFile(env: NodeJS.ProcessEnv, report: (line: string) => void = line => console.error(line)): string | undefined {
  const file = env.UNAI_DATABASE_CA_FILE || undefined, alias = env.UNAI_DATABASE_CA_PATH || undefined;
  if (file && alias && file !== alias) throw new Error('CONFIG_CONFLICT:UNAI_DATABASE_CA_FILE');
  if (alias) report('CONFIG_DEPRECATED_ALIAS:UNAI_DATABASE_CA_PATH');
  else if (!file) report('CONFIG_REQUIRED:UNAI_DATABASE_CA_FILE');
  return file ?? alias;
}
