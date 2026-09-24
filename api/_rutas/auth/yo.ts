// GET /api/auth/yo  → quién está conectado y a qué negocio pertenece.
import { conUsuario } from '../../_lib/auth';
import { json, ruta } from '../../_lib/http';

export const GET = ruta(async (req) => {
  const r = await conUsuario(req, null, async (db, u) => {
    const n = await db.query('SELECT nombre, codigo, whatsapp, config FROM tenants');
    return { usuario: { id: u.id, nombre: u.nombre, usuario: u.usuario, rol: u.rol, permisos: u.permisos }, negocio: n.rows[0] };
  });
  return json(r);
});
