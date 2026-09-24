-- =====================================================================
-- Crea el negocio Los Chamos con sus 4 cuentas de dinero.
-- ---------------------------------------------------------------------
-- Se ejecuta UNA vez, como neondb_owner, después de las migraciones.
-- El menú, el inventario, los turnos y los movimientos llegan después,
-- al importar el respaldo (fase 4). Los usuarios crean contraseña nueva.
-- =====================================================================

BEGIN;

INSERT INTO tenants (nombre, codigo, whatsapp)
VALUES ('Los Chamos', 'loschamos', '573218382315');

SELECT set_config('app.tenant_id', (SELECT id::text FROM tenants WHERE codigo = 'loschamos'), true);

INSERT INTO accounts (tenant_id, nombre, orden)
SELECT current_tenant(), nombre, orden
FROM (VALUES ('Efectivo', 1), ('Nequi', 2), ('Bancolombia', 3), ('Datáfono', 4)) AS c(nombre, orden);

SELECT nombre, codigo FROM tenants WHERE codigo = 'loschamos';

COMMIT;
