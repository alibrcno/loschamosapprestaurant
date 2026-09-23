#!/usr/bin/env bash
# Pruebas en navegador real (Playwright) de punta a punta, contra un Postgres LOCAL.
# Uso:  PGHOST=/ruta/socket PGPORT=5433 npm run navegador
# Requiere Playwright con Chromium instalado aparte (npm i -g playwright); no es dependencia del proyecto.
set -euo pipefail
cd "$(dirname "$0")/../.."
export NODE_PATH="$(npm root -g)"
export DATABASE_URL="postgresql://app_user@localhost:${PGPORT:-5432}/loschamos_prueba?host=${PGHOST:-/var/run/postgresql}"
rm -rf .build && npx tsc -p tsconfig.json
for prueba in dia-completo meseras-e-impresion; do
  echo "== $prueba =="
  bash db/pruebas/probar.sh > /dev/null   # base limpia para cada prueba
  HORA_APERTURA_COCINA=0 CLAVE_INSTALACION=frase-de-prueba-larga node pruebas/navegador/servidor-local.js "$PWD" > /tmp/lc-servidor.log 2>&1 &
  SERVIDOR=$!
  trap 'kill $SERVIDOR 2>/dev/null || true' EXIT
  sleep 1
  curl -s -X POST localhost:8770/api/auth/instalar -H 'content-type: application/json' \
    -d '{"codigo":"loschamos","claveInstalacion":"frase-de-prueba-larga","nombre":"Alirio","usuario":"alirio","clave":"clave-admin-1"}' > /dev/null
  node pruebas/navegador/$prueba.js
  kill $SERVIDOR; wait $SERVIDOR 2>/dev/null || true
done
