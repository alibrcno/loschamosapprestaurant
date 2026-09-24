// Pruebas de componentes de la app (public/store.js) sin navegador ni base de datos: se carga el
// archivo tal cual en un entorno aislado y se prueban sus piezas una por una (formatos, horas de
// Colombia, resumen del turno, compras sugeridas, pedidos con borradores y estados del turno).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import vm from 'node:vm';

/** Carga public/store.js en un "navegador" de mentira y devuelve su LC. */
function cargarApp(): any {
  const guardado = new Map<string, string>();
  const ventana: any = {
    localStorage: { getItem: (k: string) => guardado.get(k) ?? null, setItem: (k: string, v: string) => guardado.set(k, v), removeItem: (k: string) => guardado.delete(k) },
    alert: () => {}, console, Intl, Date, Math, JSON, Object, Array, String, Number, isFinite, parseFloat, parseInt, crypto: globalThis.crypto
  };
  ventana.window = ventana;
  vm.createContext(ventana);
  vm.runInContext(readFileSync(join(__dirname, '..', '..', 'public', 'store.js'), 'utf8'), ventana);
  return ventana.LC;
}
// Los objetos creados dentro del entorno aislado se comparan por su contenido
const plano = (x: unknown) => JSON.parse(JSON.stringify(x));

describe('Componentes: formatos de Colombia', () => {
  const LC = cargarApp();
  test('Pesos sin decimales y con punto de miles', () => {
    assert.equal(LC.fmt(50000), '$50.000');
    assert.equal(LC.fmt(-7200), '-$7.200');
    assert.equal(LC.fmt(1234.6), '$1.235');
    assert.equal(LC.fmt(undefined), '$0');
  });
  test('Cantidades con coma decimal y números escritos con coma', () => {
    assert.equal(LC.q(1.5), '1,5');
    assert.equal(LC.num('2,75'), 2.75);
    assert.equal(LC.num('abc'), 0);
  });
  test('Horas y días siempre en hora de Colombia, sin importar la zona del equipo', () => {
    // 04:30 UTC del 23 = 11:30 p. m. del 22 en Colombia
    assert.match(LC.hora('2026-09-23T04:30:00Z'), /^11:30\s?p/);
    assert.equal(LC.diaLocal(new Date('2026-09-23T04:59:00Z')), '2026-09-22');
    assert.equal(LC.diaLocal(new Date('2026-09-23T05:00:00Z')), '2026-09-23');
    assert.equal(LC.diaSemana('2026-09-22T21:00:00Z'), 2, 'el martes 22 de septiembre');
  });
  test('El domicilio vale $6.000 si el negocio no ha puesto otro valor', () => {
    LC.db.config.valorDomicilio = 0;
    assert.equal(LC.valorDomicilio(), 6000);
    LC.db.config.valorDomicilio = 7000;
    assert.equal(LC.valorDomicilio(), 7000);
  });
  test('Todo texto que va a la pantalla se escapa (un nombre con comillas no rompe nada)', () => {
    assert.equal(LC.esc(`<b>"Ana" & 'Luz'</b>`), '&lt;b&gt;&quot;Ana&quot; &amp; &#39;Luz&#39;&lt;/b&gt;');
  });
});

describe('Componentes: estados del turno', () => {
  const LC = cargarApp();
  const t = { id: 't1', estado: 'abierto', cajaAbierta: false, cajaCerrada: false };
  test('Cocina abrió y la caja todavía no: no se vende', () => {
    LC.db.turnos = [t]; LC.db.turnoActualId = 't1';
    assert.equal(LC.turno(), null);
    assert.equal(LC.soloCocina(), true);
    assert.ok(LC.turnoCocina());
  });
  test('Caja abierta: se vende', () => {
    t.cajaAbierta = true;
    assert.equal(LC.turno().id, 't1');
    assert.equal(LC.soloCocina(), false);
  });
  test('Caja cerrada esperando a cocina: no se vende, pero el turno sigue', () => {
    t.cajaCerrada = true;
    assert.equal(LC.turno(), null);
    assert.equal(LC.esperandoCocina(), true);
  });
});

