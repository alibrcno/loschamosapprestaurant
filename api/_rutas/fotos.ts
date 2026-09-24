// GET /api/fotos?id=<id>  → la foto de una factura (se guardan 15 días).
// La ve quien registra mercancía o quien ve los reportes.
import { conUsuario } from '../_lib/auth';
import { esUuid } from '../_lib/db';
import { ErrorApi, json, ruta } from '../_lib/http';
import { exigir } from '../_lib/pedidos';

export const GET = ruta(async (req) => {
  const id = new URL(req.url).searchParams.get('id');
  return json(await conUsuario(req, null, async (db, u) => {
    exigir(u, 'reportes.ver', 'inventario.entradas', 'cocina.inventario');
    if (!esUuid(id)) throw new ErrorApi(400, 'Falta la foto');
    const f = (await db.query('SELECT imagen, creado_en AS "creadoEn" FROM invoice_photos WHERE id = $1', [id])).rows[0];
    if (!f) throw new ErrorApi(404, 'Esa foto ya no existe (se guardan 15 días)');
    return f;
  }));
});
