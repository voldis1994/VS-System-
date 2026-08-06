#!/usr/bin/env bash
# Idempotently bring up the local PostgreSQL cluster and ensure the
# NEXUS role/database exist. Safe to run on every boot and multiple times.
set -euo pipefail

PG_VER="${PG_VER:-16}"
DB_USER="${DB_USER:-nexus}"
DB_PASS="${DB_PASS:-nexus}"
DB_NAME="${DB_NAME:-nexus_pro}"

# Start the cluster only if it is not already accepting connections.
if ! sudo -u postgres pg_isready -q 2>/dev/null; then
  sudo pg_ctlcluster "$PG_VER" main start
fi

# Wait for readiness (bounded).
for _ in $(seq 1 30); do
  if sudo -u postgres pg_isready -q 2>/dev/null; then
    break
  fi
  sleep 1
done

# Ensure the application role exists.
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1; then
  sudo -u postgres psql -c "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}';"
fi

# Ensure the application database exists.
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  sudo -u postgres createdb -O "${DB_USER}" "${DB_NAME}"
fi

echo "PostgreSQL ${PG_VER} ready — role='${DB_USER}' db='${DB_NAME}'"
