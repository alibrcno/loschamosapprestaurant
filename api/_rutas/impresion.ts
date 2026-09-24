// /api/impresion  — cola de impresión que atiende el PC de caja (el que tiene la impresora)
//   GET                              → últimas impresiones del turno (para reimprimir)
//   POST { accion: 'tomar' }         → entrega lo pendiente y lo marca como impreso (una sola vez)
//   POST { accion: 'reimprimir', id } → devuelve una impresión ya hecha para sacarla otra vez
// Permiso pos.cobrar: la pre-cuenta y el recibo llevan valores de la cuenta.
import { auditar, conUsuario } from '../_lib/auth';
import { esUuid } from '../_lib/db';
import { ErrorApi, json, leerJson, ruta } from '../_lib/http';
import { turnoActual } from '../_lib/turno';

const COLUMNAS = 'j.id, j.tipo, j.titulo, j.datos, j.creado_en AS "creadoEn", j.impreso_en AS "impresoEn", u.nombre AS "pidio"';

export const GET = ruta(async (req) => json(await conUsuario(req, 'pos.cobrar', async (db) => {
  const t = await turnoActual(db);
  if (!t) return { trabajos: [] };
  const r = await db.query(
    `SELECT ${COLUMNAS} FROM print_jobs j LEFT JOIN users u ON u.id = j.creado_por
     WHERE j.shift_id = $1 ORDER BY j.creado_en DESC LIMIT 30`, [t.id]);
  return { trabajos: r.rows };
})));

export const POST = ruta(async (req) => {
  const b = await leerJson(req);
  return json(await conUsuario(req, 'pos.cobrar', async (db, u) => {
    if (b.accion === 'tomar') {
      // FOR UPDATE SKIP LOCKED: si hubiera dos PC de caja pidiendo a la vez, cada impresión sale en uno solo
      const r = await db.query(
        `WITH p AS (SELECT id FROM print_jobs WHERE impreso_en IS NULL ORDER BY creado_en LIMIT 10 FOR UPDATE SKIP LOCKED)
         UPDATE print_jobs j SET impreso_en = now(), impreso_por = $1 FROM p WHERE j.id = p.id RETURNING j.id`, [u.id]);
      if (!r.rows.length) return { trabajos: [] };
      const t = await db.query(
        `SELECT ${COLUMNAS} FROM print_jobs j LEFT JOIN users u ON u.id = j.creado_por WHERE j.id = ANY($1) ORDER BY j.creado_en`,
        [r.rows.map((x) => x.id)]);
      return { trabajos: t.rows };
    }
    if (b.accion === 'reimprimir') {
      if (!esUuid(b.id)) throw new ErrorApi(400, 'Falta la impresión');
      const j = (await db.query(`SELECT ${COLUMNAS} FROM print_jobs j LEFT JOIN users u ON u.id = j.creado_por WHERE j.id = $1`, [b.id])).rows[0];
      if (!j) throw new ErrorApi(404, 'Esa impresión no existe');
      // Reimprimir una pre-cuenta o un recibo queda anotado
      if (j.tipo !== 'comanda') await auditar(db, u.tenant_id, u.id, 'Reimpresión', j.titulo);
      return { trabajos: [j] };
    }
    throw new ErrorApi(400, 'Acción no válida');
  }));
});
