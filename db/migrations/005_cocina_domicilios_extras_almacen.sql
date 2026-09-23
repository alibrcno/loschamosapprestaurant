-- =====================================================================
-- Los Chamos POS · 005 Cocina abre primero, notas de comanda, domicilios,
--                     extras por categoría y almacén del dueño
-- ---------------------------------------------------------------------
-- Se ejecuta UNA vez, como neondb_owner, después de 001 a 004.
-- =====================================================================

BEGIN;

-- 1. Cocina abre el turno desde las 2 p. m.; la encargada abre la CAJA después.
--    El turno existe desde que abre cocina; se vende solo con la caja abierta.
ALTER TABLE shifts
  ADD COLUMN caja_abierta_en  timestamptz,
  ADD COLUMN caja_abierta_por uuid;
-- Los turnos de antes los abrió la encargada: la caja se abrió al mismo tiempo que el turno.
-- (Se llena ANTES de poner las reglas, porque los turnos ya cerrados las necesitan cumplidas.)
-- El aislamiento por negocio (RLS) está forzado incluso para el dueño de la base: sin negocio fijado
-- el UPDATE no vería ningún turno. Se quita el "forzado" solo durante esta transacción y se vuelve a poner.
ALTER TABLE shifts NO FORCE ROW LEVEL SECURITY;
UPDATE shifts SET caja_abierta_en = abierto_en, caja_abierta_por = abierto_por;
ALTER TABLE shifts FORCE ROW LEVEL SECURITY;
ALTER TABLE shifts
  ADD CONSTRAINT shifts_caja_abierta_por_fkey FOREIGN KEY (tenant_id, caja_abierta_por) REFERENCES users(tenant_id, id),
  ADD CONSTRAINT shifts_caja_abierta_check CHECK ((caja_abierta_en IS NULL) = (caja_abierta_por IS NULL)),
  ADD CONSTRAINT shifts_caja_orden_check CHECK (caja_cerrada_en IS NULL OR caja_abierta_en IS NOT NULL);

-- 2. Nota general de la mesera para cocina en cada comanda ("la mesa 3 tiene afán")
ALTER TABLE kitchen_tickets ADD COLUMN nota text;

-- 3. Domicilio: cómo dice el cliente que va a pagar (Efectivo, Nequi…)
ALTER TABLE orders ADD COLUMN pago_cliente text;

-- 4. Extras por categoría: [{"nombre": "Queso extra", "precio": 3000}, ...]
ALTER TABLE categories ADD COLUMN extras jsonb NOT NULL DEFAULT '[]';

-- 5. Almacén del dueño: insumos guardados aparte que la encargada no cuenta.
--    Lo que hay = suma de sus movimientos (entradas +, salidas −), como el libro contable:
--    no se edita ni se borra; un error se corrige con otro movimiento.
CREATE TABLE warehouse_moves (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_id      uuid NOT NULL,
  cantidad     numeric(14,3) NOT NULL CHECK (cantidad <> 0),   -- + entra al almacén / − sale
  tipo         text NOT NULL CHECK (tipo IN ('entrada','salida','ajuste')),
  costo_total  bigint NOT NULL DEFAULT 0 CHECK (costo_total >= 0),
  account_id   uuid,                                          -- si la compra se pagó de una cuenta del negocio
  shift_id     uuid,                                          -- turno al que pasó una salida
  nota         text,
  user_id      uuid,
  creado_en    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, item_id)    REFERENCES inventory_items(tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id)   REFERENCES shifts(tenant_id, id),
  FOREIGN KEY (tenant_id, user_id)    REFERENCES users(tenant_id, id),
  CHECK (tipo <> 'entrada' OR cantidad > 0),
  CHECK (tipo <> 'salida' OR cantidad < 0),
  CHECK (tipo <> 'ajuste' OR length(trim(coalesce(nota, ''))) > 0)
);
CREATE INDEX ON warehouse_moves (tenant_id, item_id);
CREATE TRIGGER warehouse_moves_solo_agregar BEFORE UPDATE OR DELETE ON warehouse_moves FOR EACH ROW EXECUTE FUNCTION solo_agregar();
CREATE TRIGGER warehouse_moves_sin_truncate BEFORE TRUNCATE ON warehouse_moves FOR EACH STATEMENT EXECUTE FUNCTION solo_agregar();
ALTER TABLE warehouse_moves ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_moves FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON warehouse_moves USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());
GRANT SELECT, INSERT ON warehouse_moves TO app_user;

-- Stock mínimo que el dueño quiere tener en el almacén (para avisar cuándo reponerlo)
ALTER TABLE inventory_items ADD COLUMN almacen_minimo numeric(14,3) NOT NULL DEFAULT 0 CHECK (almacen_minimo >= 0);

-- Lo que sale del almacén entra al stock del día como una llegada más (motivo 'almacen')
ALTER TABLE inventory_entries DROP CONSTRAINT inventory_entries_motivo_check;
ALTER TABLE inventory_entries ADD CONSTRAINT inventory_entries_motivo_check CHECK (motivo IN ('llegada','ajuste','almacen'));

COMMIT;
