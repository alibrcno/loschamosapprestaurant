-- =====================================================================
-- Los Chamos POS · 004 Pedidos en el servidor y cola de impresión
-- ---------------------------------------------------------------------
-- Se ejecuta UNA vez, como neondb_owner, después de 001, 002 y 003.
--
-- Parte 4: las meseras toman pedidos en su celular y TODO se imprime en el
-- PC de caja (que tiene la impresora). Cada comanda, pre-cuenta o recibo queda
-- en print_jobs y el PC de caja los va imprimiendo.
-- =====================================================================

BEGIN;

-- Cada cambio de una cuenta (productos, comandas, cobro) actualiza esta hora.
-- Así cada celular pide solo lo que cambió desde la última vez.
ALTER TABLE orders ADD COLUMN actualizado_en timestamptz NOT NULL DEFAULT now();
CREATE INDEX ON orders (tenant_id, shift_id, actualizado_en);

-- Envío de la mesera que agregó el producto. Si el celular reintenta el mismo envío
-- (porque se cortó el internet a mitad), el servidor lo reconoce y no lo duplica.
ALTER TABLE order_items ADD COLUMN lote uuid;
CREATE INDEX ON order_items (tenant_id, lote);

-- Cola de impresión: la llena la API, la vacía el PC de caja.
CREATE TABLE print_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shift_id     uuid NOT NULL,
  order_id     uuid NOT NULL,
  tipo         text NOT NULL CHECK (tipo IN ('comanda','precuenta','recibo','domicilio')),
  titulo       text NOT NULL,
  datos        jsonb NOT NULL,                     -- foto de la cuenta en ese momento
  creado_por   uuid,
  creado_en    timestamptz NOT NULL DEFAULT now(),
  impreso_en   timestamptz,
  impreso_por  uuid,
  FOREIGN KEY (tenant_id, shift_id)    REFERENCES shifts(tenant_id, id),
  FOREIGN KEY (tenant_id, order_id)    REFERENCES orders(tenant_id, id),
  FOREIGN KEY (tenant_id, creado_por)  REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, impreso_por) REFERENCES users(tenant_id, id),
  CHECK ((impreso_en IS NULL) = (impreso_por IS NULL))
);
CREATE INDEX ON print_jobs (tenant_id, creado_en) WHERE impreso_en IS NULL;
CREATE INDEX ON print_jobs (tenant_id, shift_id, creado_en);

ALTER TABLE print_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE print_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON print_jobs USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());

-- La API crea trabajos y marca cuándo se imprimieron; no los borra ni cambia su contenido.
GRANT SELECT, INSERT ON print_jobs TO app_user;
GRANT UPDATE (impreso_en, impreso_por) ON print_jobs TO app_user;

COMMIT;
