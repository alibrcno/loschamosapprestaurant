// POST /api/turno/llegada  { itemId, cantidad, costo?, cuenta?, nota? }
// Llegó mercancía: sube el stock, actualiza el costo unitario y, si se pagó de una cuenta,
// registra el gasto en el libro. Bebidas y utensilios: permiso inventario.entradas;
// insumos de cocina: permiso cocina.inventario.
import { auditar, conUsuario, puede } from '../../_lib/auth';
import { cantidad } from '../../_lib/catalogo';
import { esUuid } from '../../_lib/db';
import { ErrorApi, json, leerJson, pesos, ruta } from '../../_lib/http';
import { cuentaId, exigirCajaAbierta, leerEstado, leerObs, registrar, turnoActual } from '../../_lib/turno';

export const POST = ruta(async (req) => {
  const b = await leerJson(req);
  const r = await conUsuario(req, null, async (db, u) => {
    if (!esUuid(b.itemId)) throw new ErrorApi(400, 'Elige un producto');
    const it = (await db.query('SELECT id, tipo, nombre, unidad, stock, costo FROM inventory_items WHERE id = $1 AND activo FOR UPDATE', [b.itemId])).rows[0];
    if (!it) throw new ErrorApi(404, 'Ese producto no existe');
    if (!puede(u, it.tipo === 'insumo' ? 'cocina.inventario' : 'inventario.entradas')) throw new ErrorApi(403, 'Tu usuario no tiene permiso para registrar esta mercancía');
    const t = exigirCajaAbierta(await turnoActual(db));
    const cant = cantidad(b.cantidad, 'La cantidad');
    if (cant <= 0) throw new ErrorApi(400, 'La cantidad debe ser mayor a 0');
    const costo = b.costo === undefined || b.costo === null || b.costo === '' ? 0 : pesos(b.costo, 'El valor pagado');
    const cuenta = b.cuenta ? await cuentaId(db, b.cuenta) : null;
    if (cuenta && !costo) throw new ErrorApi(400, 'Si se pagó desde una cuenta, escribe el valor pagado');

    const nuevoCosto = costo > 0 ? Math.round((costo / cant) * 100) / 100 : Number(it.costo);
    await db.query('UPDATE inventory_items SET stock = stock + $2, costo = $3 WHERE id = $1', [it.id, cant, nuevoCosto]);
    const e = (await db.query(
      `INSERT INTO inventory_entries (tenant_id, shift_id, item_id, cantidad, motivo, costo_total, account_id, nota, user_id)
       VALUES ($1, $2, $3, $4, 'llegada', $5, $6, $7, $8) RETURNING id`,
      [u.tenant_id, t.id, it.id, cant, costo, cuenta, leerObs(b.nota, 120) || null, u.id]
    )).rows[0];
    if (cuenta) {
      await registrar(db, u, { shiftId: t.id, cuentaId: cuenta, tipo: 'gasto', monto: -costo, concepto: `Compra ${it.nombre} x${cant}`, categoria: 'Compra de inventario', refId: e.id });
    }
    await auditar(db, u.tenant_id, u.id, 'Llegada de mercancía',
      `${it.nombre} +${cant} ${it.unidad}${costo ? ` por $${costo.toLocaleString('es-CO')}` : ''}${nuevoCosto !== Number(it.costo) ? `. Costo unitario ${it.costo} a ${nuevoCosto}` : ''}`);
    return leerEstado(db, u);
  });
  return json(r, 201);
});
