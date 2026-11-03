-- PostgreSQL 17 provisioning for Uai (ADR 0043 D4): login roles, database
-- `unai`, the vector extension and the encryption-at-rest declaration.
--
-- Host order:
--   1. Issue the internal-CA PostgreSQL leaf (ADR 0043 D2) to
--      /etc/unai/tls/postgres/cert.pem and key.pem.
--   2. Install unai.conf and pg_hba.conf from this directory, then
--      `systemctl restart postgresql`.
--   3. Run this file as the postgres superuser.
--   4. Run `pnpm db:migrate` as unai_migrator.
--
-- Invocation, keeping every password out of argv and the process list:
--   cat /root/unai-provision.psql /opt/unai/current/deploy/postgres/provision.sql \
--     | sudo -u postgres psql -X -v ON_ERROR_STOP=1 -f -
--
-- /root/unai-provision.psql is root:root 0600 and holds one `\set` line per
-- variable. Generate each password with `openssl rand -hex 32`: hex needs no
-- psql quoting and is safe in a connection URL.
--   \set migrator_password '<64 hex characters>'
--   \set api_login_password '<64 hex characters>'
--   \set worker_login_password '<64 hex characters>'
--   \set auth_login_password '<64 hex characters>'
--   \set backup_password '<64 hex characters>'
--   \set encryption_at_rest '<declaration>'
-- The declaration names the key that encrypts the data volume, for example
-- (AWS's documentation account id, ADR 0043 D4):
--   \set encryption_at_rest 'volume-kms:arn:aws:kms:eu-central-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab'
-- `dbname` defaults to unai; only the harness test points it elsewhere.
--
-- Safe to re-run: roles, memberships, database, extension and declaration
-- converge to the same state. A re-run sets the five passwords again, which is
-- the rotation path. unai_app and unai_auth are created only when absent and are
-- never altered here: migrations 0001 and 0002 assert their attributes.
--
-- Do not run this with log_statement set to ddl or all: the server would log the
-- role statements together with their passwords.
--
-- This file contains no transaction control: CREATE DATABASE cannot run inside a
-- transaction block.

\set ON_ERROR_STOP on
\set VERBOSITY terse
SET client_min_messages = warning;
\if :{?dbname}
\else
\set dbname unai
\endif

-- Every variable is checked before the first role statement.
\if :{?migrator_password}
\else
DO $$BEGIN RAISE EXCEPTION 'PROVISION_VARIABLE_REQUIRED:migrator_password'; END$$;
\endif
\if :{?api_login_password}
\else
DO $$BEGIN RAISE EXCEPTION 'PROVISION_VARIABLE_REQUIRED:api_login_password'; END$$;
\endif
\if :{?worker_login_password}
\else
DO $$BEGIN RAISE EXCEPTION 'PROVISION_VARIABLE_REQUIRED:worker_login_password'; END$$;
\endif
\if :{?auth_login_password}
\else
DO $$BEGIN RAISE EXCEPTION 'PROVISION_VARIABLE_REQUIRED:auth_login_password'; END$$;
\endif
\if :{?backup_password}
\else
DO $$BEGIN RAISE EXCEPTION 'PROVISION_VARIABLE_REQUIRED:backup_password'; END$$;
\endif
\if :{?encryption_at_rest}
\else
DO $$BEGIN RAISE EXCEPTION 'PROVISION_VARIABLE_REQUIRED:encryption_at_rest'; END$$;
\endif

-- The same pattern as DECLARATION in packages/postgres/src/encryption.ts, which
-- the API checks at startup (DATABASE_ENCRYPTION_AT_REST_REQUIRED).
SELECT :'encryption_at_rest' ~ '^(volume-kms|tde|managed):[A-Za-z0-9:/_.@+-]{1,200}$' AS provision_declaration_valid \gset
\if :provision_declaration_valid
\else
DO $$BEGIN RAISE EXCEPTION 'PROVISION_ENCRYPTION_DECLARATION_INVALID'; END$$;
\endif

-- Group roles: created only when absent, with the attributes of migrations
-- 0001_foundation.sql and 0002_authentication.sql, and never altered here.
SELECT 'CREATE ROLE unai_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'unai_app') \gexec
SELECT 'CREATE ROLE unai_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'unai_auth') \gexec

-- Login roles: created when absent, then every attribute is stated so that a
-- pre-existing role converges. psql does not interpolate inside a DO block, so
-- the password needs a plain ALTER ROLE.
SELECT 'CREATE ROLE unai_migrator' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'unai_migrator') \gexec
ALTER ROLE unai_migrator WITH LOGIN SUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5 PASSWORD :'migrator_password';
SELECT 'CREATE ROLE unai_api_login' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'unai_api_login') \gexec
ALTER ROLE unai_api_login WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 12 PASSWORD :'api_login_password';
SELECT 'CREATE ROLE unai_worker_login' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'unai_worker_login') \gexec
ALTER ROLE unai_worker_login WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 12 PASSWORD :'worker_login_password';
SELECT 'CREATE ROLE unai_auth_login' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'unai_auth_login') \gexec
ALTER ROLE unai_auth_login WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 22 PASSWORD :'auth_login_password';
SELECT 'CREATE ROLE unai_backup' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'unai_backup') \gexec
ALTER ROLE unai_backup WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION BYPASSRLS CONNECTION LIMIT 3 PASSWORD :'backup_password';

-- Memberships. A repeated grant is only a NOTICE.
GRANT unai_app TO unai_api_login WITH INHERIT TRUE;
GRANT unai_app TO unai_worker_login WITH INHERIT TRUE;
GRANT unai_auth TO unai_auth_login WITH INHERIT TRUE;
GRANT pg_read_all_data TO unai_backup WITH INHERIT TRUE;

-- Database, owned by the migration role.
SELECT format('CREATE DATABASE %I OWNER unai_migrator', :'dbname') WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'dbname') \gexec
ALTER DATABASE :"dbname" OWNER TO unai_migrator;

SELECT current_database() <> :'dbname' AS provision_reconnect \gset
\if :provision_reconnect
\connect :dbname
SET client_min_messages = warning;
\endif

CREATE EXTENSION IF NOT EXISTS vector;
ALTER DATABASE :"dbname" SET unai.encryption_at_rest = :'encryption_at_rest';
