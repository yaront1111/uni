/** Single pinned PostgreSQL/pgvector source for test, recovery and dev:stack. */
export const POSTGRES_IMAGE='pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f';

export function postgresRunArguments({name,options=[],command=[]}){
  return ['run','--detach','--rm','--name',name,'--publish','127.0.0.1::5432',
    '--tmpfs','/var/lib/postgresql/data',...options,POSTGRES_IMAGE,...command];
}
