#!/usr/bin/env bash
# Prueba todo en un Postgres LOCAL: base de datos (db/pruebas/probar.sh) y luego la API.
# Uso:  PGHOST=/ruta/socket PGPORT=5433 npm run probar
set -euo pipefail
cd "$(dirname "$0")/.."
bash db/pruebas/probar.sh
echo "== API =="
rm -rf .build && npx tsc -p tsconfig.json
DATABASE_URL="postgresql://app_user@localhost:${PGPORT:-5432}/loschamos_prueba?host=${PGHOST:-/var/run/postgresql}" \
  node --test --test-concurrency=1 --test-reporter=spec .build/pruebas/*.test.js
