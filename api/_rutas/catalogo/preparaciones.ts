// PUT-like PATCH /api/catalogo/preparaciones  (permiso catalogo.editar)
// { preparaciones: [{ nombre, materiales: [{ itemId, cantidad }] }] }
// Lo que cocina prepara por tandas (salsa de pizza, guiso, piña…) y los materiales que necesita cada
// tanda. Al cerrar, cocina marca qué hay que preparar mañana y esos materiales entran a las compras.
import { auditar, conUsuario } from '../../_lib/auth';
import { cantidad } from '../../_lib/catalogo';
import { esUuid } from '../../_lib/db';
import { ErrorApi, json, leerJson, ruta, texto } from '../../_lib/http';

export const PATCH = ruta(async (req) => {
  const b = await leerJson(req);
  const r = await conUsuario(req, 'catalogo.editar', async (db, yo) => {
    if (!Array.isArray(b.preparaciones) || b.preparaciones.length > 40) throw new ErrorApi(400, 'Las preparaciones deben ser una lista (máximo 40)');
    const ids = new Set((await db.query('SELECT id FROM inventory_items WHERE activo')).rows.map((x) => x.id));
    const preparaciones = (b.preparaciones as Record<string, unknown>[]).map((p) => {
      const nombre = texto(p && p.nombre, 'el nombre de la preparación', { max: 60 });
      if (!Array.isArray(p.materiales) || !p.materiales.length || p.materiales.length > 40) throw new ErrorApi(400, `Agrega los materiales de ${nombre}`);
      const materiales = (p.materiales as Record<string, unknown>[]).map((m) => {
        if (!m || !esUuid(m.itemId) || !ids.has(m.itemId)) throw new ErrorApi(400, `Un material de ${nombre} no está en el inventario`);
        const c = cantidad(m.cantidad, `La cantidad de un material de ${nombre}`);
        if (c <= 0) throw new ErrorApi(400, `Las cantidades de ${nombre} deben ser mayores a 0`);
        return { itemId: m.itemId as string, cantidad: c };
      });
      return { nombre, materiales };
    });
    if (new Set(preparaciones.map((p) => p.nombre.toLowerCase())).size !== preparaciones.length) throw new ErrorApi(400, 'Hay una preparación repetida');
    await db.query(`UPDATE tenants SET config = jsonb_set(config, '{preparaciones}', $1::jsonb, true)`, [JSON.stringify(preparaciones)]);
    await auditar(db, yo.tenant_id, yo.id, 'Preparaciones editadas', preparaciones.map((p) => p.nombre).join(', ') || 'ninguna');
    return { ok: true };
  });
  return json(r);
});
