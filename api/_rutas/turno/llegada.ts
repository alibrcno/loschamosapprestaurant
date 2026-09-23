// POST /api/turno/llegada  { items: [{ itemId, cantidad, costo? }], cuenta?, nota? }
// Llegó mercancía (una factura con uno o varios artículos): sube el stock, actualiza el costo
// unitario y, si se pagó de una cuenta, registra el gasto en el libro.
// Permiso inventario.entradas (caja): cualquier artículo. Cocina (cocina.inventario): solo insumos.
// Decir de qué cuenta se pagó es cosa de caja (permiso caja.movimientos), no de cocina.
// Cocina puede registrar llegadas desde que abre su turno, aunque la encargada no haya abierto la caja.
import { auditar, conUsuario, puede } from '../../_lib/auth';
import { cantidad } from '../../_lib/catalogo';
import { esUuid } from '../../_lib/db';
import { ErrorApi, json, leerJson, pesos, ruta } from '../../_lib/http';
import { cuentaId, exigirTurnoActivo, leerEstado, leerObs, nuevoGrupo, registrar, turnoActual } from '../../_lib/turno';

export const POST = ruta(async (req) => {
  const b = await leerJson(req);
  const r = await conUsuario(req, null, async (db, u) => {
    // Compatibilidad: un solo artículo sin lista
    const lista = Array.isArray(b.items) ? b.items : [{ itemId: b.itemId, cantidad: b.cantidad, costo: b.costo }];
    if (!lista.length || lista.length > 40) throw new ErrorApi(400, 'Agrega al menos un artículo');
    const cuenta = b.cuenta ? await cuentaId(db, b.cuenta) : null;
    if (cuenta && !puede(u, 'caja.movimientos')) throw new ErrorApi(403, 'Registrar de qué cuenta se pagó le corresponde a la caja');
    const t = exigirTurnoActivo(await turnoActual(db));
    const nota = leerObs(b.nota, 120) || null;
    const grupo = nuevoGrupo();
    let total = 0;
    const detalle: string[] = [];
    for (const x of lista as Record<string, unknown>[]) {
      if (!x || !esUuid(x.itemId)) throw new ErrorApi(400, 'Elige el producto de cada artículo');
      const it = (await db.query('SELECT id, tipo, nombre, unidad, stock, costo FROM inventory_items WHERE id = $1 AND activo FOR UPDATE', [x.itemId])).rows[0];
      if (!it) throw new ErrorApi(404, 'Uno de los productos no existe');
      if (!puede(u, 'inventario.entradas') && !(it.tipo === 'insumo' && puede(u, 'cocina.inventario'))) throw new ErrorApi(403, `Tu usuario no puede registrar ${it.nombre}`);
      const cant = cantidad(x.cantidad, `La cantidad de ${it.nombre}`);
      if (cant <= 0) throw new ErrorApi(400, `La cantidad de ${it.nombre} debe ser mayor a 0`);
      const costo = x.costo === undefined || x.costo === null || x.costo === '' ? 0 : pesos(x.costo, `El valor de ${it.nombre}`);
      if (cuenta && !costo) throw new ErrorApi(400, `Si se pagó desde una cuenta, escribe el valor de ${it.nombre}`);
      const nuevoCosto = costo > 0 ? Math.round((costo / cant) * 100) / 100 : Number(it.costo);
      await db.query('UPDATE inventory_items SET stock = stock + $2, costo = $3 WHERE id = $1', [it.id, cant, nuevoCosto]);
      const e = (await db.query(
        `INSERT INTO inventory_entries (tenant_id, shift_id, item_id, cantidad, motivo, costo_total, account_id, nota, user_id)
         VALUES ($1, $2, $3, $4, 'llegada', $5, $6, $7, $8) RETURNING id`,
        [u.tenant_id, t.id, it.id, cant, costo, cuenta, nota, u.id]
      )).rows[0];
      if (cuenta) {
        await registrar(db, u, { shiftId: t.id, cuentaId: cuenta, tipo: 'gasto', monto: -costo, concepto: `Compra ${it.nombre} x${cant}${nota ? ` (${nota})` : ''}`, categoria: 'Compra de inventario', refId: e.id, grupoId: grupo });
      }
      total += costo;
      detalle.push(`${it.nombre} +${cant} ${it.unidad}${costo ? ` por $${costo.toLocaleString('es-CO')}` : ''}${nuevoCosto !== Number(it.costo) ? ` (costo unitario ${it.costo} a ${nuevoCosto})` : ''}`);
    }
    await auditar(db, u.tenant_id, u.id, 'Llegada de mercancía', `${nota ? nota + ': ' : ''}${detalle.join('; ')}${total ? `. Total $${total.toLocaleString('es-CO')}` : ''}`);
    return leerEstado(db, u);
  });
  return json(r, 201);
});
