// GET /api/equipo  (permiso turno.operar)
// Personal activo del negocio, solo nombre y rol: lo necesita la apertura de caja
// ("¿Quién trabaja hoy?") sin tener que dar el permiso de gestionar usuarios.
import { conUsuario } from '../_lib/auth';
import { json, ruta } from '../_lib/http';

export const GET = ruta(async (req) => {
  const equipo = await conUsuario(req, 'turno.operar', async (db) =>
    (await db.query('SELECT id, nombre, rol FROM users WHERE activo ORDER BY nombre')).rows
  );
  return json({ equipo });
});
