-- Datos como los que ya hay en Neon antes de la migración 005: un negocio con un turno ya
-- cerrado (caja y cocina), una cuenta cobrada con su comanda y su impresión. Sirve para probar
-- que las migraciones nuevas se pueden aplicar sobre una base que ya tiene datos.
BEGIN;
INSERT INTO tenants (nombre, codigo) VALUES ('Chamos Viejo', 'chamos-viejo');
SELECT set_config('app.tenant_id', tenant_por_codigo('chamos-viejo')::text, true);
INSERT INTO users (tenant_id, nombre, usuario, rol) VALUES (current_tenant(), 'Dueño viejo', 'viejo', 'admin');
INSERT INTO accounts (tenant_id, nombre, orden) VALUES (current_tenant(), 'Efectivo', 1);
INSERT INTO shifts (tenant_id, abierto_en, abierto_por, caja_cerrada_en, caja_cerrada_por, cerrado_en, cerrado_por, cocina_cierre)
  SELECT current_tenant(), now() - interval '1 day', id, now() - interval '20 hours', id, now() - interval '19 hours', id, '{"conteo": {}}' FROM users;
INSERT INTO shifts (tenant_id, abierto_en, abierto_por) SELECT current_tenant(), now() - interval '2 hours', id FROM users; -- turno abierto hoy
INSERT INTO orders (tenant_id, shift_id, numero, tipo, mesa, estado, cerrado_en)
  SELECT current_tenant(), id, 1, 'mesa', 1, 'pagada', now() - interval '21 hours' FROM shifts WHERE cerrado_en IS NOT NULL;
INSERT INTO kitchen_tickets (tenant_id, order_id, numero) SELECT current_tenant(), id, 1 FROM orders;
INSERT INTO inventory_items (tenant_id, tipo, nombre) VALUES (current_tenant(), 'insumo', 'Queso');
INSERT INTO inventory_entries (tenant_id, item_id, cantidad, motivo) SELECT current_tenant(), id, 2, 'llegada' FROM inventory_items;
INSERT INTO categories (tenant_id, nombre) VALUES (current_tenant(), 'Arepas');
COMMIT;
