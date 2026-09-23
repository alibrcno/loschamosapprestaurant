-- =====================================================================
-- Pruebas de seguridad de la base. Se ejecutan conectados como app_user,
-- igual que la API. Si algo falla, psql se detiene con el error.
-- Datos: dos negocios de prueba, "chamos-a" y "chamos-b" (ver probar.sh).
-- =====================================================================
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

-- Ayudante: ejecuta un SQL que DEBE fallar. Si no falla, la prueba se detiene.
CREATE FUNCTION pg_temp.debe_fallar(sql text, que text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE sql;
  EXCEPTION WHEN others THEN
    RAISE NOTICE '✅ %  (bloqueado: %)', que, SQLERRM;
    RETURN;
  END;
  RAISE EXCEPTION '❌ NO SE BLOQUEÓ: %', que;
END $$;
CREATE FUNCTION pg_temp.ok(cond boolean, que text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION '❌ FALLÓ: %', que; END IF;
  RAISE NOTICE '✅ %', que;
END $$;

\echo '--- Sin negocio fijado no se ve nada ---'
SELECT pg_temp.ok((SELECT count(*) FROM accounts) = 0, 'Sin app.tenant_id no se ve ninguna cuenta');
SELECT pg_temp.ok((SELECT count(*) FROM tenants) = 0, 'Sin app.tenant_id no se ve ningún negocio');
SELECT pg_temp.debe_fallar($$INSERT INTO accounts (tenant_id, nombre) VALUES (tenant_por_codigo('chamos-a'), 'Hackeo')$$,
  'Sin negocio fijado no se puede insertar');

\echo '--- Ingreso con código de negocio ---'
SELECT pg_temp.ok(tenant_por_codigo('chamos-a') IS NOT NULL, 'El código chamos-a lleva a su negocio');
SELECT pg_temp.ok(tenant_por_codigo('  CHAMOS-A ') = tenant_por_codigo('chamos-a'), 'El código ignora mayúsculas y espacios');
SELECT pg_temp.ok(tenant_por_codigo('no-existe') IS NULL, 'Un código inexistente no devuelve nada');
SELECT pg_temp.ok(tenant_por_codigo('chamos-inactivo') IS NULL, 'Un negocio desactivado no puede ingresar');

-- Guardamos los ids para usarlos en las pruebas
SELECT tenant_por_codigo('chamos-a') AS ta, tenant_por_codigo('chamos-b') AS tb \gset
-- Id de la cuenta Efectivo de A, como si un atacante lo hubiera averiguado
BEGIN;
SELECT set_config('app.tenant_id', :'ta', true) \gset
SELECT id AS cuenta_a FROM accounts WHERE nombre = 'Efectivo' \gset
COMMIT;

\echo '--- Negocio B no ve ni toca nada de A ---'
BEGIN;
SELECT set_config('app.tenant_id', :'tb', true) \gset
SELECT pg_temp.ok((SELECT count(*) FROM tenants) = 1 AND (SELECT codigo FROM tenants) = 'chamos-b', 'B solo ve su propio negocio');
SELECT pg_temp.ok((SELECT count(*) FROM accounts) = 4, 'B ve sus 4 cuentas');
SELECT pg_temp.ok((SELECT count(*) FROM ledger_entries) = 1, 'B ve solo su movimiento');
SELECT pg_temp.ok((SELECT count(*) FROM users) = 1 AND (SELECT usuario FROM users) = 'admin-b', 'B ve solo sus usuarios');
SELECT pg_temp.ok((SELECT count(*) FROM ledger_entries WHERE tenant_id = :'ta') = 0, 'Aunque B pida filas de A por su id, no aparecen');
SELECT pg_temp.debe_fallar(format($$INSERT INTO accounts (tenant_id, nombre) VALUES (%L, 'Robada')$$, :'ta'),
  'B no puede crear filas a nombre de A');
-- Cuenta de A usada en un movimiento de B: la llave compuesta (tenant_id, account_id) lo impide
SELECT pg_temp.debe_fallar(format($$INSERT INTO ledger_entries (tenant_id, account_id, tipo, monto, concepto)
  VALUES (%L, %L, 'venta', 1000, 'x')$$, :'tb', :'cuenta_a'),
  'B no puede cargar un movimiento a la cuenta de A (aunque conozca su id)');
WITH u AS (UPDATE accounts SET nombre = 'X' WHERE id = :'cuenta_a' RETURNING 1)
SELECT pg_temp.ok((SELECT count(*) FROM u) = 0, 'B no puede modificar la cuenta de A (0 filas afectadas)');
WITH d AS (DELETE FROM users WHERE tenant_id = :'ta' RETURNING 1)
SELECT pg_temp.ok((SELECT count(*) FROM d) = 0, 'B no puede borrar usuarios de A (0 filas afectadas)');
SELECT pg_temp.debe_fallar($$UPDATE tenants SET codigo = 'otro'$$, 'B no puede cambiar su código de negocio');
SELECT pg_temp.debe_fallar($$UPDATE tenants SET activo = true$$, 'B no puede cambiar si está activo');
SELECT pg_temp.debe_fallar($$UPDATE tenants SET plan = 'premium'$$, 'B no puede cambiarse de plan');
SELECT pg_temp.debe_fallar($$INSERT INTO tenants (nombre, codigo) VALUES ('Nuevo', 'nuevo')$$, 'B no puede crear negocios');
WITH u AS (UPDATE tenants SET whatsapp = '573000000000' RETURNING 1)
SELECT pg_temp.ok((SELECT count(*) FROM u) = 1, 'B sí puede cambiar el WhatsApp de su propio negocio');
ROLLBACK;

\echo '--- El libro contable no se edita ni se borra ---'
BEGIN;
SELECT set_config('app.tenant_id', :'ta', true) \gset
SELECT pg_temp.debe_fallar($$UPDATE ledger_entries SET monto = 1$$, 'No se puede editar un movimiento');
SELECT pg_temp.debe_fallar($$DELETE FROM ledger_entries$$, 'No se puede borrar un movimiento');
SELECT pg_temp.debe_fallar($$TRUNCATE ledger_entries$$, 'No se puede vaciar el libro');
SELECT pg_temp.debe_fallar($$DELETE FROM audit_log$$, 'No se puede borrar la auditoría');
SELECT pg_temp.debe_fallar($$UPDATE payments SET monto = 1$$, 'No se puede editar un pago');
SELECT pg_temp.debe_fallar($$INSERT INTO ledger_entries (tenant_id, account_id, tipo, monto, concepto)
  VALUES (current_tenant(), (SELECT id FROM accounts WHERE nombre = 'Nequi'), 'venta', 0, 'cero')$$, 'No se aceptan movimientos de $0');
-- OJO: Postgres convierte 1000.5 a 1001 sin avisar. La base nunca guarda centavos,
-- pero es la API la que debe RECHAZAR montos con decimales antes de llegar aquí.
INSERT INTO ledger_entries (tenant_id, account_id, tipo, monto, concepto)
  VALUES (current_tenant(), (SELECT id FROM accounts WHERE nombre = 'Nequi'), 'venta', 1000.5, 'decimales');
SELECT pg_temp.ok((SELECT monto FROM ledger_entries WHERE concepto = 'decimales') = 1001,
  'El libro solo guarda pesos enteros (redondea: la API debe rechazar decimales)');
SELECT pg_temp.debe_fallar($$DROP TABLE ledger_entries$$, 'app_user no puede borrar tablas');

-- Corregir un error: gasto mal registrado de $20.000 → se reversa con un movimiento nuevo
INSERT INTO ledger_entries (tenant_id, account_id, tipo, monto, concepto, categoria)
VALUES (current_tenant(), (SELECT id FROM accounts WHERE nombre = 'Efectivo'), 'gasto', -20000, 'Gas (equivocado)', 'Otros');
INSERT INTO ledger_entries (tenant_id, account_id, tipo, monto, concepto, corrige_id)
SELECT tenant_id, account_id, 'reverso', -monto, 'Reverso: se registró por error', id FROM ledger_entries WHERE concepto = 'Gas (equivocado)';
SELECT pg_temp.ok((SELECT saldo FROM account_balances WHERE nombre = 'Efectivo') = 100000, 'Tras el reverso el saldo de Efectivo vuelve a $100.000');
SELECT pg_temp.debe_fallar($$INSERT INTO ledger_entries (tenant_id, account_id, tipo, monto, concepto, corrige_id)
  SELECT tenant_id, account_id, 'reverso', -monto, 'Reverso doble', id FROM ledger_entries WHERE concepto = 'Gas (equivocado)'$$,
  'Un movimiento no se puede reversar dos veces');
SELECT pg_temp.ok((SELECT count(*) FROM ledger_entries) = 4, 'El error y su corrección quedan a la vista en el libro');
ROLLBACK;

\echo '--- Turnos, órdenes y hora de Colombia ---'
BEGIN;
SELECT set_config('app.tenant_id', :'ta', true) \gset
-- Turno abierto a las 4 p. m. del 22 de septiembre en Colombia (21:00 UTC). Una venta a la 1 a. m. del 23 sigue siendo de ese turno.
INSERT INTO shifts (tenant_id, abierto_en, abierto_por) SELECT current_tenant(), '2026-09-22 16:00-05', id FROM users LIMIT 1;
SELECT pg_temp.ok((SELECT dia FROM shifts) = '2026-09-22', 'Turno de las 4 p. m. pertenece al 22 de septiembre');
SELECT pg_temp.ok(dia_colombia('2026-09-23 06:00Z') = '2026-09-23' AND dia_colombia('2026-09-23 04:59Z') = '2026-09-22',
  'Las 11:59 p. m. en Colombia (04:59 UTC del 23) todavía es 22 de septiembre');
SELECT pg_temp.debe_fallar($$INSERT INTO shifts (tenant_id, abierto_por) SELECT current_tenant(), id FROM users LIMIT 1$$,
  'No se pueden tener dos turnos abiertos a la vez');
SELECT pg_temp.debe_fallar($$UPDATE shifts SET cerrado_en = now(), cerrado_por = abierto_por$$,
  'El turno no puede terminar antes de que la encargada cierre la caja');
SAVEPOINT caja;
UPDATE shifts SET caja_cerrada_en = now(), caja_cerrada_por = abierto_por;
SELECT pg_temp.debe_fallar($$INSERT INTO shifts (tenant_id, abierto_por) SELECT current_tenant(), id FROM users LIMIT 1$$,
  'Con la caja cerrada pero cocina sin inventario, todavía no se puede abrir otro turno');
ROLLBACK TO SAVEPOINT caja;
INSERT INTO orders (tenant_id, shift_id, numero, tipo, mesa) SELECT current_tenant(), id, 1, 'mesa', 3 FROM shifts;
SELECT pg_temp.debe_fallar($$INSERT INTO orders (tenant_id, shift_id, numero, tipo, mesa) SELECT current_tenant(), id, 2, 'mesa', 3 FROM shifts$$,
  'La mesa 3 no puede tener dos cuentas abiertas');
SELECT pg_temp.debe_fallar($$INSERT INTO order_items (tenant_id, order_id, nombre, precio, qty, anulada)
  SELECT current_tenant(), id, 'Pizza', 45000, 1, true FROM orders$$, 'No se puede anular un producto sin motivo ni responsable');
-- Pago dividido: mitad Nequi, mitad efectivo, cada pago con su movimiento en el libro
WITH l AS (
  INSERT INTO ledger_entries (tenant_id, shift_id, account_id, tipo, monto, concepto, ref_id)
  SELECT current_tenant(), o.shift_id, a.id, 'venta', 31000, 'Mesa 3, orden #001', o.id
  FROM orders o, accounts a WHERE a.nombre IN ('Nequi', 'Efectivo') RETURNING *
)
INSERT INTO payments (tenant_id, order_id, account_id, monto, ledger_id) SELECT tenant_id, ref_id, account_id, monto, id FROM l;
UPDATE orders SET estado = 'pagada', cerrado_en = now();
SELECT pg_temp.ok((SELECT sum(saldo) FROM account_balances) = 162000, 'Saldos: $100.000 de base + $62.000 de la venta');
SELECT pg_temp.ok((SELECT saldo FROM account_balances WHERE nombre = 'Nequi') = 31000, 'Nequi recibió $31.000');
ROLLBACK;

\echo ''
\echo '🎉 Todas las pruebas de seguridad pasaron'
