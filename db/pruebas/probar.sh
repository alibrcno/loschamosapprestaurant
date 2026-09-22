#!/usr/bin/env bash
# =====================================================================
# Prueba la base en un Postgres LOCAL de desarrollo (nunca contra Neon).
# Crea una base desde cero imitando a Neon (rol dueño sin superusuario),
# aplica las migraciones y ejecuta las pruebas de seguridad como app_user.
#
# Uso:  PGHOST=/ruta/socket PGPORT=5433 db/pruebas/probar.sh
# Requiere un Postgres local donde el usuario "postgres" entra sin clave.
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
BD=loschamos_prueba
psql_su() { psql -X -q -v ON_ERROR_STOP=1 -U postgres "$@"; }

psql_su -d postgres <<SQL
DROP DATABASE IF EXISTS $BD;
DROP ROLE IF EXISTS app_user;
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'neondb_owner') THEN
    CREATE ROLE neondb_owner LOGIN CREATEDB CREATEROLE;   -- como en Neon: sin superusuario ni BYPASSRLS
  END IF;
END \$\$;
CREATE DATABASE $BD OWNER neondb_owner;
SQL

echo "== Migraciones (como neondb_owner) =="
for f in migrations/*.sql; do
  echo "   $f"
  psql -X -q -v ON_ERROR_STOP=1 -U neondb_owner -d $BD -f "$f"
done
psql -X -q -v ON_ERROR_STOP=1 -U neondb_owner -d $BD -f clave_app_user.sql -o /dev/null
psql -X -q -v ON_ERROR_STOP=1 -U neondb_owner -d $BD -f semillas/loschamos.sql -o /dev/null
echo "   semilla loschamos: $(psql -X -tA -U app_user -d $BD -c "select tenant_por_codigo('loschamos') is not null")"

echo "== Datos de prueba: negocios chamos-a y chamos-b =="
psql -X -q -v ON_ERROR_STOP=1 -U neondb_owner -d $BD <<'SQL'
INSERT INTO tenants (nombre, codigo) VALUES ('Chamos A', 'chamos-a'), ('Chamos B', 'chamos-b');
INSERT INTO tenants (nombre, codigo, activo) VALUES ('Cerrado', 'chamos-inactivo', false);
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT id, codigo FROM tenants WHERE codigo IN ('chamos-a', 'chamos-b') LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    INSERT INTO users (tenant_id, nombre, usuario, rol) VALUES (t.id, 'Admin', 'admin-' || right(t.codigo, 1), 'admin');
    INSERT INTO accounts (tenant_id, nombre, orden) VALUES (t.id, 'Efectivo', 1), (t.id, 'Nequi', 2), (t.id, 'Bancolombia', 3), (t.id, 'Datáfono', 4);
    INSERT INTO ledger_entries (tenant_id, account_id, tipo, monto, concepto)
      SELECT t.id, id, 'ajuste', 100000, 'Arqueo inicial' FROM accounts WHERE tenant_id = t.id AND nombre = 'Efectivo';
  END LOOP;
END $$;
SQL

echo "== El dueño de la base tampoco puede alterar el dinero =="
psql -X -q -v ON_ERROR_STOP=1 -U neondb_owner -d $BD <<'SQL'
DO $$
BEGIN
  PERFORM set_config('app.tenant_id', tenant_por_codigo('chamos-a')::text, true);
  BEGIN
    UPDATE ledger_entries SET monto = 1;
    RAISE EXCEPTION 'NO SE BLOQUEÓ';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '✅ neondb_owner no puede editar el libro contable';
  END;
  PERFORM set_config('app.tenant_id', '', true);
  IF (SELECT count(*) FROM ledger_entries) <> 0 THEN RAISE EXCEPTION 'El dueño ve datos sin tenant'; END IF;
  RAISE NOTICE '✅ neondb_owner sin negocio fijado tampoco ve datos (RLS forzado)';
END $$;
SQL

echo "== Pruebas de seguridad (como app_user) =="
psql -X -U app_user -d $BD -f pruebas/aislamiento.sql 2>&1 | sed 's/^psql:[^ ]* NOTICE:  /   /'
