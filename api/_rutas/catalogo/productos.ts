// /api/catalogo/productos  (permiso catalogo.editar)
//   POST   { nombre, categoria, precio }                 → crea un producto del menú
//   PATCH  { id, nombre, categoria, precio, activo }     → lo edita (el cambio de precio queda en auditoría)
//   DELETE { id }                                        → lo elimina, si nunca se ha vendido
import { auditar, conUsuario } from '../../_lib/auth';
import { idCategoria, yaUsado } from '../../_lib/catalogo';
import { esUuid } from '../../_lib/db';
import { ErrorApi, json, leerJson, pesos, ruta, texto } from '../../_lib/http';

const fmt = (n: number) => '$' + n.toLocaleString('es-CO');
const leerId = (v: unknown) => { if (!esUuid(v)) throw new ErrorApi(400, 'Falta el producto'); return v; };
const reservada = (c: string) => { if (['pizzas', 'bebidas'].includes(c.toLowerCase())) throw new ErrorApi(400, 'Las pizzas y las bebidas tienen su propia pestaña'); return c; };

export const POST = ruta(async (req) => {
  const b = await leerJson(req);
  const p = await conUsuario(req, 'catalogo.editar', async (db, yo) => {
    const nombre = texto(b.nombre, 'el nombre', { max: 80 });
    const categoria = reservada(texto(b.categoria, 'la categoría', { max: 40 }));
    const precio = pesos(b.precio, 'El precio');
    const r = await db.query(
      'INSERT INTO products (tenant_id, category_id, nombre, precio) VALUES ($1, $2, $3, $4) RETURNING id',
      [yo.tenant_id, await idCategoria(db, yo.tenant_id, categoria), nombre, precio]
    );
    await auditar(db, yo.tenant_id, yo.id, 'Producto creado', `${nombre} (${categoria}) ${fmt(precio)}`);
    return { id: r.rows[0].id };
  });
  return json(p, 201);
});

export const PATCH = ruta(async (req) => {
  const b = await leerJson(req);
  const p = await conUsuario(req, 'catalogo.editar', async (db, yo) => {
    const id = leerId(b.id);
    const antes = (await db.query('SELECT nombre, precio FROM products WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!antes) throw new ErrorApi(404, 'Ese producto no existe');
    const nombre = texto(b.nombre, 'el nombre', { max: 80 });
    const categoria = reservada(texto(b.categoria, 'la categoría', { max: 40 }));
    const precio = pesos(b.precio, 'El precio');
    await db.query('UPDATE products SET nombre = $2, category_id = $3, precio = $4, activo = $5 WHERE id = $1', [
      id, nombre, await idCategoria(db, yo.tenant_id, categoria), precio, b.activo !== false
    ]);
    await auditar(db, yo.tenant_id, yo.id, 'Producto editado',
      `${nombre}${antes.precio !== precio ? `: precio ${fmt(antes.precio)} a ${fmt(precio)}` : ''}${b.activo === false ? ' (inactivo)' : ''}`);
    return { id };
  });
  return json(p);
});

export const DELETE = ruta(async (req) => {
  const b = await leerJson(req);
  await conUsuario(req, 'catalogo.editar', async (db, yo) => {
    const id = leerId(b.id);
    const antes = (await db.query('SELECT nombre FROM products WHERE id = $1', [id])).rows[0];
    if (!antes) throw new ErrorApi(404, 'Ese producto no existe');
    try {
      await db.query('SAVEPOINT borrar');
      await db.query('DELETE FROM products WHERE id = $1', [id]);
    } catch (e) {
      if (!yaUsado(e)) throw e;
      throw new ErrorApi(409, `"${antes.nombre}" ya tiene ventas registradas. Desmarca "Activo" para ocultarlo del menú.`);
    }
    await auditar(db, yo.tenant_id, yo.id, 'Producto eliminado', antes.nombre);
  });
  return json({ ok: true });
});
