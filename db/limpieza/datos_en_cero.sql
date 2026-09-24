-- =====================================================================
-- Los Chamos POS · Dejar los datos en 0 antes de empezar a trabajar de verdad
-- ---------------------------------------------------------------------
-- Se ejecuta como neondb_owner en el SQL Editor de Neon, UNA vez, cuando se quiera.
-- Borra SOLO los movimientos del negocio con este código (turnos, ventas, pedidos,
-- dinero, auditoría, almacén, impresiones) y deja el stock en 0.
-- NO borra: el negocio, los usuarios, las cuentas, el menú, pizzas, extras,
-- preparaciones, artículos de inventario, logo ni avisos de Telegram y correo.
-- Todo va en una sola transacción: si algo falla, no se borra nada.
-- ESTO NO SE PUEDE DESHACER.
-- =====================================================================

BEGIN;

-- Negocio a limpiar (se fija igual que lo hace la API: así solo se ven y se borran sus filas)
SELECT set_config('app.tenant_id', tenant_por_codigo('loschamos')::text, true);
DO $$ BEGIN
  IF current_setting('app.tenant_id', true) IS NULL OR current_setting('app.tenant_id', true) = '' THEN
    RAISE EXCEPTION 'No existe un negocio activo con ese código. No se borró nada.';
  END IF;
END $$;

-- El libro contable, los pagos, la auditoría y el almacén tienen un candado que impide borrar.
-- Se quita SOLO dentro de esta transacción y se vuelve a poner al final.
ALTER TABLE ledger_entries  DISABLE TRIGGER ledger_entries_solo_agregar;
ALTER TABLE payments        DISABLE TRIGGER payments_solo_agregar;
ALTER TABLE audit_log       DISABLE TRIGGER audit_log_solo_agregar;
ALTER TABLE warehouse_moves DISABLE TRIGGER warehouse_moves_solo_agregar;

DELETE FROM print_jobs       WHERE tenant_id = current_tenant();
DELETE FROM payments         WHERE tenant_id = current_tenant();
DELETE FROM order_items      WHERE tenant_id = current_tenant();
DELETE FROM kitchen_tickets  WHERE tenant_id = current_tenant();
DELETE FROM orders           WHERE tenant_id = current_tenant();
DELETE FROM ledger_entries   WHERE tenant_id = current_tenant();
DELETE FROM warehouse_moves  WHERE tenant_id = current_tenant();
DELETE FROM inventory_entries WHERE tenant_id = current_tenant();
DELETE FROM inventory_counts WHERE tenant_id = current_tenant();
DELETE FROM shift_staff      WHERE tenant_id = current_tenant();
DELETE FROM shifts           WHERE tenant_id = current_tenant();
DELETE FROM audit_log        WHERE tenant_id = current_tenant();
UPDATE inventory_items SET stock = 0 WHERE tenant_id = current_tenant();

ALTER TABLE ledger_entries  ENABLE TRIGGER ledger_entries_solo_agregar;
ALTER TABLE payments        ENABLE TRIGGER payments_solo_agregar;
ALTER TABLE audit_log       ENABLE TRIGGER audit_log_solo_agregar;
ALTER TABLE warehouse_moves ENABLE TRIGGER warehouse_moves_solo_agregar;

-- Queda anotado en la auditoría desde cuándo empiezan los datos reales
INSERT INTO audit_log (tenant_id, accion, detalle) VALUES (current_tenant(), 'Datos en cero', 'Se borraron los datos de prueba para empezar a trabajar');

-- Revisión: todo debe salir en 0 (menos la auditoría, que queda con 1 anotación)
SELECT
  (SELECT count(*) FROM shifts)          AS turnos,
  (SELECT count(*) FROM orders)          AS pedidos,
  (SELECT count(*) FROM ledger_entries)  AS movimientos_de_dinero,
  (SELECT coalesce(sum(saldo), 0) FROM account_balances) AS dinero_en_cuentas,
  (SELECT count(*) FROM warehouse_moves) AS movimientos_almacen,
  (SELECT count(*) FROM inventory_items WHERE stock <> 0) AS articulos_con_stock,
  (SELECT count(*) FROM audit_log)       AS auditoria,
  (SELECT count(*) FROM products)        AS productos_del_menu_que_se_conservan,
  (SELECT count(*) FROM users)           AS usuarios_que_se_conservan;

COMMIT;
