// POST /api/auth/instalar  { codigo, claveInstalacion, nombre, usuario, clave }
// Crea el PRIMER administrador de un negocio que todavía no tiene usuarios.
// Exige la "clave de instalación" (variable de entorno CLAVE_INSTALACION en Vercel), para que
// nadie más que el dueño pueda reclamar el negocio aunque conozca su código.
import { createHash, timingSafeEqual } from 'crypto';
import { COLUMNAS_USUARIO, PERMISOS, Usuario, auditar, crearSesion, hashClave, validarClave } from '../../_lib/auth';
import { conNegocio, negocioPorCodigo } from '../../_lib/db';
import { ErrorApi, json, leerJson, ruta, texto } from '../../_lib/http';

const sha = (s: string) => createHash('sha256').update(s).digest();

export const POST = ruta(async (req) => {
  const esperada = process.env.CLAVE_INSTALACION || '';
  if (esperada.length < 12) throw new ErrorApi(503, 'La instalación no está habilitada en este servidor');
  const b = await leerJson(req);
  const dada = typeof b.claveInstalacion === 'string' ? b.claveInstalacion : '';
  if (!timingSafeEqual(sha(dada), sha(esperada))) throw new ErrorApi(403, 'La clave de instalación no es correcta');

  const tenantId = await negocioPorCodigo(texto(b.codigo, 'el código de negocio', { max: 40 }));
  if (!tenantId) throw new ErrorApi(404, 'No existe un negocio activo con ese código');
  const nombre = texto(b.nombre, 'tu nombre', { max: 80 });
  const usuario = texto(b.usuario, 'el usuario', { max: 30 }).toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) throw new ErrorApi(400, 'El usuario debe tener de 3 a 30 letras o números, sin espacios');
  const clave = validarClave(b.clave, 'admin');
  const hash = await hashClave(clave);

  const r = await conNegocio(tenantId, async (db) => {
    await db.query('SELECT id FROM tenants FOR UPDATE'); // evita dos instalaciones al mismo tiempo
    const n = await db.query('SELECT count(*)::int AS n FROM users');
    if (n.rows[0].n > 0) throw new ErrorApi(409, 'Este negocio ya tiene administrador. Ingresa con tu usuario.');
    const q = await db.query<Usuario>(
      `INSERT INTO users AS u (tenant_id, nombre, usuario, password_hash, rol, permisos)
       VALUES ($1, $2, $3, $4, 'admin', $5) RETURNING ${COLUMNAS_USUARIO}`,
      [tenantId, nombre, usuario, hash, PERMISOS]
    );
    const u = q.rows[0];
    await auditar(db, tenantId, u.id, 'Instalación', `Administrador ${nombre} creado`);
    return { cookie: await crearSesion(db, u, req.headers.get('user-agent')), usuario: { id: u.id, nombre, usuario, rol: u.rol } };
  });
  return json({ usuario: r.usuario }, 201, { 'set-cookie': r.cookie });
});
