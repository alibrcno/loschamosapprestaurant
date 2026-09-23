-- =====================================================================
-- Los Chamos POS · 003 Cierre del turno en dos pasos
-- ---------------------------------------------------------------------
-- Se ejecuta UNA vez, como neondb_owner, después de 001 y 002.
--
-- 1. La encargada cierra la CAJA (arqueo, bebidas, utensilios): caja_cerrada_en.
-- 2. Cocina hace su inventario al final de la noche y con eso el TURNO termina:
--    cerrado_en. El resultado del día (utilidad) se calcula en ese último paso.
-- Mientras cocina no termine, el turno sigue "abierto" para la base (no se puede
-- abrir otro), pero ya no se puede vender ni mover dinero en él.
-- =====================================================================

BEGIN;

ALTER TABLE shifts
  ADD COLUMN caja_cerrada_en  timestamptz,
  ADD COLUMN caja_cerrada_por uuid,
  ADD CONSTRAINT shifts_caja_cerrada_por_fkey FOREIGN KEY (tenant_id, caja_cerrada_por) REFERENCES users(tenant_id, id),
  ADD CONSTRAINT shifts_caja_cerrada_check CHECK ((caja_cerrada_en IS NULL) = (caja_cerrada_por IS NULL)),
  -- El turno solo termina con la caja ya cerrada
  ADD CONSTRAINT shifts_orden_cierre_check CHECK (cerrado_en IS NULL OR caja_cerrada_en IS NOT NULL);

-- Los permisos de app_user sobre shifts (SELECT, INSERT, UPDATE) cubren las columnas nuevas.

COMMIT;
