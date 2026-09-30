#!/usr/bin/env bash
# Recreate a local dev/test database without Docker (mirrors the container init).
set -euo pipefail
DB=${1:-kritvia}
psql -q -U postgres -h localhost -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
psql -q -U postgres -h localhost -tc "SELECT 1 FROM pg_roles WHERE rolname='kritvia_owner'" | grep -q 1 || {
  psql -q -U postgres -h localhost <<SQL
CREATE ROLE kritvia_owner LOGIN PASSWORD '${KRITVIA_OWNER_PASSWORD:-owner}' NOSUPERUSER BYPASSRLS;
CREATE ROLE kritvia_app   LOGIN PASSWORD '${KRITVIA_APP_PASSWORD:-app}'   NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
SQL
}
psql -q -U postgres -h localhost -d "$DB" <<SQL
ALTER ROLE kritvia_owner NOSUPERUSER BYPASSRLS;
ALTER ROLE kritvia_app NOSUPERUSER NOBYPASSRLS;
GRANT ALL ON DATABASE $DB TO kritvia_owner;
GRANT CONNECT ON DATABASE $DB TO kritvia_app;
ALTER SCHEMA public OWNER TO kritvia_owner;
GRANT USAGE ON SCHEMA public TO kritvia_app;
CREATE EXTENSION IF NOT EXISTS vector;
ALTER DEFAULT PRIVILEGES FOR ROLE kritvia_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
SQL
