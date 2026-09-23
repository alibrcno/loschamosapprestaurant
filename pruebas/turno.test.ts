// Pruebas del turno y la caja contra Postgres LOCAL: un día completo del negocio "chamos-d".
// Apertura → gastos, traslado, llegadas, ventas → cierre de caja (encargada) → inventario de cocina,
// que es el último paso y el que calcula el resultado del día.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import * as api from '../api/index';
import { cerrarConexiones } from '../api/_lib/db';

async function llamar(ruta: string, metodo: string, cuerpo?: unknown, cookie?: string) {
  const headers: Record<string, string> = {};
  if (cuerpo !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const fn = (api as any)[metodo] as (r: Request) => Promise<Response>;
  const res = await fn(new Request('https://loschamos.test/api/' + ruta, { method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) }));
  return { status: res.status, datos: (await res.json()) as any, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const entrar = async (usuario: string, clave: string) => (await llamar('auth/login', 'POST', { codigo: 'chamos-d', usuario, clave })).cookie;

let admin = '', enc = '', cocina = '', mesera = '';
let coca = '', servilletas = '', queso = '', pizza = '', idCocinero = '';

before(async () => {
  process.env.CLAVE_INSTALACION = 'frase-de-instalacion-larga';
  admin = (await llamar('auth/instalar', 'POST', { codigo: 'chamos-d', claveInstalacion: 'frase-de-instalacion-larga', nombre: 'Dueño D', usuario: 'duenod', clave: 'clave-segura-d' })).cookie;
  await llamar('usuarios', 'POST', { nombre: 'Encargada D', usuario: 'encd', clave: '1234', rol: 'encargada' }, admin);
  idCocinero = (await llamar('usuarios', 'POST', { nombre: 'Cocinero D', usuario: 'cocid', clave: '1234', rol: 'cocina' }, admin)).datos.usuario.id;
  await llamar('usuarios', 'POST', { nombre: 'Mesera D', usuario: 'mesd', clave: '1234', rol: 'mesera' }, admin);
  [enc, cocina, mesera] = [await entrar('encd', '1234'), await entrar('cocid', '1234'), await entrar('mesd', '1234')];
  const ids = (await llamar('catalogo/importar', 'POST', {
    categorias: [], productos: [{ id: 'p', categoria: 'Especiales', nombre: 'Pizza de la casa', precio: 54000 }], pizzas: [],
    bebidas: [{ id: 'c', nombre: 'Coca-Cola', unidad: 'und', precio: 4000, costo: 2600, sugerido: 24, stock: 0 }],
    utensilios: [{ id: 's', nombre: 'Servilletas', unidad: 'paquete', costo: 3500, sugerido: 10, stock: 0 }],
    insumos: [{ id: 'q', nombre: 'Queso', unidad: 'kg', costo: 24000, sugerido: 5, stock: 1 }]
  }, admin)).datos.ids;
  [coca, servilletas, queso, pizza] = [ids.c, ids.s, ids.q, ids.p];
});
after(cerrarConexiones);

const apertura = (extra: Record<string, unknown> = {}) => ({
  personal: [{ id: idCocinero, nombre: 'Cocinero D', area: 'Cocina' }, { nombre: 'Ayudante sin usuario', area: 'Salón' }],
  bebidas: { [coca]: 10 }, utensilios: { [servilletas]: 5 },
  saldos: { Efectivo: 100000, Nequi: 0, Bancolombia: 0, 'Datáfono': 0 }, nota: 'Base inicial de la caja', ...extra
});

describe('API: turno y caja', () => {
  test('Un negocio nuevo trae sus 4 cuentas y la caja cerrada', async () => {
    const r = await llamar('turno', 'GET', undefined, enc);
    assert.equal(r.status, 200);
    assert.deepEqual(r.datos.cuentas, ['Efectivo', 'Nequi', 'Bancolombia', 'Datáfono']);
    assert.equal(r.datos.turnoActualId, null);
  });

  test('Abrir la caja: permisos, cocina obligatoria y explicación si el arqueo no cuadra', async () => {
    assert.equal((await llamar('turno/abrir', 'POST', apertura(), mesera)).status, 403, 'la mesera no abre caja');
    assert.equal((await llamar('turno/abrir', 'POST', apertura({ personal: [{ nombre: 'X', area: 'Salón' }] }), enc)).status, 400, 'debe haber alguien en cocina');
    assert.equal((await llamar('turno/abrir', 'POST', apertura({ nota: '' }), enc)).status, 400, 'hay $100.000 que el sistema no conocía: pide explicación');
    assert.equal((await llamar('turno/abrir', 'POST', apertura({ bebidas: {} }), enc)).status, 409, 'el conteo debe traer todas las bebidas');
    const r = await llamar('turno/abrir', 'POST', apertura(), enc);
    assert.equal(r.status, 201);
    assert.equal(r.datos.saldos.Efectivo, 100000, 'el arqueo quedó como ajuste en el libro');
    const t = r.datos.turnos.find((x: any) => x.id === r.datos.turnoActualId);
    assert.equal(t.personal.length, 2);
    assert.equal(t.apertura.insumos[queso], 1, 'los insumos arrancan con el stock que había');
    assert.equal((await llamar('turno/abrir', 'POST', apertura(), enc)).status, 409, 'no se abre dos veces');
  });

  test('La mesera ve la caja abierta pero no el dinero', async () => {
    const r = await llamar('turno', 'GET', undefined, mesera);
    assert.ok(r.datos.turnoActualId);
    assert.deepEqual(r.datos.saldos, {});
    assert.deepEqual(r.datos.movimientos, []);
    assert.equal(r.datos.turnos[0].apertura.saldosContados, undefined);
  });

  test('Gastos, traslados y llegadas de mercancía van al libro con su cuenta', async () => {
    assert.equal((await llamar('turno/movimiento', 'POST', { tipo: 'gasto', cuenta: 'Efectivo', monto: 20000.5, concepto: 'Gas', categoria: 'Otros' }, enc)).status, 400);
    assert.equal((await llamar('turno/movimiento', 'POST', { tipo: 'gasto', cuenta: 'Efectivo', monto: 20000, concepto: 'Gas', categoria: 'Inventada' }, enc)).status, 400);
    assert.equal((await llamar('turno/movimiento', 'POST', { tipo: 'gasto', cuenta: 'Efectivo', monto: 20000, concepto: 'Gas', categoria: 'Otros' }, mesera)).status, 403);
    assert.equal((await llamar('turno/movimiento', 'POST', { tipo: 'gasto', cuenta: 'Efectivo', monto: 20000, concepto: 'Gas', categoria: 'Otros' }, enc)).status, 201);
    assert.equal((await llamar('turno/traslado', 'POST', { desde: 'Efectivo', hacia: 'Efectivo', monto: 1000 }, enc)).status, 400);
    assert.equal((await llamar('turno/traslado', 'POST', { desde: 'Efectivo', hacia: 'Bancolombia', monto: 30000, concepto: 'Consignación' }, enc)).status, 201);
    // Cocina registra el queso que llegó, pagado en efectivo; no puede registrar bebidas
    assert.equal((await llamar('turno/llegada', 'POST', { itemId: coca, cantidad: 12 }, cocina)).status, 403);
    assert.equal((await llamar('turno/llegada', 'POST', { itemId: queso, cantidad: 2, costo: 50000, cuenta: 'Efectivo', nota: 'Lácteos del Cesar' }, cocina)).status, 201);
    assert.equal((await llamar('turno/llegada', 'POST', { itemId: coca, cantidad: 12, cuenta: 'Efectivo' }, enc)).status, 400, 'si se pagó, debe decir cuánto');
    const r = await llamar('turno/llegada', 'POST', { itemId: coca, cantidad: 12 }, enc);
    assert.equal(r.status, 201);
    assert.equal(r.datos.entradas.length, 2);
    assert.equal(r.datos.saldos.Efectivo, 100000 - 20000 - 30000 - 50000);
    assert.equal(r.datos.saldos.Bancolombia, 30000);
  });

  test('Cobro dividido: mitad Nequi, mitad efectivo', async () => {
    const env = await llamar('pedidos', 'POST', { accion: 'enviar', lote: randomUUID(), nueva: { tipo: 'mesa', mesa: 3 },
      lineas: [{ tipo: 'producto', id: pizza, qty: 1 }, { tipo: 'bebida', id: coca, qty: 2 }] }, mesera);
    assert.equal(env.status, 201);
    const cobro = { accion: 'cobrar', orden: env.datos.orden.id, total: 62000, pagos: [{ cuenta: 'Nequi', monto: 31000 }, { cuenta: 'Efectivo', monto: 31000 }] };
    assert.equal((await llamar('pedidos', 'POST', cobro, mesera)).status, 403, 'la mesera no cobra');
    const r = await llamar('pedidos', 'POST', cobro, enc);
    assert.equal(r.status, 201);
    assert.deepEqual([r.datos.estado.saldos.Efectivo, r.datos.estado.saldos.Nequi], [31000, 31000]);
  });

  test('Cierre de caja (encargada): exige explicar diferencias y deja el turno esperando a cocina', async () => {
    const cierre = { bebidas: { [coca]: 20 }, utensilios: { [servilletas]: 4 }, saldos: { Efectivo: 31000, Nequi: 31000, Bancolombia: 30000, 'Datáfono': 0 } };
    const falta = await llamar('turno/cerrar-caja', 'POST', { ...cierre, saldos: { ...cierre.saldos, Efectivo: 30000 } }, enc);
    assert.equal(falta.status, 400, 'faltan $1.000 en efectivo y no hay explicación');
    const bebidaSinCobrar = await llamar('turno/cerrar-caja', 'POST', { ...cierre, bebidas: { [coca]: 19 } }, enc);
    assert.equal(bebidaSinCobrar.status, 400, 'salió una Coca-Cola más de las cobradas');
    const r = await llamar('turno/cerrar-caja', 'POST', cierre, enc);
    assert.equal(r.status, 201);
    assert.equal(r.datos.termino, false, 'falta cocina');
    const t = r.datos.turnos.find((x: any) => x.id === r.datos.turnoId);
    assert.equal(t.cajaCerrada, true);
    assert.equal(t.resumen.cocinaCerrada, false);
  });

  test('Con la caja cerrada ya no se vende ni se abre otro turno hasta que cocina termine', async () => {
    assert.equal((await llamar('pedidos', 'POST', { accion: 'enviar', lote: randomUUID(), nueva: { tipo: 'mesa', mesa: 1 }, lineas: [{ tipo: 'bebida', id: coca, qty: 1 }] }, enc)).status, 409);
    assert.equal((await llamar('turno/movimiento', 'POST', { tipo: 'gasto', cuenta: 'Efectivo', monto: 1000, concepto: 'x', categoria: 'Otros' }, enc)).status, 409);
    const otra = await llamar('turno/abrir', 'POST', apertura(), enc);
    assert.equal(otra.status, 409);
    assert.match(otra.datos.error, /inventario de cierre de cocina/);
  });

  test('Cocina hace el último cierre y ahí sale la utilidad del día', async () => {
    const r = await llamar('turno/cerrar-cocina', 'POST', { conteo: { [queso]: 1.5 }, obs: 'Todo bien' }, cocina);
    assert.equal(r.status, 201);
    assert.equal(r.datos.termino, true);
    assert.equal(r.datos.turnoActualId, null, 'el turno terminó');
    const t = (await llamar('turno', 'GET', undefined, admin)).datos.turnos.find((x: any) => x.id === r.datos.turnoId);
    const res = t.resumen;
    // Ventas 62.000. Costo: 2 Coca-Cola (2 × 2.600) + 1 paquete de servilletas (3.500) + 1,5 kg de queso a 25.000 (50.000 / 2 kg)
    assert.equal(res.ventas, 62000);
    assert.equal(res.costoBebidas, 5200);
    assert.equal(res.costoUtensilios, 3500);
    assert.equal(res.costoInsumos, 37500);
    assert.equal(res.gastosOp, 20000, 'el gas; la compra de queso no se resta dos veces');
    assert.equal(res.compras, 50000);
    assert.equal(res.utilidad, 62000 - 5200 - 3500 - 37500 - 20000);
    assert.equal(res.cocinaCerrada, true);
    assert.deepEqual(res.descuadre, { Efectivo: 0, Nequi: 0, Bancolombia: 0, 'Datáfono': 0 });
    assert.equal(res.personal.length, 2);
    // Lo vendido sale de las cuentas cobradas en el servidor
    assert.equal(res.ordenesPagadas, 1);
    assert.deepEqual(res.porCategoria, { Especiales: 54000, Bebidas: 8000 });
    assert.equal(res.bebidas.find((b: any) => b.id === coca).pos, 2);
  });

  test('Si cocina no hace inventario, la encargada puede terminar el turno con un motivo', async () => {
    const r1 = await llamar('turno/abrir', 'POST', apertura({ bebidas: { [coca]: 20 }, utensilios: { [servilletas]: 4 }, saldos: { Efectivo: 31000, Nequi: 31000, Bancolombia: 30000, 'Datáfono': 0 }, nota: '' }), enc);
    assert.equal(r1.status, 201, 'el día siguiente abre sin diferencias');
    const t1 = r1.datos.turnos.find((x: any) => x.id === r1.datos.turnoActualId);
    assert.equal(t1.apertura.insumos[queso], 1.5, 'arranca con lo que contó cocina anoche');
    assert.equal((await llamar('turno/terminar-sin-cocina', 'POST', { motivo: 'x' }, enc)).status, 409, 'primero se cierra la caja');
    await llamar('turno/cerrar-caja', 'POST', { bebidas: { [coca]: 20 }, utensilios: { [servilletas]: 4 }, saldos: { Efectivo: 31000, Nequi: 31000, Bancolombia: 30000, 'Datáfono': 0 } }, enc);
    assert.equal((await llamar('turno/terminar-sin-cocina', 'POST', {}, enc)).status, 400, 'el motivo es obligatorio');
    const r = await llamar('turno/terminar-sin-cocina', 'POST', { motivo: 'El cocinero se fue temprano' }, enc);
    assert.equal(r.status, 201);
    assert.equal(r.datos.turnoActualId, null);
  });

  test('Ajuste de stock con motivo y auditoría visible para el administrador', async () => {
    assert.equal((await llamar('turno/ajuste', 'POST', { itemId: coca, stock: 18, motivo: 'Se rompieron 2' }, enc)).status, 403, 'la encargada no ajusta stock');
    assert.equal((await llamar('turno/ajuste', 'POST', { itemId: coca, stock: 18 }, admin)).status, 400, 'sin motivo no');
    assert.equal((await llamar('turno/ajuste', 'POST', { itemId: coca, stock: 18, motivo: 'Se rompieron 2' }, admin)).status, 201);
    const cat = await llamar('catalogo', 'GET', undefined, admin);
    assert.equal(cat.datos.inventario.bebidas[0].stock, 18);
    const a = await llamar('auditoria', 'GET', undefined, admin);
    const acciones = a.datos.auditoria.map((x: any) => x.accion);
    for (const acc of ['Apertura de caja', 'Llegada de mercancía', 'Cierre de caja', 'Inventario de cierre de cocina', 'Turno terminado sin inventario de cocina', 'Ajuste de stock']) {
      assert.ok(acciones.includes(acc), acc);
    }
    assert.equal((await llamar('auditoria', 'GET', undefined, enc)).status, 403);
  });
});
