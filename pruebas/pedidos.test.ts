// Pruebas de los pedidos en el servidor contra Postgres LOCAL (negocio "chamos-f"):
// varias meseras a la vez, precios del menú del servidor, comandas, pre-cuenta, anulaciones,
// cobro dividido y la cola de impresión que atiende el PC de caja.
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
const entrar = async (usuario: string) => (await llamar('auth/login', 'POST', { codigo: 'chamos-f', usuario, clave: '1234' })).cookie;
const pedido = (cookie: string, datos: Record<string, unknown>) => llamar('pedidos', 'POST', datos, cookie);

let admin = '', enc = '', cocina = '', mesera1 = '', mesera2 = '';
const ids: Record<string, string> = {};
const saldos0 = { Efectivo: 0, Nequi: 0, Bancolombia: 0, 'Datáfono': 0 };

before(async () => {
  process.env.CLAVE_INSTALACION = 'frase-de-instalacion-larga';
  admin = (await llamar('auth/instalar', 'POST', { codigo: 'chamos-f', claveInstalacion: 'frase-de-instalacion-larga', nombre: 'Dueño F', usuario: 'duenof', clave: 'clave-segura-f' })).cookie;
  for (const [nombre, usuario, rol] of [['Encargada F', 'encf', 'encargada'], ['Cocina F', 'cocif', 'cocina'], ['Ana', 'anaf', 'mesera'], ['Bea', 'beaf', 'mesera']]) {
    await llamar('usuarios', 'POST', { nombre, usuario, clave: '1234', rol }, admin);
  }
  [enc, cocina, mesera1, mesera2] = [await entrar('encf'), await entrar('cocif'), await entrar('anaf'), await entrar('beaf')];
  Object.assign(ids, (await llamar('catalogo/importar', 'POST', {
    categorias: ['Hamburguesas'],
    productos: [{ id: 'h', categoria: 'Hamburguesas', nombre: 'Hamburguesa clásica', precio: 15000 }],
    pizzas: [{ id: 'pz', nombre: 'Pizza sencilla', gratis: 2, precios: { Personal: 15000, Mediana: 28000, Familiar: 0 }, extra: { Personal: 2000, Mediana: 3000, Familiar: 0 }, sabores: ['Jamón', 'Piña', 'Maíz'] }],
    bebidas: [{ id: 'c', nombre: 'Coca-Cola', unidad: 'und', precio: 4000, costo: 2600, sugerido: 24, stock: 0 }],
    utensilios: [], insumos: []
  }, admin)).datos.ids);
  await llamar('turno/abrir', 'POST', { personal: [{ nombre: 'Cocina F', area: 'Cocina' }], bebidas: { [ids.c]: 24 }, utensilios: {}, saldos: saldos0 }, enc);
});
after(cerrarConexiones);

