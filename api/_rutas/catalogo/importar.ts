// POST /api/catalogo/importar  (permiso catalogo.editar)
// { categorias, productos, pizzas, bebidas, utensilios, insumos }  — con la forma que usa la app.
// Sube el menú y el inventario de un equipo al servidor. SOLO funciona si el negocio todavía no
// tiene catálogo en el servidor: nunca reemplaza ni borra uno existente.
// Devuelve { ids: { idLocal: idNuevo } } para que la app actualice sus referencias.
import { auditar, conUsuario } from '../../_lib/auth';
import { Grupo, TIPOS, cantidad, catalogoVacio, idCategoria, preciosTamano, sabores } from '../../_lib/catalogo';
import { ErrorApi, json, leerJson, pesos, ruta, texto } from '../../_lib/http';

function lista(v: unknown, campo: string, max: number): Record<string, unknown>[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max || v.some((x) => !x || typeof x !== 'object')) throw new ErrorApi(400, `La lista de ${campo} no es válida`);
  return v as Record<string, unknown>[];
}
const idLocal = (x: Record<string, unknown>) => (typeof x.id === 'string' ? x.id.slice(0, 64) : '');

export const POST = ruta(async (req) => {
  const b = await leerJson(req);
  const r = await conUsuario(req, 'catalogo.editar', async (db, yo) => {
    await db.query('SELECT id FROM tenants FOR UPDATE'); // una sola importación a la vez
    if (!(await catalogoVacio(db))) throw new ErrorApi(409, 'El servidor ya tiene un menú. Edítalo en Ajustes en vez de volver a subirlo.');
    const ids: Record<string, string> = {};
    let n = 0;

    // Categorías en el orden de la app (sin Pizzas ni Bebidas, que son especiales)
    const cats = (Array.isArray(b.categorias) ? b.categorias : []).filter((c): c is string => typeof c === 'string' && !['Pizzas', 'Bebidas'].includes(c));
    for (const c of cats.slice(0, 100)) await idCategoria(db, yo.tenant_id, texto(c, 'la categoría', { max: 40 }));

    for (const p of lista(b.productos, 'productos', 500)) {
      const nombre = texto(p.nombre, 'el nombre del producto', { max: 80 });
      const q = await db.query(
        'INSERT INTO products (tenant_id, category_id, nombre, precio, activo) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [yo.tenant_id, await idCategoria(db, yo.tenant_id, texto(p.categoria, 'la categoría', { max: 40 })), nombre, pesos(p.precio, `El precio de ${nombre}`), p.activo !== false]
      );
      if (idLocal(p)) ids[idLocal(p)] = q.rows[0].id;
      n++;
    }

    let orden = 0;
    for (const t of lista(b.pizzas, 'pizzas', 50)) {
      const gratis = typeof t.gratis === 'number' && Number.isInteger(t.gratis) && t.gratis >= 0 ? t.gratis : 2;
      const q = await db.query(
        'INSERT INTO pizza_types (tenant_id, nombre, precios, extra, gratis, sabores, orden) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
        [yo.tenant_id, texto(t.nombre, 'el nombre de la pizza', { max: 60 }), JSON.stringify(preciosTamano(t.precios, 'el precio')),
          JSON.stringify(preciosTamano(t.extra, 'el sabor adicional')), gratis, sabores(t.sabores ?? []), orden++]
      );
      if (idLocal(t)) ids[idLocal(t)] = q.rows[0].id;
      n++;
    }

    for (const grupo of Object.keys(TIPOS) as Grupo[]) {
      for (const it of lista(b[grupo], grupo, 500)) {
        const nombre = texto(it.nombre, 'el nombre', { max: 80 });
        const q = await db.query(
          `INSERT INTO inventory_items (tenant_id, tipo, nombre, unidad, precio, costo, sugerido, stock)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [yo.tenant_id, TIPOS[grupo], nombre, texto(it.unidad || 'und', 'la unidad', { max: 30 }),
            grupo === 'bebidas' ? pesos(it.precio ?? 0, `El precio de ${nombre}`) : null,
            cantidad(it.costo ?? 0, `El costo de ${nombre}`, 2), cantidad(it.sugerido ?? 0, `El stock sugerido de ${nombre}`),
            cantidad(Math.max(0, Number(it.stock) || 0), `El stock de ${nombre}`)]
        );
        if (idLocal(it)) ids[idLocal(it)] = q.rows[0].id;
        n++;
      }
    }
    await auditar(db, yo.tenant_id, yo.id, 'Menú subido al servidor', `${n} productos, pizzas e ítems de inventario`);
    return { ids, total: n };
  });
  return json(r, 201);
});
