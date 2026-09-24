// PATCH /api/catalogo/categorias  (permiso catalogo.editar)
// { nombre, extras: [{ nombre, precio }] }  → extras que se le pueden agregar a cualquier producto
// de esa categoría (ej. Hamburguesas: queso extra $3.000, tocineta $4.000). El cambio queda en auditoría.
import { auditar, conUsuario } from '../../_lib/auth';
import { idCategoria } from '../../_lib/catalogo';
import { ErrorApi, json, leerJson, pesos, ruta, texto } from '../../_lib/http';

export const PATCH = ruta(async (req) => {
  const b = await leerJson(req);
  const r = await conUsuario(req, 'catalogo.editar', async (db, yo) => {
    const nombre = texto(b.nombre, 'la categoría', { max: 40 });
    if (['pizzas', 'bebidas'].includes(nombre.toLowerCase())) throw new ErrorApi(400, 'Las pizzas y las bebidas no llevan extras de categoría');
    if (!Array.isArray(b.extras) || b.extras.length > 30) throw new ErrorApi(400, 'Los extras deben ser una lista (máximo 30)');
    const extras = (b.extras as Record<string, unknown>[]).map((x) => ({
      nombre: texto(x && x.nombre, 'el nombre del extra', { max: 60 }),
      precio: pesos(x && x.precio, 'El precio del extra')
    }));
    if (new Set(extras.map((x) => x.nombre.toLowerCase())).size !== extras.length) throw new ErrorApi(400, 'Hay un extra repetido');
    const id = await idCategoria(db, yo.tenant_id, nombre);
    await db.query('UPDATE categories SET extras = $2 WHERE id = $1', [id, JSON.stringify(extras)]);
    await auditar(db, yo.tenant_id, yo.id, 'Extras editados', `${nombre}: ${extras.map((x) => `${x.nombre} $${x.precio.toLocaleString('es-CO')}`).join(', ') || 'sin extras'}`);
    return { ok: true };
  });
  return json(r);
});