describe('API: pedidos de varias meseras e impresión en caja', () => {
  let mesa2 = '', lote = '';

  test('La mesera envía el pedido y el servidor pone los precios del menú', async () => {
    lote = randomUUID();
    const r = await pedido(mesera1, {
      accion: 'enviar', lote, nueva: { tipo: 'mesa', mesa: 2 },
      lineas: [
        { tipo: 'producto', id: ids.h, qty: 2, obs: 'sin cebolla', precio: 1 },  // el precio que mande el celular se ignora
        { tipo: 'pizza', id: ids.pz, tamano: 'Mediana', sabores: ['Jamón', 'Piña', 'Maíz'], qty: 1 },
        { tipo: 'bebida', id: ids.c, qty: 2 }
      ]
    });
    assert.equal(r.status, 201);
    const o = r.datos.orden;
    mesa2 = o.id;
    assert.equal(o.numero, 1);
    assert.equal(r.datos.comanda, 1);
    assert.equal(o.mesero, 'Ana');
    assert.deepEqual(o.lineas.map((l: any) => [l.nombre, l.precio, l.qty, l.comanda]), [
      ['Hamburguesa clásica', 15000, 2, 1], ['Pizza sencilla Mediana', 31000, 1, 1], ['Coca-Cola', 4000, 2, null]
    ], 'la pizza con un sabor adicional: 28.000 + 3.000; la bebida no va a cocina');
    assert.equal(o.lineas[1].detalle, 'Jamón, Piña, Maíz (1 adicional)');
    assert.equal(o.comandas[0].lids.length, 2);
  });

  test('Si el celular reintenta el mismo envío, no se duplica', async () => {
    const r = await pedido(mesera1, { accion: 'enviar', lote, nueva: { tipo: 'mesa', mesa: 2 }, lineas: [{ tipo: 'bebida', id: ids.c, qty: 2 }] });
    assert.equal(r.datos.repetido, true);
    assert.equal(r.datos.orden.lineas.length, 3);
  });

  test('Otra mesera que abre la misma mesa suma a la misma cuenta', async () => {
    const r = await pedido(mesera2, { accion: 'enviar', lote: randomUUID(), nueva: { tipo: 'mesa', mesa: 2 }, lineas: [{ tipo: 'producto', id: ids.h, qty: 1 }], nota: '  Tienen afán  ' });
    assert.equal(r.datos.orden.id, mesa2);
    assert.equal(r.datos.orden.comandas[1].nota, 'Tienen afán', 'la comanda lleva la nota para cocina');
    assert.equal(r.datos.comanda, 2);
    assert.equal(r.datos.orden.lineas.length, 4);
  });

  test('Extras por categoría: los elige la mesera y el precio lo pone el servidor', async () => {
    assert.equal((await llamar('catalogo/categorias', 'PATCH', { nombre: 'Hamburguesas', extras: [{ nombre: 'Queso extra', precio: 3000 }] }, enc)).status, 403, 'solo quien edita el menú');
    assert.equal((await llamar('catalogo/categorias', 'PATCH', { nombre: 'Hamburguesas', extras: [{ nombre: 'Queso extra', precio: 3000.5 }] }, admin)).status, 400);
    assert.equal((await llamar('catalogo/categorias', 'PATCH', { nombre: 'Hamburguesas', extras: [{ nombre: 'Queso extra', precio: 3000 }, { nombre: 'Tocineta', precio: 4000 }] }, admin)).status, 200);
    assert.deepEqual((await llamar('catalogo', 'GET', undefined, mesera1)).datos.extras.Hamburguesas.map((x: any) => x.precio), [3000, 4000]);
    const lote = randomUUID();
    assert.equal((await pedido(mesera1, { accion: 'enviar', lote, nueva: { tipo: 'mesa', mesa: 7 }, lineas: [{ tipo: 'producto', id: ids.h, qty: 1, extras: ['Caviar'] }] })).status, 409);
    const r = await pedido(mesera1, { accion: 'enviar', lote, nueva: { tipo: 'mesa', mesa: 7 }, lineas: [{ tipo: 'producto', id: ids.h, qty: 2, extras: ['Queso extra', 'Tocineta'] }] });
    const l = r.datos.orden.lineas[0];
    assert.deepEqual([l.precio, l.detalle], [22000, 'Con Queso extra, Tocineta'], '15.000 + 3.000 + 4.000');
    // La mesa 7 se anula para no cambiar las cuentas de las demás pruebas
    await pedido(enc, { accion: 'anular', orden: r.datos.orden.id, linea: l.lid, motivo: 'prueba de extras' });
    await pedido(enc, { accion: 'liberar', orden: r.datos.orden.id });
  });

  test('Datos inválidos se rechazan', async () => {
    const base = { accion: 'enviar', nueva: { tipo: 'mesa', mesa: 5 } };
    assert.equal((await pedido(mesera1, { ...base, lote: randomUUID(), lineas: [{ tipo: 'producto', id: ids.h, qty: 1.5 }] })).status, 400, 'cantidad con decimales');
    assert.equal((await pedido(mesera1, { ...base, lote: randomUUID(), lineas: [{ tipo: 'pizza', id: ids.pz, tamano: 'Familiar', sabores: ['Jamón'], qty: 1 }] })).status, 400, 'tamaño que no se vende');
    assert.equal((await pedido(mesera1, { ...base, lote: randomUUID(), lineas: [{ tipo: 'pizza', id: ids.pz, tamano: 'Personal', sabores: ['Caviar'], qty: 1 }] })).status, 409, 'sabor que no existe');
    assert.equal((await pedido(mesera1, { ...base, lote: randomUUID(), lineas: [{ tipo: 'domicilio', monto: 3000, qty: 1 }] })).status, 400, 'el domicilio solo en domicilios');
    assert.equal((await pedido(mesera1, { ...base, nueva: { tipo: 'mesa', mesa: 99 }, lote: randomUUID(), lineas: [{ tipo: 'bebida', id: ids.c, qty: 1 }] })).status, 400, 'mesa que no existe');
    assert.equal((await pedido(cocina, { ...base, lote: randomUUID(), lineas: [{ tipo: 'bebida', id: ids.c, qty: 1 }] })).status, 403, 'cocina no toma pedidos');
    assert.equal((await llamar('pedidos', 'GET', undefined, enc)).datos.ordenes.length, 2, 'no quedó ninguna cuenta a medias (la mesa 2 y la 7, ya liberada)');
  });

  test('Quitar: solo lo que no fue a cocina y no salió en la pre-cuenta', async () => {
    const o = (await llamar('pedidos', 'GET', undefined, mesera1)).datos.ordenes[0];
    const hamb = o.lineas[0], coca = o.lineas[2];
    assert.equal((await pedido(mesera1, { accion: 'quitar', orden: o.id, linea: hamb.lid })).status, 409, 'ya está en cocina');
    const r = await pedido(mesera1, { accion: 'quitar', orden: o.id, linea: coca.lid });
    assert.equal(r.datos.orden.lineas[2].qty, 1, 'la bebida se corrige libremente');
    assert.equal((await pedido(mesera2, { accion: 'precuenta', orden: o.id })).status, 201);
    assert.equal((await pedido(mesera1, { accion: 'quitar', orden: o.id, linea: coca.lid })).status, 409, 'ya salió en la pre-cuenta');
  });

  test('Anular pide permiso y motivo, y cocina lo ve', async () => {
    const o = (await llamar('pedidos', 'GET', undefined, enc)).datos.ordenes[0];
    const hamb = o.lineas[3];
    assert.equal((await pedido(mesera1, { accion: 'anular', orden: o.id, linea: hamb.lid, motivo: 'se equivocó' })).status, 403);
    assert.equal((await pedido(enc, { accion: 'anular', orden: o.id, linea: hamb.lid })).status, 400, 'sin motivo no');
    const r = await pedido(enc, { accion: 'anular', orden: o.id, linea: hamb.lid, motivo: 'El cliente no la quiso' });
    assert.equal(r.datos.orden.lineas[3].anulada.motivo, 'El cliente no la quiso');
    const k = (await llamar('pedidos', 'GET', undefined, cocina)).datos.ordenes[0];
    assert.equal(k.lineas[3].anulada.por, 'Encargada F');
    assert.deepEqual(k.pagos, [], 'cocina no ve cómo pagan');
  });

  test('Cocina marca las comandas; la mesera no', async () => {
    const o = (await llamar('pedidos', 'GET', undefined, cocina)).datos.ordenes[0];
    assert.equal((await pedido(mesera1, { accion: 'comanda', comanda: o.comandas[0].id, estado: 'listo' })).status, 403);
    assert.equal((await pedido(cocina, { accion: 'comanda', comanda: o.comandas[0].id, estado: 'listo' })).datos.orden.comandas[0].estado, 'listo');
    assert.equal((await pedido(cocina, { accion: 'comanda', comanda: o.comandas[0].id, estado: 'entregado' })).datos.orden.comandas[0].estado, 'entregado');
  });

  test('Cada equipo pide solo lo que cambió', async () => {
    const primero = await llamar('pedidos', 'GET', undefined, mesera2);
    const desde = encodeURIComponent(primero.datos.hasta);
    const dom = { tipo: 'domicilio', cliente: 'Carlos', direccion: 'Cra 9 # 10-20', telefono: '300' };
    assert.equal((await pedido(mesera2, { accion: 'enviar', lote: randomUUID(), nueva: dom, lineas: [{ tipo: 'bebida', id: ids.c, qty: 1 }] })).status, 400, 'el domicilio dice cómo paga el cliente');
    const d = await pedido(mesera2, { accion: 'enviar', lote: randomUUID(), nueva: { ...dom, pagoCliente: 'Nequi' }, lineas: [{ tipo: 'domicilio', monto: 3000, qty: 1 }, { tipo: 'bebida', id: ids.c, qty: 1 }] });
    assert.equal(d.datos.orden.pagoCliente, 'Nequi');
    assert.equal(d.datos.comanda, null, 'sin nada para cocina no hay comanda');
    const cambios = await llamar(`pedidos?desde=${desde}`, 'GET', undefined, mesera2);
    assert.ok(cambios.datos.ordenes.some((x: any) => x.id === d.datos.orden.id));
    const futuro = await llamar(`pedidos?desde=${encodeURIComponent(new Date(Date.now() + 60000).toISOString())}`, 'GET', undefined, mesera2);
    assert.equal(futuro.datos.ordenes.length, 0);
  });

  test('Cambiar de mesa: no a una ocupada', async () => {
    const otra = await pedido(mesera1, { accion: 'enviar', lote: randomUUID(), nueva: { tipo: 'mesa', mesa: 4 }, lineas: [{ tipo: 'bebida', id: ids.c, qty: 1 }] });
    assert.equal((await pedido(mesera1, { accion: 'mover', orden: otra.datos.orden.id, mesa: 2 })).status, 409);
    assert.equal((await pedido(mesera1, { accion: 'mover', orden: otra.datos.orden.id, mesa: 6 })).datos.orden.mesa, 6);
    // Se quita la bebida y la cuenta queda en $0: se libera sin cobrar
    assert.equal((await pedido(mesera1, { accion: 'liberar', orden: otra.datos.orden.id })).status, 409, 'tiene algo por cobrar');
    await pedido(mesera1, { accion: 'quitar', orden: otra.datos.orden.id, linea: otra.datos.orden.lineas[0].lid });
    assert.equal((await pedido(mesera1, { accion: 'liberar', orden: otra.datos.orden.id })).datos.orden.estado, 'anulada');
  });

  test('Cobro dividido: valida el total, queda en el libro y no se cobra dos veces', async () => {
    const orden = mesa2;
    // 2 hamburguesas 30.000 + pizza 31.000 + 1 Coca-Cola 4.000 (la 3ª hamburguesa se anuló) = 65.000
    const base = { accion: 'cobrar', orden, total: 65000, recibido: 40000, imprimir: true };
    assert.equal((await pedido(mesera1, { ...base, pagos: [{ cuenta: 'Nequi', monto: 65000 }] })).status, 403, 'la mesera no cobra');
    assert.equal((await pedido(enc, { ...base, total: 60000, pagos: [{ cuenta: 'Nequi', monto: 60000 }] })).status, 409, 'la cuenta cambió');
    assert.equal((await pedido(enc, { ...base, pagos: [{ cuenta: 'Nequi', monto: 30000 }] })).status, 400, 'los pagos no suman');
    assert.equal((await pedido(enc, { ...base, pagos: [{ cuenta: 'Nequi', monto: 30000.5 }, { cuenta: 'Efectivo', monto: 34999.5 }] })).status, 400, 'sin decimales');
    const r = await pedido(enc, { ...base, pagos: [{ cuenta: 'Nequi', monto: 30000 }, { cuenta: 'Efectivo', monto: 35000 }] });
    assert.equal(r.status, 201);
    assert.equal(r.datos.orden.estado, 'pagada');
    assert.equal(r.datos.orden.cambio, 5000);
    assert.equal(r.datos.orden.cobradoPor, 'Encargada F');
    assert.ok(r.datos.orden.comandas.every((c: any) => c.estado === 'entregado'), 'al cobrar, sus comandas salen de la pantalla de cocina');
    assert.deepEqual([r.datos.estado.saldos.Nequi, r.datos.estado.saldos.Efectivo], [30000, 35000]);
    assert.equal((await pedido(enc, { ...base, pagos: [{ cuenta: 'Nequi', monto: 30000 }, { cuenta: 'Efectivo', monto: 35000 }] })).status, 409, 'ya se cobró');
  });

  test('El PC de caja imprime cada cosa una sola vez, y puede reimprimir', async () => {
    assert.equal((await pedido(mesera1, { accion: 'domicilio', orden: (await llamar('pedidos', 'GET', undefined, mesera1)).datos.ordenes.find((o: any) => o.tipo === 'domicilio').id })).status, 201);
    assert.equal((await llamar('impresion', 'POST', { accion: 'tomar' }, mesera1)).status, 403, 'solo quien cobra atiende la impresora');
    const r = await llamar('impresion', 'POST', { accion: 'tomar' }, enc);
    assert.deepEqual(r.datos.trabajos.map((j: any) => j.tipo), ['comanda', 'comanda', 'comanda', 'precuenta', 'recibo', 'domicilio']);
    assert.match(r.datos.trabajos[0].titulo, /^Comanda #1 · Mesa 2 #001/);
    assert.equal(r.datos.trabajos[0].pidio, 'Ana');
    assert.equal(r.datos.trabajos[0].datos.comanda.lids.length, 2, 'la comanda trae solo lo de ese envío');
    assert.equal(r.datos.trabajos[4].datos.orden.pagos.length, 2, 'el recibo trae los pagos');
    assert.equal((await llamar('impresion', 'POST', { accion: 'tomar' }, enc)).datos.trabajos.length, 0, 'no se imprime dos veces');
    const re = await llamar('impresion', 'POST', { accion: 'reimprimir', id: r.datos.trabajos[3].id }, enc);
    assert.equal(re.datos.trabajos[0].tipo, 'precuenta');
    assert.equal((await llamar('impresion', 'GET', undefined, enc)).datos.trabajos.length, 6);
  });

  test('Almacén del dueño: entra con su precio, sale al stock del día y no se borra', async () => {
    assert.equal((await llamar('almacen', 'GET', undefined, enc)).status, 403, 'la encargada no ve el almacén');
    assert.equal((await llamar('almacen', 'POST', { accion: 'entrada', itemId: ids.c, cantidad: 10 }, enc)).status, 403);
    const e = await llamar('almacen', 'POST', { accion: 'entrada', itemId: ids.c, cantidad: 10, costo: 25000, nota: 'Compra en Makro' }, admin);
    assert.equal(e.status, 201);
    let c = e.datos.items.find((x: any) => x.id === ids.c);
    assert.deepEqual([c.cantidad, c.costo, c.valor], [10, 2500, 25000], 'avalúo: 10 × $2.500');
    assert.equal((await llamar('almacen', 'POST', { accion: 'salida', itemId: ids.c, cantidad: 11 }, admin)).status, 409, 'no sale más de lo que hay');
    const s = await llamar('almacen', 'POST', { accion: 'salida', itemId: ids.c, cantidad: 3, nota: 'para la nevera' }, admin);
    c = s.datos.items.find((x: any) => x.id === ids.c);
    assert.equal(c.cantidad, 7);
    const t = await llamar('turno', 'GET', undefined, enc);
    assert.ok(t.datos.entradas.some((x: any) => x.itemId === ids.c && x.cantidad === 3), 'la salida entra al turno como una llegada');
    assert.equal((await llamar('almacen', 'POST', { accion: 'ajuste', itemId: ids.c, cantidad: 6 }, admin)).status, 400, 'el ajuste pide motivo');
    const a = await llamar('almacen', 'POST', { accion: 'ajuste', itemId: ids.c, cantidad: 6, nota: 'Se dañó una' }, admin);
    assert.equal(a.datos.items.find((x: any) => x.id === ids.c).cantidad, 6);
    const m = await llamar('almacen', 'POST', { accion: 'minimo', itemId: ids.c, minimo: 12 }, admin);
    assert.deepEqual(m.datos.bajos.map((x: any) => x.nombre), ['Coca-Cola'], 'aviso: el almacén está bajo su mínimo');
    assert.deepEqual(m.datos.movimientos.map((x: any) => x.tipo), ['ajuste', 'salida', 'entrada']);
  });

  test('No se cierra la caja con cuentas abiertas; lo vendido va al resumen', async () => {
    const cierre = { bebidas: { [ids.c]: 25 }, utensilios: {}, saldos: { Efectivo: 35000, Nequi: 30000, Bancolombia: 0, 'Datáfono': 0 } };
    const r = await llamar('turno/cerrar-caja', 'POST', cierre, enc);
    assert.equal(r.status, 409, 'el domicilio sigue abierto');
    const dom = (await llamar('pedidos', 'GET', undefined, enc)).datos.ordenes.find((o: any) => o.tipo === 'domicilio');
    // El cliente pagó todo por Nequi y al mensajero se le dieron $3.000 del efectivo de la caja
    const c = await pedido(enc, { accion: 'cobrar', orden: dom.id, total: 7000, pagos: [{ cuenta: 'Nequi', monto: 7000 }] });
    assert.deepEqual([c.datos.estado.saldos.Nequi, c.datos.estado.saldos.Efectivo], [37000, 32000], 'el envío sale solo del efectivo');
    const ok = await llamar('turno/cerrar-caja', 'POST', { ...cierre, saldos: { ...cierre.saldos, Efectivo: 32000, Nequi: 37000 } }, enc);
    assert.equal(ok.status, 201);
    const res = ok.datos.turnos.find((t: any) => t.id === ok.datos.turnoId).resumen;
    assert.equal(res.ventas, 72000);
    assert.equal(res.gastosLista[0].categoria, 'Domiciliario');
    assert.equal(res.ordenesPagadas, 2);
    assert.deepEqual(res.porCategoria, { Hamburguesas: 30000, Pizzas: 31000, Bebidas: 8000, Domicilio: 3000 });
    assert.equal(res.anulaciones, 4, 'dos hamburguesas anuladas y dos cuentas liberadas');
    assert.equal(res.bebidas[0].pos, 2);
    assert.equal(res.bebidas[0].dif, 0, 'salieron 2 Coca-Cola del inventario y se cobraron 2');
    assert.equal(res.bebidas[0].ent, 3, 'las 3 que salieron del almacén cuentan como llegada');
    assert.equal(res.bebidas[0].almacen, 6, 'el resumen dice cuántas hay en el almacén');
  });
});
