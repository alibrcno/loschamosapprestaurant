// Almacén del dueño: insumos guardados aparte que la encargada no cuenta.
// Lo que hay de cada artículo = suma de sus movimientos (warehouse_moves), igual que el libro contable.
import type { PoolClient } from 'pg';

/** Cantidad en almacén de cada artículo: { itemId: cantidad } */
export async function existenciasAlmacen(db: PoolClient): Promise<Record<string, number>> {
  const r = await db.query('SELECT item_id, sum(cantidad) AS n FROM warehouse_moves GROUP BY item_id');
  return Object.fromEntries(r.rows.map((x) => [x.item_id, Number(x.n) || 0]));
}

/** Avalúo del almacén (cantidad × costo unitario de cada artículo) y artículos bajo su mínimo. */
export async function avaluoAlmacen(db: PoolClient) {
  const hay = await existenciasAlmacen(db);
  const items = (await db.query('SELECT id, tipo, nombre, unidad, costo, almacen_minimo FROM inventory_items WHERE activo ORDER BY tipo, nombre')).rows;
  const lista = items.map((it) => {
    const cantidad = Math.round((hay[it.id] || 0) * 1000) / 1000;
    return { id: it.id, tipo: it.tipo, nombre: it.nombre, unidad: it.unidad, costo: Number(it.costo), cantidad, minimo: Number(it.almacen_minimo), valor: Math.round(cantidad * Number(it.costo)) };
  });
  return { items: lista, total: lista.reduce((a, x) => a + x.valor, 0), bajos: lista.filter((x) => x.minimo > 0 && x.cantidad < x.minimo) };
}
