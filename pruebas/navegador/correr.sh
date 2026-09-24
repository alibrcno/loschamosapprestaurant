#!/usr/bin/env bash
# Pruebas en navegador real (Playwright) de punta a punta, contra un Postgres LOCAL.
# Uso:  PGHOST=/ruta/socket PGPORT=5433 npm run navegador
# Requiere Playwright con Chromium instalado aparte (npm i -g playwright); no es dependencia del proyecto.
set -euo pipefail
cd "$(dirname "$0")/../.."
export NODE_PATH="$(npm root -g)"
export DATABASE_URL="postgresql://app_user@localhost:${PGPORT:-5432}/loschamos_prueba?host=${PGHOST:-/var/run/postgresql}"
rm -rf .build && npx tsc -p tsconfig.json
# Arranca el servidor local (imita a Vercel) con la base de pruebas
arrancar() {
  HORA_APERTURA_COCINA=0 CLAVE_REINICIO=clave-de-reinicio-prueba CLAVE_INSTALACION=frase-de-prueba-larga node pruebas/navegador/servidor-local.js "$PWD" > /tmp/lc-servidor.log 2>&1 &
  SERVIDOR=$!
  trap 'kill $SERVIDOR 2>/dev/null || true' EXIT
  sleep 1
}
parar() { kill $SERVIDOR; wait $SERVIDOR 2>/dev/null || true; }

for prueba in meseras-e-impresion dia-completo; do
  echo "== $prueba =="
  bash db/pruebas/probar.sh > /dev/null   # base limpia para cada prueba
  arrancar
  curl -s -X POST localhost:8770/api/auth/instalar -H 'content-type: application/json' \
    -d '{"codigo":"loschamos","claveInstalacion":"frase-de-prueba-larga","nombre":"Alirio","usuario":"alirio","clave":"clave-admin-1"}' > /dev/null
  node pruebas/navegador/$prueba.js
  parar
done

# Después del día completo: se dejan los datos en 0 (como se hará en Neon) y se vende todo el menú
echo "== datos en 0 + todo-el-menu =="
psql -X -q -v ON_ERROR_STOP=1 -U neondb_owner -d loschamos_prueba -f db/limpieza/datos_en_cero.sql > /dev/null
arrancar
node pruebas/navegador/todo-el-menu.js
parar
