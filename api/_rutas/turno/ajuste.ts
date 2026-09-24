// POST /api/turno/ajuste  (permiso catalogo.editar)
// { itemId, stock, motivo }  → corrige el stock de un ítem. Queda registrado cuánto había,
// cuánto quedó, quién lo hizo y por qué (se dañaron, error de conteo…).
import { auditar, conUsuario } from '../../_lib/auth';
import { cantidad } from '../../_lib/catalogo';
import { esUuid } from '../../_lib/db';
import { ErrorApi, json, leerJson, ruta, texto } from '../../_lib/http';
import { leerEstado, turnoActual } from '../../_lib/turno';

export const POST = ruta(async (req) => {
  const b = await leerJson(req);
  const r = await conUsuario(req, 'catalogo.editar', async (db, u) => {
    if (!esUuid(b.itemId)) throw new ErrorApi(400, 'Falta el ítem');
    const it = (await db.query('SELECT id, nombre, unidad, stock FROM inventory_items WHERE id = $1 AND activo FOR UPDATE', [b.itemId])).rows[0];
    if (!it) throw new ErrorApi(404, 'Ese ítem no existe');
    const nuevo = cantidad(b.stock, 'El nuevo stock');
    const motivo = texto(b.motivo, 'el motivo', { max: 200 });
    const dif = Math.round((nuevo - Number(it.stock)) * 1000) / 1000;
    if (dif) {
      const t = await turnoActual(db);
      await db.query(
        `INSERT INTO inventory_entries (tenant_id, shift_id, item_id, cantidad, motivo, nota, user_id) VALUES ($1, $2, $3, $4, 'ajuste', $5, $6)`,
        [u.tenant_id, t ? t.id : null, it.id, dif, motivo, u.id]
      );
      await db.query('UPDATE inventory_items SET stock = $2 WHERE id = $1', [it.id, nuevo]);
    }
    await auditar(db, u.tenant_id, u.id, 'Ajuste de stock', `${it.nombre}: ${Number(it.stock)} a ${nuevo} ${it.unidad}. Motivo: ${motivo}`);
    return leerEstado(db, u);
  });
  return json(r, 201);
});
