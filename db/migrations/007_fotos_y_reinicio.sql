-- =====================================================================
-- Los Chamos POS · 007 Fotos de facturas y botón "Reiniciar el restaurante a 0"
-- ---------------------------------------------------------------------
-- Se ejecuta UNA vez, como neondb_owner, después de 001 a 006.
-- =====================================================================

BEGIN;

-- 1. Foto de la factura al registrar una llegada de mercancía (opcional).
--    La app la achica en el celular antes de subirla. Se borran solas a los 15 días.
CREATE TABLE invoice_photos (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  imagen     text NOT NULL CHECK (imagen LIKE 'data:image/%' AND length(imagen) <= 700000),
  user_id    uuid,
  creado_en  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
);
CREATE INDEX ON invoice_photos (tenant_id, creado_en);
ALTER TABLE invoice_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_photos FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoice_photos USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
GRANT SELECT, INSERT, DELETE ON invoice_photos TO app_user;

-- Cada artículo de la llegada apunta a la foto de su factura. Si la foto se borra (15 días),
-- el artículo queda igual, solo sin foto.
ALTER TABLE inventory_entries ADD COLUMN foto_id uuid;
ALTER TABLE inventory_entries ADD CONSTRAINT inventory_entries_foto_fkey
  FOREIGN KEY (tenant_id, foto_id) REFERENCES invoice_photos(tenant_id, id) ON DELETE SET NULL (foto_id);

-- 2. Reiniciar el restaurante a 0 (lo pide el dueño desde la app, con su clave de reinicio).
--    El libro contable, los pagos, la auditoría y el almacén siguen sin poderse editar ni borrar.
--    La ÚNICA excepción es esta función: borra las filas del negocio fijado en la transacción,
--    y solo si no hay un turno abierto. app_user no tiene permiso de borrar esas tablas: solo
--    puede llamar a la función (y la API solo la llama para el administrador con la clave).
CREATE OR REPLACE FUNCTION solo_agregar() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.reiniciando', true) = 'si' THEN
    IF OLD.tenant_id = current_tenant() THEN RETURN OLD; END IF;
  END IF;
  RAISE EXCEPTION 'La tabla % no se puede % : registra un movimiento de corrección', TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE FUNCTION reiniciar_negocio() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  t uuid := current_tenant();
  antes jsonb;
BEGIN
  IF t IS NULL THEN RAISE EXCEPTION 'No hay negocio fijado'; END IF;
  IF EXISTS (SELECT 1 FROM shifts WHERE tenant_id = t AND cerrado_en IS NULL) THEN
    RAISE EXCEPTION 'Hay un turno abierto: ciérralo antes de reiniciar' USING ERRCODE = 'check_violation';
  END IF;
  antes := jsonb_build_object(
    'turnos', (SELECT count(*) FROM shifts WHERE tenant_id = t),
    'pedidos', (SELECT count(*) FROM orders WHERE tenant_id = t),
    'movimientos', (SELECT count(*) FROM ledger_entries WHERE tenant_id = t),
    'fotos', (SELECT count(*) FROM invoice_photos WHERE tenant_id = t));
  PERFORM set_config('app.reiniciando', 'si', true);
  DELETE FROM print_jobs        WHERE tenant_id = t;
  DELETE FROM payments          WHERE tenant_id = t;
  DELETE FROM order_items       WHERE tenant_id = t;
  DELETE FROM kitchen_tickets   WHERE tenant_id = t;
  DELETE FROM orders            WHERE tenant_id = t;
  DELETE FROM ledger_entries    WHERE tenant_id = t;
  DELETE FROM warehouse_moves   WHERE tenant_id = t;
  DELETE FROM inventory_entries WHERE tenant_id = t;
  DELETE FROM invoice_photos    WHERE tenant_id = t;
  DELETE FROM inventory_counts  WHERE tenant_id = t;
  DELETE FROM shift_staff       WHERE tenant_id = t;
  DELETE FROM shifts            WHERE tenant_id = t;
  DELETE FROM audit_log         WHERE tenant_id = t;
  UPDATE inventory_items SET stock = 0 WHERE tenant_id = t;
  PERFORM set_config('app.reiniciando', '', true);
  RETURN antes;
END $$;
REVOKE EXECUTE ON FUNCTION reiniciar_negocio() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reiniciar_negocio() TO app_user;

COMMIT;
