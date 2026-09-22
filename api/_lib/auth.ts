// Contraseñas, sesiones y permisos. Todo se revisa en el servidor en cada petición.
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import type { PoolClient } from 'pg';
import { conNegocio, esUuid } from './db';
import { ErrorApi, leerCookies } from './http';

/** Los mismos permisos y roles que usa la app (public/store.js). */
export const PERMISOS = [
  'pos.tomar', 'pos.precuenta', 'pos.cobrar', 'pos.anular', 'cocina.comandas', 'cocina.inventario',
  'turno.operar', 'caja.movimientos', 'inventario.entradas', 'reportes.ver', 'catalogo.editar', 'usuarios.gestionar'
] as const;
export type Permiso = (typeof PERMISOS)[number];
export const ROLES = ['admin', 'encargada', 'mesera', 'cocina'] as const;
export type Rol = (typeof ROLES)[number];
/** Permisos por defecto de cada rol (iguales a LC.ROLES en public/store.js). */
export const PERMISOS_ROL: Record<Rol, readonly Permiso[]> = {
  admin: PERMISOS,
  encargada: ['pos.tomar', 'pos.precuenta', 'pos.cobrar', 'pos.anular', 'cocina.comandas', 'turno.operar', 'caja.movimientos', 'inventario.entradas'],
  mesera: ['pos.tomar', 'pos.precuenta'],
  cocina: ['cocina.comandas', 'cocina.inventario']
};

export interface Usuario {
  id: string;
  tenant_id: string;
  nombre: string;
  usuario: string;
  rol: Rol;
  permisos: string[];
  activo: boolean;
}

export const puede = (u: Usuario, p: Permiso) => u.rol === 'admin' || u.permisos.includes(p);

/* ---------------- contraseñas ---------------- */
const COSTO_BCRYPT = 10;
// Se compara contra este hash cuando el usuario no existe, para tardar lo mismo
// y que nadie pueda averiguar qué usuarios existen midiendo el tiempo de respuesta.
const HASH_FALSO = bcrypt.hashSync('usuario-que-no-existe', COSTO_BCRYPT);

/**
 * El administrador crea la contraseña de cada persona. Para el personal basta algo sencillo
 * (mínimo 4 caracteres); el administrador necesita al menos 8 porque controla todo.
 * Lo que protege a las claves cortas es el bloqueo tras 5 intentos fallidos.
 */
export function validarClave(clave: unknown, rol: Rol): string {
  if (typeof clave !== 'string') throw new ErrorApi(400, 'Falta la contraseña');
  const min = rol === 'admin' ? 8 : 4;
  if (clave.length < min) throw new ErrorApi(400, `La contraseña debe tener al menos ${min} caracteres`);
  if (Buffer.byteLength(clave) > 72) throw new ErrorApi(400, 'La contraseña es demasiado larga');
  return clave;
}
export const hashClave = (clave: string) => bcrypt.hash(clave, COSTO_BCRYPT);
export const verificarClave = (clave: string, hash: string | null) => bcrypt.compare(clave, hash || HASH_FALSO);

/* ---------------- sesiones ---------------- */
export const COOKIE = 'lc_sesion';
const DIAS_SESION = 14;
export const INTENTOS_MAX = 5;
export const MINUTOS_BLOQUEO = 15;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

function cookie(valor: string, maxAge: number) {
  return `${COOKIE}=${encodeURIComponent(valor)}; Path=/api; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
export const cookieBorrada = () => cookie('', 0);

/**
 * Crea la sesión y devuelve la cabecera Set-Cookie. La cookie lleva "negocio.token":
 * en la base solo se guarda el hash del token, así una copia de la base no sirve para entrar.
 */
export async function crearSesion(db: PoolClient, u: Usuario, dispositivo: string | null): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO sessions (tenant_id, user_id, token_hash, dispositivo, expira_en)
     VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))`,
    [u.tenant_id, u.id, hashToken(token), dispositivo ? dispositivo.slice(0, 200) : null, DIAS_SESION]
  );
  return cookie(`${u.tenant_id}.${token}`, DIAS_SESION * 86400);
}

function leerSesion(req: Request): { tenantId: string; token: string } {
  const v = leerCookies(req)[COOKIE] || '';
  const i = v.indexOf('.');
  const tenantId = v.slice(0, i), token = v.slice(i + 1);
  if (i < 0 || !esUuid(tenantId) || token.length < 20) throw new ErrorApi(401, 'Tu sesión terminó. Ingresa de nuevo.');
  return { tenantId, token };
}

export const COLUMNAS_USUARIO = 'u.id, u.tenant_id, u.nombre, u.usuario, u.rol, u.permisos, u.activo';

/**
 * Punto de entrada de toda ruta protegida: valida la sesión, revisa el permiso y ejecuta
 * `fn` dentro de una transacción del negocio del usuario. El negocio sale de la sesión
 * guardada en la base, no de lo que diga el navegador: si alguien cambia el negocio en su
 * cookie, el token no existe en ese negocio y se rechaza.
 */
export async function conUsuario<T>(
  req: Request,
  permiso: Permiso | null,
  fn: (db: PoolClient, u: Usuario) => Promise<T>
): Promise<T> {
  const { tenantId, token } = leerSesion(req);
  return conNegocio(tenantId, async (db) => {
    const r = await db.query<Usuario>(
      `SELECT ${COLUMNAS_USUARIO} FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expira_en > now() AND u.activo`,
      [hashToken(token)]
    );
    const u = r.rows[0];
    if (!u) throw new ErrorApi(401, 'Tu sesión terminó. Ingresa de nuevo.');
    if (permiso && !puede(u, permiso)) throw new ErrorApi(403, 'Tu usuario no tiene permiso para esto. Pídeselo al administrador.');
    return fn(db, u);
  });
}

export async function cerrarSesion(req: Request) {
  let s;
  try { s = leerSesion(req); } catch { return; }
  const { tenantId, token } = s;
  await conNegocio(tenantId, (db) => db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]));
}

/* ---------------- auditoría ---------------- */
export async function auditar(db: PoolClient, tenantId: string, userId: string | null, accion: string, detalle = '', datos?: unknown) {
  await db.query('INSERT INTO audit_log (tenant_id, user_id, accion, detalle, datos) VALUES ($1, $2, $3, $4, $5)', [
    tenantId, userId, accion, detalle, datos === undefined ? null : JSON.stringify(datos)
  ]);
}
