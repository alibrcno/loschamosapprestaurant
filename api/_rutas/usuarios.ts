// /api/usuarios  (permiso usuarios.gestionar)
//   GET                  → lista de usuarios del negocio
//   POST  { nombre, usuario, clave, rol, permisos, activo? }         → crea un usuario con la clave que pone el administrador
//   PATCH { id, nombre?, usuario?, clave?, rol?, permisos?, activo? } → edita; con clave nueva también lo desbloquea
import type { PoolClient } from 'pg';
import { PERMISOS, PERMISOS_ROL, Permiso, ROLES, Rol, Usuario, auditar, conUsuario, hashClave, validarClave } from '../_lib/auth';
import { esUuid } from '../_lib/db';
import { ErrorApi, json, leerJson, ruta, texto } from '../_lib/http';

const COLUMNAS = `id, nombre, usuario, rol, permisos, activo, coalesce(bloqueado_hasta > now(), false) AS bloqueado, creado_en`;

function leerRol(v: unknown): Rol {
  if (!ROLES.includes(v as Rol)) throw new ErrorApi(400, 'El rol no es válido');
  return v as Rol;
}
function leerUsuario(v: unknown): string {
  const u = texto(v, 'el usuario', { max: 30 }).toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(u)) throw new ErrorApi(400, 'El usuario debe tener de 3 a 30 letras o números, sin espacios');
  return u;
}
function leerPermisos(v: unknown, rol: Rol): string[] {
  if (rol === 'admin') return [...PERMISOS];
  if (v === undefined) return [...PERMISOS_ROL[rol]];
  if (!Array.isArray(v) || v.some((p) => !PERMISOS.includes(p as Permiso))) throw new ErrorApi(400, 'Hay permisos que no son válidos');
  return [...new Set(v as string[])];
}

/** Quien no es administrador no puede crear administradores ni dar permisos que él mismo no tiene. */
function revisarEscalada(yo: Usuario, rol: Rol, permisos: string[]) {
  if (yo.rol === 'admin') return;
  if (rol === 'admin') throw new ErrorApi(403, 'Solo un administrador puede crear o editar administradores');
  if (permisos.some((p) => !yo.permisos.includes(p))) throw new ErrorApi(403, 'No puedes dar permisos que tú no tienes');
}

async function guardar<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new ErrorApi(409, 'Ese usuario ya existe');
    throw e;
  }
}

async function quedaAdmin(db: PoolClient) {
  const r = await db.query("SELECT count(*)::int AS n FROM users WHERE rol = 'admin' AND activo");
  if (r.rows[0].n === 0) throw new ErrorApi(400, 'Debe quedar al menos un administrador activo');
}

export const GET = ruta(async (req) =>
  json({ usuarios: await conUsuario(req, 'usuarios.gestionar', async (db) => (await db.query(`SELECT ${COLUMNAS} FROM users ORDER BY nombre`)).rows) })
);

export const POST = ruta(async (req) => {
  const b = await leerJson(req);
  // Primero la sesión y el permiso; solo después se validan los datos y se cifra la clave
  const nuevo = await conUsuario(req, 'usuarios.gestionar', async (db, yo) => {
    const rol = leerRol(b.rol);
    const datos = {
      nombre: texto(b.nombre, 'el nombre', { max: 80 }),
      usuario: leerUsuario(b.usuario),
      clave: validarClave(b.clave, rol),
      rol,
      permisos: leerPermisos(b.permisos, rol),
      activo: b.activo !== false
    };
    revisarEscalada(yo, datos.rol, datos.permisos);
    const hash = await hashClave(datos.clave);
    const r = await guardar(() =>
      db.query(
        `INSERT INTO users (tenant_id, nombre, usuario, password_hash, rol, permisos, activo)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNAS}`,
        [yo.tenant_id, datos.nombre, datos.usuario, hash, datos.rol, datos.permisos, datos.activo]
      )
    );
    await auditar(db, yo.tenant_id, yo.id, 'Usuario creado', `${datos.nombre} (${datos.rol})`);
    return r.rows[0];
  });
  return json({ usuario: nuevo }, 201);
});

export const PATCH = ruta(async (req) => {
  const b = await leerJson(req);
  if (!esUuid(b.id)) throw new ErrorApi(400, 'Falta el usuario a editar');
  const id = b.id;
  const r = await conUsuario(req, 'usuarios.gestionar', async (db, yo) => {
    const q = await db.query<Usuario>('SELECT id, tenant_id, nombre, usuario, rol, permisos, activo FROM users WHERE id = $1 FOR UPDATE', [id]);
    const antes = q.rows[0];
    if (!antes) throw new ErrorApi(404, 'Ese usuario no existe');
    if (yo.rol !== 'admin' && antes.rol === 'admin') throw new ErrorApi(403, 'Solo un administrador puede editar administradores');

    const rol = b.rol === undefined ? antes.rol : leerRol(b.rol);
    // Si cambia el rol sin decir permisos, toma los del rol nuevo
    const permisos = b.permisos === undefined && rol === antes.rol ? antes.permisos : leerPermisos(b.permisos, rol);
    const activo = b.activo === undefined ? antes.activo : b.activo === true;
    const nombre = b.nombre === undefined ? antes.nombre : texto(b.nombre, 'el nombre', { max: 80 });
    const usuario = b.usuario === undefined ? antes.usuario : leerUsuario(b.usuario);
    const clave = b.clave === undefined || b.clave === '' ? null : validarClave(b.clave, rol);
    revisarEscalada(yo, rol, permisos);
    if (antes.id === yo.id && !activo) throw new ErrorApi(400, 'No puedes desactivar tu propio usuario');

    const hash = clave ? await hashClave(clave) : null;
    const d = await guardar(() =>
      db.query(
        `UPDATE users SET nombre = $2, usuario = $3, rol = $4, permisos = $5, activo = $6,
           password_hash = coalesce($7, password_hash),
           intentos_fallidos = CASE WHEN $7::text IS NULL THEN intentos_fallidos ELSE 0 END,
           bloqueado_hasta   = CASE WHEN $7::text IS NULL THEN bloqueado_hasta ELSE NULL END
         WHERE id = $1 RETURNING ${COLUMNAS}`,
        [id, nombre, usuario, rol, permisos, activo, hash]
      )
    );
    await quedaAdmin(db);
    // Clave nueva o usuario desactivado: se cierran sus sesiones abiertas en otros equipos
    if ((clave || !activo) && antes.id !== yo.id) await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);

    const cambios = [
      nombre !== antes.nombre && `nombre`, usuario !== antes.usuario && `usuario @${usuario}`,
      rol !== antes.rol && `rol ${antes.rol} a ${rol}`, activo !== antes.activo && (activo ? 'activado' : 'desactivado'),
      String(permisos) !== String(antes.permisos) && 'permisos', clave && 'contraseña cambiada'
    ].filter(Boolean);
    await auditar(db, yo.tenant_id, yo.id, 'Usuario editado', `${nombre}: ${cambios.join(', ') || 'sin cambios'}`);
    return d.rows[0];
  });
  return json({ usuario: r });
});
