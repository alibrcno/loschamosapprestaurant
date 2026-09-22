// Conexión a Neon. La cadena de conexión viene SOLO de la variable de entorno DATABASE_URL
// (rol app_user, sin permisos de dueño). Nunca se escribe en el código.
import { Pool, PoolClient } from 'pg';
import { ErrorApi } from './http';

let pool: Pool | null = null;

function obtenerPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('Falta la variable de entorno DATABASE_URL');
    pool = new Pool({ connectionString: url, max: 5, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 });
    pool.on('error', (e) => console.error('Error en la conexión a la base:', e.message));
  }
  return pool;
}

export const esUuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * Ejecuta `fn` dentro de una transacción con el negocio fijado. Row Level Security
 * hace que todo lo que se lea o escriba ahí sea solo de ese negocio.
 * Si `fn` lanza un error, se deshace todo (ROLLBACK).
 */
export async function conNegocio<T>(tenantId: string, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  if (!esUuid(tenantId)) throw new ErrorApi(401, 'Sesión no válida. Ingresa de nuevo.');
  const db = await obtenerPool().connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const r = await fn(db);
    await db.query('COMMIT');
    return r;
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

/** Código de negocio (lo que se escribe al ingresar) → id del negocio, o null si no existe o está inactivo. */
export async function negocioPorCodigo(codigo: string): Promise<string | null> {
  const r = await obtenerPool().query('SELECT tenant_por_codigo($1) AS id', [codigo]);
  return r.rows[0]?.id ?? null;
}

/** Prueba simple de conexión, para la ruta /api/salud. */
export async function probarConexion(): Promise<boolean> {
  const r = await obtenerPool().query('SELECT 1 AS ok');
  return r.rows[0]?.ok === 1;
}

export async function cerrarConexiones() {
  if (pool) await pool.end();
  pool = null;
}
