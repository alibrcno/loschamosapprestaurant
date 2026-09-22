// POST /api/auth/login  { codigo, usuario, clave }
// Ingresa con código de negocio + usuario + contraseña. Tras 5 intentos fallidos el
// usuario queda bloqueado 15 minutos (o hasta que el administrador le cambie la clave).
import { COLUMNAS_USUARIO, INTENTOS_MAX, MINUTOS_BLOQUEO, Usuario, auditar, crearSesion, verificarClave } from '../_lib/auth';
import { conNegocio, negocioPorCodigo } from '../_lib/db';
import { ErrorApi, json, leerJson, ruta, texto } from '../_lib/http';

const INCORRECTO = 'Código de negocio, usuario o contraseña incorrectos';

export const POST = ruta(async (req) => {
  const b = await leerJson(req);
  const codigo = texto(b.codigo, 'el código de negocio', { max: 40 }).toLowerCase();
  const usuario = texto(b.usuario, 'el usuario', { max: 60 }).toLowerCase();
  const clave = typeof b.clave === 'string' ? b.clave : '';

  const tenantId = await negocioPorCodigo(codigo);
  if (!tenantId) {
    await verificarClave(clave, null); // mismo tiempo de respuesta que un código válido
    throw new ErrorApi(401, INCORRECTO);
  }

  // Los intentos fallidos se guardan (COMMIT) aunque el ingreso falle: por eso se devuelve
  // el error en vez de lanzarlo dentro de la transacción.
  const r = await conNegocio(tenantId, async (db) => {
    const q = await db.query<Usuario & { password_hash: string | null; intentos_fallidos: number; bloqueado: boolean }>(
      `SELECT ${COLUMNAS_USUARIO}, u.password_hash, u.intentos_fallidos, coalesce(u.bloqueado_hasta > now(), false) AS bloqueado
       FROM users u WHERE u.usuario = $1 FOR UPDATE`,
      [usuario]
    );
    const u = q.rows[0];
    if (u && u.bloqueado) {
      return { error: new ErrorApi(429, `Demasiados intentos fallidos. Espera ${MINUTOS_BLOQUEO} minutos o pide al administrador que te cambie la contraseña.`) };
    }
    const ok = (await verificarClave(clave, u && u.activo ? u.password_hash : null)) && !!u && u.activo && !!u.password_hash;
    if (!ok) {
      if (u) {
        await db.query(
          `UPDATE users SET
             intentos_fallidos = CASE WHEN intentos_fallidos + 1 >= $2 THEN 0 ELSE intentos_fallidos + 1 END,
             bloqueado_hasta   = CASE WHEN intentos_fallidos + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE bloqueado_hasta END
           WHERE id = $1`,
          [u.id, INTENTOS_MAX, MINUTOS_BLOQUEO]
        );
        await auditar(db, tenantId, u.id, 'Ingreso fallido', u.intentos_fallidos + 1 >= INTENTOS_MAX ? 'Usuario bloqueado por intentos' : '');
      }
      return { error: new ErrorApi(401, INCORRECTO) };
    }
    await db.query('UPDATE users SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $1', [u.id]);
    const cookie = await crearSesion(db, u, req.headers.get('user-agent'));
    await auditar(db, tenantId, u.id, 'Inicio de sesión');
    const { id, nombre, rol, permisos } = u;
    return { cookie, usuario: { id, nombre, usuario: u.usuario, rol, permisos } };
  });

  if ('error' in r) throw r.error;
  return json({ usuario: r.usuario }, 200, { 'set-cookie': r.cookie });
});
