// GET /api/auditoria  (permiso reportes.ver) → últimas 300 acciones registradas en el servidor.
import { conUsuario } from '../_lib/auth';
import { json, ruta } from '../_lib/http';

export const GET = ruta(async (req) =>
  json({
    auditoria: await conUsuario(req, 'reportes.ver', async (db) => (await db.query(
      `SELECT a.creado_en AS fecha, coalesce(u.nombre, 'sistema') AS usuario, a.accion, coalesce(a.detalle, '') AS detalle
       FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.creado_en DESC, a.id DESC LIMIT 300`
    )).rows)
  })
);
