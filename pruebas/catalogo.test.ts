// Pruebas del catálogo (menú, pizzas, inventario y datos del negocio) contra Postgres LOCAL.
// Usa el negocio de prueba "chamos-c", que empieza sin usuarios ni menú.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import * as instalar from '../api/_rutas/auth/instalar';
import * as login from '../api/_rutas/auth/login';
import * as catalogo from '../api/_rutas/catalogo/index';
import * as importar from '../api/_rutas/catalogo/importar';
import * as inventario from '../api/_rutas/catalogo/inventario';
import * as negocio from '../api/_rutas/catalogo/negocio';
import * as pizzas from '../api/_rutas/catalogo/pizzas';
import * as productos from '../api/_rutas/catalogo/productos';
import { cerrarConexiones } from '../api/_lib/db';
import * as usuarios from '../api/_rutas/usuarios';

type Ruta = (req: Request) => Promise<Response>;
async function llamar(fn: Ruta, metodo: string, cuerpo?: unknown, cookie?: string) {
  const headers: Record<string, string> = {};
  if (cuerpo !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fn(new Request('https://loschamos.test/api', { method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) }));
  return { status: res.status, datos: (await res.json()) as any, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

// Menú como lo tiene la app en el navegador (mismos nombres de campos que public/store.js)
const MENU_LOCAL = {
  categorias: ['Pizzas', 'Hamburguesas', 'Arepas', 'Bebidas'],
  productos: [
    { id: 'loc-p1', categoria: 'Hamburguesas', nombre: 'Hamburguesa clásica', precio: 15000, activo: true },
    { id: 'loc-p2', categoria: 'Arepas', nombre: 'Arepa de queso', precio: 9000, activo: true }
  ],
  pizzas: [{ id: 'sencilla', nombre: 'Pizza sencilla', gratis: 2, precios: { Personal: 15000, Mediana: 28000, Familiar: 38000 }, extra: { Personal: 2000, Mediana: 3000, Familiar: 4000 }, sabores: ['Jamón', 'Piña'] }],
  bebidas: [{ id: 'loc-b1', nombre: 'Coca-Cola 400 ml', unidad: 'und', precio: 4000, costo: 2600, sugerido: 24, stock: 10 }],
  utensilios: [{ id: 'loc-u1', nombre: 'Servilletas', unidad: 'paquete', costo: 3500, sugerido: 10, stock: 3 }],
  insumos: [{ id: 'loc-i1', nombre: 'Queso mozzarella', unidad: 'kg', costo: 24000.5, sugerido: 5, stock: 2.35 }]
};

let admin = '', mesera = '';
before(async () => {
  process.env.CLAVE_INSTALACION = 'frase-de-instalacion-larga';
  admin = (await llamar(instalar.POST, 'POST', { codigo: 'chamos-c', claveInstalacion: 'frase-de-instalacion-larga', nombre: 'Dueño C', usuario: 'duenoc', clave: 'clave-segura-c' })).cookie;
  await llamar(usuarios.POST, 'POST', { nombre: 'Mesera C', usuario: 'meserac', clave: '1234', rol: 'mesera' }, admin);
  mesera = (await llamar(login.POST, 'POST', { codigo: 'chamos-c', usuario: 'meserac', clave: '1234' })).cookie;
});
after(cerrarConexiones);

describe('API: catálogo', () => {
  let ids: Record<string, string> = {};

  test('Un negocio nuevo empieza con el catálogo vacío', async () => {
    const r = await llamar(catalogo.GET, 'GET', undefined, mesera);
    assert.equal(r.status, 200);
    assert.equal(r.datos.vacio, true);
    assert.equal(r.datos.negocio.codigo, 'chamos-c');
  });

  test('La mesera ve el menú pero no puede cambiarlo ni subirlo', async () => {
    assert.equal((await llamar(productos.POST, 'POST', { nombre: 'X', categoria: 'Y', precio: 1000 }, mesera)).status, 403);
    assert.equal((await llamar(importar.POST, 'POST', MENU_LOCAL, mesera)).status, 403);
    assert.equal((await llamar(catalogo.GET, 'GET')).status, 401, 'sin sesión no se ve el menú');
  });

  test('El administrador sube el menú de su equipo una sola vez', async () => {
    const r = await llamar(importar.POST, 'POST', MENU_LOCAL, admin);
    assert.equal(r.status, 201);
    assert.equal(r.datos.total, 6);
    ids = r.datos.ids;
    assert.ok(ids['loc-p1'] && ids['sencilla'] && ids['loc-b1'], 'devuelve los ids nuevos para actualizar la app');
    assert.equal((await llamar(importar.POST, 'POST', MENU_LOCAL, admin)).status, 409, 'no se puede subir encima de un menú existente');
  });

  test('El catálogo vuelve con números de verdad (no textos) y en orden', async () => {
    const { datos } = await llamar(catalogo.GET, 'GET', undefined, mesera);
    assert.equal(datos.vacio, false);
    assert.deepEqual(datos.categorias, ['Hamburguesas', 'Arepas']);
    assert.equal(datos.productos.find((p: any) => p.nombre === 'Arepa de queso').precio, 9000);
    assert.equal(datos.pizzas[0].precios.Familiar, 38000);
    assert.equal(datos.inventario.bebidas[0].precio, 4000);
    assert.equal(datos.inventario.insumos[0].costo, 24000.5, 'el costo unitario admite decimales');
    assert.equal(datos.inventario.insumos[0].stock, 2.35);
    assert.equal(datos.inventario.utensilios[0].precio, undefined, 'los utensilios no tienen precio de venta');
  });

  test('Crear, editar y eliminar productos, solo con pesos enteros', async () => {
    assert.equal((await llamar(productos.POST, 'POST', { nombre: 'Perro', categoria: 'Perros', precio: 9000.5 }, admin)).status, 400, 'no acepta centavos');
    assert.equal((await llamar(productos.POST, 'POST', { nombre: 'Pizza X', categoria: 'Pizzas', precio: 1000 }, admin)).status, 400, 'Pizzas es una categoría especial');
    const c = await llamar(productos.POST, 'POST', { nombre: 'Perro sencillo', categoria: 'Perros', precio: 9000 }, admin);
    assert.equal(c.status, 201);
    const e = await llamar(productos.PATCH, 'PATCH', { id: ids['loc-p1'], nombre: 'Hamburguesa clásica', categoria: 'Hamburguesas', precio: 16000, activo: true }, admin);
    assert.equal(e.status, 200);
    const { datos } = await llamar(catalogo.GET, 'GET', undefined, mesera);
    assert.ok(datos.categorias.includes('Perros'), 'la categoría nueva se crea sola');
    assert.equal(datos.productos.find((p: any) => p.id === ids['loc-p1']).precio, 16000);
    assert.equal((await llamar(productos.DELETE, 'DELETE', { id: c.datos.id }, admin)).status, 200);
    assert.ok(!(await llamar(catalogo.GET, 'GET', undefined, mesera)).datos.productos.some((p: any) => p.id === c.datos.id), 'eliminado');
  });

  test('Editar pizzas: precios por tamaño y sabores', async () => {
    const r = await llamar(pizzas.PATCH, 'PATCH', { id: ids['sencilla'], nombre: 'Pizza sencilla', precios: { Personal: 16000, Mediana: 29000, Familiar: 0 }, extra: { Personal: 2000, Mediana: 3000, Familiar: 0 }, gratis: 2, sabores: ['Jamón', 'Piña', 'Maíz'] }, admin);
    assert.equal(r.status, 200);
    const pz = (await llamar(catalogo.GET, 'GET', undefined, mesera)).datos.pizzas[0];
    assert.deepEqual(pz.precios, { Personal: 16000, Mediana: 29000, Familiar: 0 });
    assert.deepEqual(pz.sabores, ['Jamón', 'Piña', 'Maíz']);
    const mal = await llamar(pizzas.PATCH, 'PATCH', { id: ids['sencilla'], nombre: 'P', precios: { Personal: 'caro' }, extra: {}, gratis: 2, sabores: [] }, admin);
    assert.equal(mal.status, 400);
  });

  test('Inventario: crear, editar y eliminar sin tocar el stock', async () => {
    const c = await llamar(inventario.POST, 'POST', { tipo: 'bebidas', nombre: 'Malta', unidad: 'und', precio: 3500, costo: 2300, sugerido: 24 }, admin);
    assert.equal(c.status, 201);
    assert.equal((await llamar(inventario.POST, 'POST', { tipo: 'licores', nombre: 'Ron', unidad: 'und', costo: 1 }, admin)).status, 400);
    const e = await llamar(inventario.PATCH, 'PATCH', { id: ids['loc-i1'], nombre: 'Queso mozzarella', unidad: 'kg', costo: 25000, sugerido: 6, stock: 999 }, admin);
    assert.equal(e.status, 200);
    const inv = (await llamar(catalogo.GET, 'GET', undefined, mesera)).datos.inventario;
    const queso = inv.insumos.find((x: any) => x.id === ids['loc-i1']);
    assert.equal(queso.costo, 25000);
    assert.equal(queso.stock, 2.35, 'editar el ítem no cambia su stock');
    assert.equal((await llamar(inventario.DELETE, 'DELETE', { id: c.datos.id }, admin)).status, 200);
    assert.ok(!(await llamar(catalogo.GET, 'GET', undefined, mesera)).datos.inventario.bebidas.some((x: any) => x.nombre === 'Malta'));
  });

  test('Datos del negocio: mesas, ticket y WhatsApp, pero no el código', async () => {
    const base = { nombre: 'Los Chamos C', whatsapp: '57 300 111 2233', mesas: 10, ticket: 80, valorDomicilio: 3000, imprimirComandas: false, nit: '900.123.456-7' };
    assert.equal((await llamar(negocio.PATCH, 'PATCH', { ...base, mesas: 0 }, admin)).status, 400);
    assert.equal((await llamar(negocio.PATCH, 'PATCH', { ...base, whatsapp: '123' }, admin)).status, 400);
    assert.equal((await llamar(negocio.PATCH, 'PATCH', { ...base, codigo: 'robado' }, admin)).status, 200);
    const n = (await llamar(catalogo.GET, 'GET', undefined, mesera)).datos.negocio;
    assert.equal(n.nombre, 'Los Chamos C');
    assert.equal(n.whatsapp, '573001112233');
    assert.equal(n.codigo, 'chamos-c', 'el código no cambia');
    assert.deepEqual({ mesas: n.config.mesas, ticket: n.config.ticket, valorDomicilio: n.config.valorDomicilio, imprimirComandas: n.config.imprimirComandas }, { mesas: 10, ticket: 80, valorDomicilio: 3000, imprimirComandas: false });
    assert.equal((await llamar(negocio.PATCH, 'PATCH', base, mesera)).status, 403);
  });
});
