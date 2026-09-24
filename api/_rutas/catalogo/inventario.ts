// /api/catalogo/inventario  (permiso catalogo.editar)
//   POST   { tipo, nombre, unidad, precio?, costo, sugerido }    → nuevo ítem (tipo: bebidas | utensilios | insumos)
//   PATCH  { id, nombre, unidad, precio?, costo, sugerido }      → edita nombre, precio de venta, costo y stock sugerido
//   DELETE { id }                                                → lo quita (si ya tuvo movimientos, solo se oculta)
// El stock NO se cambia aquí: cambia con conteos, llegadas o ajustes con motivo (parte 3).
import { auditar, conUsuario } from '../../_lib/auth';
import { TIPOS, cantidad, leerGrupo, yaUsado } from '../../_lib/catalogo';
import { esUuid } from '../../_lib/db';
import { ErrorApi, json, leerJson, pesos, ruta, texto } from '../../_lib/http';

const leerId = (v: unknown) => { if (!esUuid(v)) throw new ErrorApi(400, 'Falta el ítem'); return v; };

function datos(b: Record<string, unknown>, esBebida: boolean) {
  return {
    nombre: texto(b.nombre, 'el nombre', { max: 80 }),
    unidad: texto(b.unidad, 'la unidad', { max: 30 }),
    precio: esBebida ? pesos(b.precio, 'El precio de venta') : null,
    costo: cantidad(b.costo ?? 0, 'El costo', 2),
    sugerido: cantidad(b.sugerido ?? 0, 'El stock sugerido')
  };
}

export const POST = ruta(async (req) => {
  const b = await leerJson(req);
  const r = await conUsuario(req, 'catalogo.editar', async (db, yo) => {
    const grupo = leerGrupo(b.tipo);
    const d = datos(b, grupo === 'bebidas');
    const q = await db.query(
      `INSERT INTO inventory_items (tenant_id, tipo, nombre, unidad, precio, costo, sugerido)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [yo.tenant_id, TIPOS[grupo], d.nombre, d.unidad, d.precio, d.costo, d.sugerido]
    );
    await auditar(db, yo.tenant_id, yo.id, 'Ítem de inventario creado', `${grupo}: ${d.nombre}`);
    return { id: q.rows[0].id };
  });
  return json(r, 201);
});

export const PATCH = ruta(async (req) => {
  const b = await leerJson(req);
  const r = await conUsuario(req, 'catalogo.editar', async (db, yo) => {
    const id = leerId(b.id);
    const antes = (await db.query('SELECT tipo, nombre, precio, costo FROM inventory_items WHERE id = $1 AND activo FOR UPDATE', [id])).rows[0];
    if (!antes) throw new ErrorApi(404, 'Ese ítem no existe');
    const d = datos(b, antes.tipo === 'bebida');
    await db.query('UPDATE inventory_items SET nombre = $2, unidad = $3, precio = $4, costo = $5, sugerido = $6 WHERE id = $1', [
      id, d.nombre, d.unidad, d.precio, d.costo, d.sugerido
    ]);
    const cambios = [
      d.precio !== null && antes.precio !== d.precio && `precio $${(antes.precio || 0).toLocaleString('es-CO')} a $${d.precio.toLocaleString('es-CO')}`,
      antes.costo !== d.costo && `costo ${antes.costo} a ${d.costo}`
    ].filter(Boolean);
    await auditar(db, yo.tenant_id, yo.id, 'Ítem de inventario editado', `${d.nombre}${cambios.length ? ': ' + cambios.join(', ') : ''}`);
    return { id };
  });
  return json(r);
});

export const DELETE = ruta(async (req) => {
  const b = await leerJson(req);
  const r = await conUsuario(req, 'catalogo.editar', async (db, yo) => {
    const id = leerId(b.id);
    const antes = (await db.query('SELECT nombre FROM inventory_items WHERE id = $1 AND activo', [id])).rows[0];
    if (!antes) throw new ErrorApi(404, 'Ese ítem no existe');
    let oculto = false;
    try {
      await db.query('SAVEPOINT borrar');
      await db.query('DELETE FROM inventory_items WHERE id = $1', [id]);
    } catch (e) {
      if (!yaUsado(e)) throw e;
      // Ya tiene conteos, llegadas o ventas: se conserva para el historial y solo se oculta
      await db.query('ROLLBACK TO SAVEPOINT borrar');
      await db.query('UPDATE inventory_items SET activo = false WHERE id = $1', [id]);
      oculto = true;
    }
    await auditar(db, yo.tenant_id, yo.id, 'Ítem de inventario eliminado', antes.nombre + (oculto ? ' (se conserva en el historial)' : ''));
    return { ok: true, oculto };
  });
  return json(r);
});
