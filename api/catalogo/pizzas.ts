// PATCH /api/catalogo/pizzas  { id, nombre, precios, extra, gratis, sabores }  (permiso catalogo.editar)
// precios y extra: { Personal, Mediana, Familiar } en pesos. 0 = ese tamaño no se vende.
import { auditar, conUsuario } from '../_lib/auth';
import { preciosTamano, sabores } from '../_lib/catalogo';
import { esUuid } from '../_lib/db';
import { ErrorApi, json, leerJson, ruta, texto } from '../_lib/http';

export const PATCH = ruta(async (req) => {
  const b = await leerJson(req);
  const r = await conUsuario(req, 'catalogo.editar', async (db, yo) => {
    if (!esUuid(b.id)) throw new ErrorApi(400, 'Falta la pizza');
    const antes = (await db.query('SELECT precios FROM pizza_types WHERE id = $1 FOR UPDATE', [b.id])).rows[0];
    if (!antes) throw new ErrorApi(404, 'Esa pizza no existe');
    const nombre = texto(b.nombre, 'el nombre', { max: 60 });
    const precios = preciosTamano(b.precios, 'el precio');
    const extra = preciosTamano(b.extra, 'el sabor adicional');
    if (typeof b.gratis !== 'number' || !Number.isInteger(b.gratis) || b.gratis < 0 || b.gratis > 20) throw new ErrorApi(400, 'Los sabores incluidos deben ser un número entero');
    await db.query('UPDATE pizza_types SET nombre = $2, precios = $3, extra = $4, gratis = $5, sabores = $6 WHERE id = $1', [
      b.id, nombre, JSON.stringify(precios), JSON.stringify(extra), b.gratis, sabores(b.sabores)
    ]);
    const cambios = Object.keys(precios).filter((t) => antes.precios[t] !== precios[t]).map((t) => `${t} $${(antes.precios[t] || 0).toLocaleString('es-CO')} a $${precios[t].toLocaleString('es-CO')}`);
    await auditar(db, yo.tenant_id, yo.id, 'Pizza editada', `${nombre}${cambios.length ? ': ' + cambios.join(', ') : ''}`);
    return { id: b.id };
  });
  return json(r);
});
