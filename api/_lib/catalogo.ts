// Menú, pizzas, inventario y datos del negocio: lectura y validaciones compartidas.
import type { PoolClient } from 'pg';
import { ErrorApi, pesos, texto } from './http';

/** En la app el inventario se agrupa en bebidas, utensilios e insumos; en la base cada ítem tiene su tipo. */
export const TIPOS = { bebidas: 'bebida', utensilios: 'utensilio', insumos: 'insumo' } as const;
export type Grupo = keyof typeof TIPOS;
export const TAMANOS = ['Personal', 'Mediana', 'Familiar'] as const;

export function leerGrupo(v: unknown): Grupo {
  if (typeof v !== 'string' || !(v in TIPOS)) throw new ErrorApi(400, 'El tipo de inventario no es válido');
  return v as Grupo;
}

/** Cantidades y costos unitarios: pueden tener decimales (kilos, costo por gramo), nunca negativos. */
export function cantidad(v: unknown, campo: string, decimales = 3): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e9) throw new ErrorApi(400, `${campo} debe ser un número mayor o igual a 0`);
  const f = 10 ** decimales;
  return Math.round(v * f) / f;
}

/** Precios por tamaño de pizza: { Personal, Mediana, Familiar } en pesos enteros (0 = no se vende ese tamaño). */
export function preciosTamano(v: unknown, campo: string): Record<string, number> {
  if (!v || typeof v !== 'object') throw new ErrorApi(400, `Faltan ${campo}`);
  const o = v as Record<string, unknown>;
  return Object.fromEntries(TAMANOS.map((t) => [t, pesos(o[t] ?? 0, `${campo} ${t}`)]));
}

export function sabores(v: unknown): string[] {
  if (!Array.isArray(v)) throw new ErrorApi(400, 'Los sabores deben ser una lista');
  const s = [...new Set(v.map((x) => texto(x, 'el sabor', { max: 60 })))];
  if (s.length > 60) throw new ErrorApi(400, 'Demasiados sabores');
  return s;
}

/** Busca la categoría por nombre y la crea si no existe. Devuelve su id. */
export async function idCategoria(db: PoolClient, tenantId: string, nombre: string): Promise<string> {
  const r = await db.query(
    `INSERT INTO categories (tenant_id, nombre, orden)
     VALUES ($1, $2, (SELECT coalesce(max(orden), 0) + 1 FROM categories))
     ON CONFLICT (tenant_id, nombre) DO UPDATE SET nombre = EXCLUDED.nombre
     RETURNING id`,
    [tenantId, nombre]
  );
  return r.rows[0].id;
}

/** Todo el catálogo del negocio, con la misma forma que usa la app (public/store.js). */
export async function leerCatalogo(db: PoolClient) {
  const [neg, cats, prods, pizzas, inv] = await Promise.all([
    db.query('SELECT nombre, codigo, nit, direccion, telefono, whatsapp, config FROM tenants'),
    db.query('SELECT nombre, extras FROM categories ORDER BY orden, nombre'),
    db.query(`SELECT p.id, c.nombre AS categoria, p.nombre, p.precio, p.activo
              FROM products p LEFT JOIN categories c ON c.id = p.category_id ORDER BY c.orden, p.nombre`),
    db.query('SELECT id, nombre, precios, extra, gratis, sabores FROM pizza_types WHERE activo ORDER BY orden, nombre'),
    db.query('SELECT id, tipo, nombre, unidad, precio, costo, sugerido, stock FROM inventory_items WHERE activo ORDER BY nombre')
  ]);
  const grupo = (tipo: string) =>
    inv.rows.filter((x) => x.tipo === tipo).map(({ tipo: _t, precio, ...x }) => (tipo === 'bebida' ? { ...x, precio } : x));
  return {
    negocio: neg.rows[0],
    categorias: cats.rows.map((c) => c.nombre as string),
    extras: Object.fromEntries(cats.rows.filter((c) => c.extras && c.extras.length).map((c) => [c.nombre, c.extras])) as Record<string, { nombre: string; precio: number }[]>,
    productos: prods.rows,
    pizzas: pizzas.rows,
    inventario: { bebidas: grupo('bebida'), utensilios: grupo('utensilio'), insumos: grupo('insumo') }
  };
}

/** true si el negocio todavía no tiene menú ni inventario en el servidor. */
export async function catalogoVacio(db: PoolClient): Promise<boolean> {
  const r = await db.query(
    `SELECT (SELECT count(*) FROM products) + (SELECT count(*) FROM pizza_types) + (SELECT count(*) FROM inventory_items) AS n`
  );
  return Number(r.rows[0].n) === 0;
}

/** Error de llave foránea: el registro ya se usó en ventas o movimientos. */
export const yaUsado = (e: unknown) => (e as { code?: string }).code === '23503';