describe('Componentes: resumen del turno (igual al del servidor)', () => {
  const LC = cargarApp();
  const db = LC.db;
  db.bebidas = [{ id: 'coca', nombre: 'Coca-Cola', unidad: 'und', precio: 4000, costo: 2600, sugerido: 24 }];
  db.utensilios = [{ id: 'serv', nombre: 'Servilletas', unidad: 'paquete', costo: 3500, sugerido: 10 }];
  db.insumos = [{ id: 'queso', nombre: 'Queso', unidad: 'kg', costo: 20000, sugerido: 5 }, { id: 'tomate', nombre: 'Tomate', unidad: 'kg', costo: 4000, sugerido: 2 }];
  db.config.preparaciones = [{ nombre: 'Salsa de pizza', materiales: [{ itemId: 'tomate', cantidad: 3 }] }];
  db.entradas = [{ turnoId: 't1', tipo: 'insumos', itemId: 'queso', cantidad: 2 }];
  db.movimientos = [
    { turnoId: 't1', tipo: 'venta', cuenta: 'Efectivo', monto: 30000 }, { turnoId: 't1', tipo: 'venta', cuenta: 'Nequi', monto: 20000 },
    { turnoId: 't1', tipo: 'gasto', cuenta: 'Efectivo', monto: -5000, concepto: 'Gas', categoria: 'Otros' },
    { turnoId: 't1', tipo: 'gasto', cuenta: 'Efectivo', monto: -40000, concepto: 'Queso', categoria: 'Compra de inventario' }
  ];
  db.ordenes = [{ turnoId: 't1', estado: 'pagada', lineas: [
    { nombre: 'Pizza', categoria: 'Pizzas', precio: 42000, qty: 1 }, { nombre: 'Coca-Cola', categoria: 'Bebidas', precio: 4000, qty: 2, bebidaId: 'coca' },
    { nombre: 'Malta', categoria: 'Bebidas', precio: 3500, qty: 1, anulada: { motivo: 'x' } }
  ] }];
  const turno = {
    id: 't1', personal: [],
    apertura: { bebidas: { coca: 10 }, utensilios: { serv: 5 }, insumos: { queso: 1, tomate: 2 } },
    cierre: { bebidas: { coca: 8 }, utensilios: { serv: 4 }, saldosContados: { Efectivo: 85000, Nequi: 20000, Bancolombia: 0, 'Datáfono': 0 } },
    cocina: { cierre: { conteo: { queso: 1.5, tomate: 1 }, preparar: ['Salsa de pizza'] } }
  };
  const r = LC.resumenTurno(turno);

  test('Ventas por cuenta y por categoría (lo anulado no cuenta)', () => {
    assert.equal(r.ventas, 50000);
    assert.deepEqual(plano(r.porCategoria), { Pizzas: 42000, Bebidas: 8000 });
    assert.equal(r.anulaciones, 1);
  });
  test('Costo de lo consumido y utilidad: la compra de queso no se resta dos veces', () => {
    // Coca 2 × 2.600 + servilletas 1 × 3.500 + queso (1 + 2 − 1,5) × 20.000 + tomate 1 × 4.000
    assert.equal(r.costoConsumo, 5200 + 3500 + 30000 + 4000);
    assert.equal(r.gastosOp, 5000);
    assert.equal(r.compras, 40000);
    assert.equal(r.utilidad, 50000 - 42700 - 5000);
  });
  test('Bebidas vendidas y cuánto apartar para reponerlas', () => {
    assert.equal(r.bebidasVendidas, 2);
    assert.equal(r.apartarBebidas, 5200);
    assert.equal(r.bebidas[0].dif, 0, 'el conteo coincide con lo cobrado');
  });
  test('Compras sugeridas: el stock sugerido más lo que pide la preparación marcada', () => {
    const tomate = r.insumos.find((x: any) => x.id === 'tomate');
    assert.equal(tomate.comprar, 4, 'sugerido 2 + 3 para la salsa − 1 que queda');
    assert.equal(r.insumos.find((x: any) => x.id === 'queso').comprar, 3.5);
    assert.equal(r.bebidas[0].comprar, 16);
  });
  test('Lo que quedó al cierre, a precio de costo, y el dinero contado', () => {
    assert.deepEqual(plano(r.inventarioCierre), { bebidas: 8 * 2600, utensilios: 4 * 3500, cocina: 1.5 * 20000 + 4000 });
    assert.equal(r.dineroCierre, 105000);
  });
});

describe('Componentes: pedidos con borradores en el celular', () => {
  const LC = cargarApp();
  LC.user = { nombre: 'Ana', rol: 'mesera', permisos: [] };
  LC.db.turnos = [{ id: 't1', estado: 'abierto', cajaAbierta: true }]; LC.db.turnoActualId = 't1';
  const orden = (extra: object) => Object.assign({ turnoId: 't1', estado: 'abierta', tipo: 'mesa', lineas: [], comandas: [], pagos: [] }, extra);

  test('Una cuenta nueva vive solo en este equipo hasta enviarla', () => {
    const id = LC.nuevaCuenta({ tipo: 'mesa', mesa: 5 });
    LC.db.borradores[id].lineas.push({ lid: 'a', nombre: 'Malta', precio: 3500, qty: 1, borrador: true });
    LC.armarPedidos();
    const o = LC.db.ordenes.find((x: any) => x.id === id);
    assert.equal(o.local, true);
    assert.equal(LC.totalOrden(o), 3500);
  });
  test('Si otra mesera ya abrió esa mesa, lo que llevo se suma a su cuenta', () => {
    LC.recibirOrden(orden({ id: 'srv5', mesa: 5, lineas: [{ lid: 's1', nombre: 'Agua', precio: 3000, qty: 1 }] }));
    const o = LC.db.ordenes.filter((x: any) => x.mesa === 5);
    assert.equal(o.length, 1, 'una sola cuenta en la mesa 5');
    assert.equal(o[0].id, 'srv5');
    assert.deepEqual(o[0].lineas.map((l: any) => l.nombre), ['Agua', 'Malta']);
    assert.equal(Object.values(LC.alias)[0], 'srv5', 'la pantalla abierta con el id viejo encuentra la cuenta');
  });
  test('Si la cuenta se cobró en otro equipo, el borrador se descarta', () => {
    LC.recibirOrden(orden({ id: 'srv5', mesa: 5, estado: 'pagada', lineas: [] }));
    assert.equal(LC.db.borradores.srv5, undefined);
  });
  test('Un borrador de un turno anterior no aparece', () => {
    LC.db.borradores.viejo = { turnoId: 't0', nueva: { tipo: 'mesa', mesa: 9 }, lineas: [{ lid: 'x', nombre: 'X', precio: 1, qty: 1 }] };
    LC.armarPedidos();
    assert.equal(LC.db.ordenes.some((o: any) => o.mesa === 9), false);
    assert.equal(LC.db.borradores.viejo, undefined);
  });
});
