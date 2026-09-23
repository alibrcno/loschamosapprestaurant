// /api/almacen  (permiso almacen.gestionar: solo el dueño o a quien él autorice)
//   GET                                                   → existencias, avalúo y últimos movimientos
//   POST { accion: 'entrada', itemId, cantidad, costo?, cuenta?, nota? } → guarda mercancía en el almacén
//   POST { accion: 'salida',  itemId, cantidad, nota? }   → la saca al stock del día (entra al turno como llegada)
//   POST { accion: 'ajuste',  itemId, cantidad, nota }     → corrige lo que hay (cantidad = lo contado), con motivo
//   POST { accion: 'minimo',  itemId, minimo }             → stock mínimo que quiere tener en el almacén
// Los movimientos no se editan ni se borran: un error se corrige con un ajuste.
import { auditar, conUsuario } from '../_lib/auth';
import { avaluoAlmacen, existenciasAlmacen } from '../_lib/almacen';
import { cantidad } from '../_lib/catalogo';
import { esUuid } from '../_lib/db';
import { ErrorApi, json, leerJson, pesos, ruta, texto } from '../_lib/http';
import { cuentaId, exigirTurnoActivo, leerObs, registrar, turnoActual } from '../_lib/turno';

async function estado(db: import('pg').PoolClient) {
  const movs = (await db.query(
    `SELECT m.id, m.creado_en AS fecha, m.tipo, m.cantidad, m.costo_total AS costo, coalesce(m.nota, '') AS nota,
            i.nombre, i.unidad, coalesce(u.nombre, '') AS usuario, a.nombre AS cuenta
     FROM warehouse_moves m JOIN inventory_items i ON i.id = m.item_id LEFT JOIN users u ON u.id = m.user_id
     LEFT JOIN accounts a ON a.id = m.account_id ORDER BY m.creado_en DESC LIMIT 60`)).rows;
  return { ...(await avaluoAlmacen(db)), movimientos: movs.map((m) => ({ ...m, cantidad: Number(m.cantidad) })) };
}

export const GET = ruta(async (req) => json(await conUsuario(req, 'almacen.gestionar', estado)));

export const POST = ruta(async (req) => {
  const b = await leerJson(req);
  const r = await conUsuario(req, 'almacen.gestionar', async (db, u) => {
    if (!esUuid(b.itemId)) throw new ErrorApi(400, 'Elige el artículo');
    const it = (await db.query('SELECT id, nombre, unidad, costo FROM inventory_items WHERE id = $1 AND activo FOR UPDATE', [b.itemId])).rows[0];
    if (!it) throw new ErrorApi(404, 'Ese artículo no existe');
    const nota = leerObs(b.nota, 120) || null;
    const hay = (await existenciasAlmacen(db))[it.id] || 0;

    if (b.accion === 'minimo') {
      await db.query('UPDATE inventory_items SET almacen_minimo = $2 WHERE id = $1', [it.id, cantidad(b.minimo, 'El mínimo')]);
      return estado(db);
    }
    if (b.accion === 'ajuste') {
      const contado = cantidad(b.cantidad, 'Lo contado');
      const motivo = texto(b.nota, 'el motivo del ajuste', { max: 120 });
      const dif = Math.round((contado - hay) * 1000) / 1000;
      if (!dif) throw new ErrorApi(400, 'Lo contado es igual a lo que ya dice el almacén');
      await db.query('INSERT INTO warehouse_moves (tenant_id, item_id, cantidad, tipo, nota, user_id) VALUES ($1, $2, $3, $4, $5, $6)',
        [u.tenant_id, it.id, dif, 'ajuste', motivo, u.id]);
      await auditar(db, u.tenant_id, u.id, 'Ajuste de almacén', `${it.nombre}: ${hay} a ${contado} ${it.unidad}. Motivo: ${motivo}`);
      return estado(db);
    }
    const cant = cantidad(b.cantidad, 'La cantidad');
    if (cant <= 0) throw new ErrorApi(400, 'La cantidad debe ser mayor a 0');

    if (b.accion === 'entrada') {
      const costo = b.costo === undefined || b.costo === null || b.costo === '' ? 0 : pesos(b.costo, 'El valor pagado');
      const cuenta = b.cuenta ? await cuentaId(db, b.cuenta) : null;
      if (cuenta && !costo) throw new ErrorApi(400, 'Si se pagó desde una cuenta, escribe el valor pagado');
      // El costo unitario del artículo se actualiza con esta compra (sirve para el avalúo y el costo de lo consumido)
      if (costo > 0) await db.query('UPDATE inventory_items SET costo = $2 WHERE id = $1', [it.id, Math.round((costo / cant) * 100) / 100]);
      const t = await turnoActual(db);
      const enCaja = !!t && !!t.caja_abierta_en && !t.caja_cerrada_en;
      await db.query('INSERT INTO warehouse_moves (tenant_id, item_id, cantidad, tipo, costo_total, account_id, nota, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [u.tenant_id, it.id, cant, 'entrada', costo, cuenta, nota, u.id]);
      if (cuenta) await registrar(db, u, { shiftId: enCaja ? t!.id : null, cuentaId: cuenta, tipo: 'gasto', monto: -costo, concepto: `Compra para el almacén: ${it.nombre} x${cant}`, categoria: 'Compra de inventario' });
      await auditar(db, u.tenant_id, u.id, 'Entrada al almacén', `${it.nombre} +${cant} ${it.unidad}${costo ? ` por $${costo.toLocaleString('es-CO')}` : ''}${nota ? ` (${nota})` : ''}`);
      return estado(db);
    }
    if (b.accion === 'salida') {
      if (cant > hay) throw new ErrorApi(409, `En el almacén solo hay ${hay} ${it.unidad} de ${it.nombre}`);
      // Lo que sale del almacén entra al stock del día, como una llegada del turno
      const t = exigirTurnoActivo(await turnoActual(db));
      await db.query('INSERT INTO warehouse_moves (tenant_id, item_id, cantidad, tipo, shift_id, nota, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [u.tenant_id, it.id, -cant, 'salida', t.id, nota, u.id]);
      await db.query('UPDATE inventory_items SET stock = stock + $2 WHERE id = $1', [it.id, cant]);
      await db.query(
        `INSERT INTO inventory_entries (tenant_id, shift_id, item_id, cantidad, motivo, nota, user_id) VALUES ($1, $2, $3, $4, 'almacen', $5, $6)`,
        [u.tenant_id, t.id, it.id, cant, 'Salida del almacén' + (nota ? `: ${nota}` : ''), u.id]);
      await auditar(db, u.tenant_id, u.id, 'Salida del almacén', `${it.nombre} ${cant} ${it.unidad} al turno${nota ? ` (${nota})` : ''}`);
      return estado(db);
    }
    throw new ErrorApi(400, 'Acción no válida');
  });
  return json(r, 201);
});
