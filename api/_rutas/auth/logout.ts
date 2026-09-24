// POST /api/auth/logout  → borra la sesión en la base y en el navegador.
import { cerrarSesion, cookieBorrada } from '../../_lib/auth';
import { json, ruta } from '../../_lib/http';

export const POST = ruta(async (req) => {
  await cerrarSesion(req);
  return json({ ok: true }, 200, { 'set-cookie': cookieBorrada() });
});
