-- Run ONCE on a managed Postgres (RDS, Cloud SQL, Neon…) as the master user before the first
-- migration. Same roles as infra/postgres/00-roles.sh, which only runs inside the container.
-- Replace the two passwords (psql: \set owner_pw '...' then :'owner_pw', or edit in place).
--
--   psql "postgresql://<master>:<pw>@<host>:5432/postgres" -v owner_pw='…' -v app_pw='…' -f managed-roles.sql
CREATE DATABASE kritvia;
CREATE ROLE kritvia_owner LOGIN PASSWORD :'owner_pw' NOSUPERUSER BYPASSRLS;
CREATE ROLE kritvia_app   LOGIN PASSWORD :'app_pw'   NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT ALL ON DATABASE kritvia TO kritvia_owner;
GRANT CONNECT ON DATABASE kritvia TO kritvia_app;
\connect kritvia
-- RDS: the master user is not a superuser but may create these extensions.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
ALTER SCHEMA public OWNER TO kritvia_owner;
GRANT USAGE ON SCHEMA public TO kritvia_app;
ALTER DEFAULT PRIVILEGES FOR ROLE kritvia_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
