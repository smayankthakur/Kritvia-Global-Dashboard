#!/usr/bin/env bash
# Runs once on first container start (docker-entrypoint-initdb.d).
# kritvia_owner owns every table, runs migrations and owns SECURITY DEFINER
# functions (BYPASSRLS so those functions can resolve access; it never serves requests).
# kritvia_app is what the API/worker connect as: no BYPASSRLS, owns nothing.
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE kritvia_owner LOGIN PASSWORD '${KRITVIA_OWNER_PASSWORD}' NOSUPERUSER BYPASSRLS;
CREATE ROLE kritvia_app   LOGIN PASSWORD '${KRITVIA_APP_PASSWORD}'   NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT ALL ON DATABASE ${POSTGRES_DB} TO kritvia_owner;
GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO kritvia_app;
ALTER SCHEMA public OWNER TO kritvia_owner;
GRANT USAGE ON SCHEMA public TO kritvia_app;
-- pgvector must be created by a superuser; later migrations use it freely.
CREATE EXTENSION IF NOT EXISTS vector;
ALTER DEFAULT PRIVILEGES FOR ROLE kritvia_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
SQL
