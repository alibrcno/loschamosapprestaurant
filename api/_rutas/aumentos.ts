// GET /api/aumentos  (permiso reportes.ver) → lo que llegó más caro en los últimos 15 días, con el
// costo de antes y el de ahora. Para bebidas trae también un precio de venta sugerido que conserva
// el mismo margen (redondeado a $100); el dueño decide si lo cambia.
import { conUsuario } from '../_lib/auth';
import { json, ruta } from '../_lib/http';

export const GET = ruta(async (req) => json(await conUsuario(req, 'reportes.ver', async (db) => {
  const r = await db.query(
    `SELECT a.creado_en AS fecha, a.datos, coalesce(u.nombre, '') AS usuario, i.tipo, i.precio, i.costo AS "costoActual", i.activo
     FROM audit_log a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN inventory_items i ON i.id = (a.datos->>'itemId')::uuid
     WHERE a.accion = 'Llegó más caro' AND a.creado_en > now() - interval '15 days' ORDER BY a.creado_en DESC LIMIT 100`);
  return {
    aumentos: r.rows.filter((x) => x.activo !== false).map((x) => {
      const d = x.datos || {};
      const precio = x.precio === null ? null : Number(x.precio);
      const sugerido = x.tipo === 'bebida' && precio && d.antes > 0 ? Math.ceil((precio * d.ahora) / d.antes / 100) * 100 : null;
      return { fecha: x.fecha, usuario: x.usuario, itemId: d.itemId, nombre: d.nombre, unidad: d.unidad, antes: d.antes, ahora: d.ahora, pct: d.pct,
        tipo: x.tipo, precio, precioSugerido: sugerido && sugerido > (precio || 0) ? sugerido : null };
    })
  };
})));
