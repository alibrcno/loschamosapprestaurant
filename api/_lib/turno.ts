// Turno y caja: lectura del estado, validaciones, libro contable y resumen del día.
// El turno se cierra en dos pasos: la encargada cierra la CAJA y después cocina hace su
// inventario; con ese último paso el turno termina y se calcula el resultado del día.
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { Usuario, puede } from './auth';
import { cantidad } from './catalogo';
import { ErrorApi, pesos, texto } from './http';
import { ventasDelTurno } from './pedidos';

export const AREAS = ['Cocina', 'Salón', 'Caja', 'Domicilios'];
export const CAT_GASTO = ['Compra de inventario', 'Nómina', 'Domiciliario', 'Servicios públicos', 'Arriendo', 'Mantenimiento', 'Otros'];
export const CAT_INGRESO = ['Aporte del dueño', 'Base de caja', 'Préstamo', 'Otros'];
const GRUPO: Record<string, string> = { bebida: 'bebidas', utensilio: 'utensilios', insumo: 'insumos' };
const num = (v: unknown) => Number(v) || 0;

/* ---------------- turno actual ---------------- */
export interface Turno {
  id: string; tenant_id: string; abierto_en: Date; abierto_por: string; caja_cerrada_en: Date | null;
  cerrado_en: Date | null; seq_orden: number; seq_comanda: number;
  apertura: any; cierre: any; cocina_cierre: any; resumen: any;
}

/** Turno sin terminar (caja abierta, o caja cerrada esperando a cocina). */
export async function turnoActual(db: PoolClient, bloquear = false): Promise<Turno | null> {
  const r = await db.query(`SELECT * FROM shifts WHERE cerrado_en IS NULL${bloquear ? ' FOR UPDATE' : ''}`);
  return r.rows[0] || null;
}
export function exigirCajaAbierta(t: Turno | null): Turno {
  if (!t) throw new ErrorApi(409, 'La caja está cerrada. Primero hay que abrirla.');
  if (t.caja_cerrada_en) throw new ErrorApi(409, 'La caja de este turno ya se cerró. Solo falta el inventario de cocina.');
  return t;
}

/* ---------------- cuentas y libro contable ---------------- */
export async function cuentas(db: PoolClient): Promise<{ id: string; nombre: string }[]> {
  return (await db.query('SELECT id, nombre FROM accounts WHERE activo ORDER BY orden, nombre')).rows;
}
export async function cuentaId(db: PoolClient, nombre: unknown): Promise<string> {
  const c = (await cuentas(db)).find((x) => x.nombre === nombre);
  if (!c) throw new ErrorApi(400, 'Esa cuenta no existe');
  return c.id;
}
export async function saldos(db: PoolClient): Promise<Record<string, number>> {
  const r = await db.query('SELECT nombre, saldo FROM account_balances');
  return Object.fromEntries(r.rows.map((x) => [x.nombre, num(x.saldo)]));
}

/** Agrega un movimiento al libro contable (nunca se edita ni se borra). */
export async function registrar(
  db: PoolClient, u: Usuario,
  m: { shiftId: string | null; cuentaId: string; tipo: string; monto: number; concepto: string; categoria?: string; refId?: string | null; grupoId?: string | null }
) {
  if (!m.monto) return;
  await db.query(
    `INSERT INTO ledger_entries (tenant_id, shift_id, account_id, tipo, monto, concepto, categoria, ref_id, grupo_id, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [u.tenant_id, m.shiftId, m.cuentaId, m.tipo, m.monto, m.concepto, m.categoria || null, m.refId || null, m.grupoId || null, u.id]
  );
}
export const nuevoGrupo = () => randomUUID();

/** Saldos contados de todas las cuentas: pesos enteros, ninguno negativo. */
export async function leerSaldos(db: PoolClient, v: unknown): Promise<Record<string, number>> {
  if (!v || typeof v !== 'object') throw new ErrorApi(400, 'Faltan los saldos de las cuentas');
  const o = v as Record<string, unknown>;
  return Object.fromEntries((await cuentas(db)).map((c) => [c.nombre, pesos(o[c.nombre], `El saldo de ${c.nombre}`)]));
}

/* ---------------- inventario ---------------- */
export async function itemsDe(db: PoolClient, tipo: 'bebida' | 'utensilio' | 'insumo') {
  return (await db.query('SELECT id, nombre, stock FROM inventory_items WHERE activo AND tipo = $1 ORDER BY nombre', [tipo])).rows as { id: string; nombre: string; stock: number }[];
}

/** Conteo ciego: debe traer TODOS los ítems del grupo, con cantidades de 0 en adelante. */
export function leerConteo(v: unknown, items: { id: string; nombre: string }[], que: string): Record<string, number> {
  if (!v || typeof v !== 'object') throw new ErrorApi(400, `Falta el conteo de ${que}`);
  const o = v as Record<string, unknown>;
  const ids = new Set(items.map((i) => i.id));
  const sobra = Object.keys(o).find((k) => !ids.has(k));
  if (sobra) throw new ErrorApi(409, `El conteo de ${que} tiene productos que ya no existen. Recarga la página y cuenta de nuevo.`);
  const falta = items.find((i) => o[i.id] === undefined || o[i.id] === null || o[i.id] === '');
  if (falta) throw new ErrorApi(409, `Falta contar "${falta.nombre}". Recarga la página si es un producto nuevo.`);
  return Object.fromEntries(items.map((i) => [i.id, cantidad(o[i.id], `El conteo de ${i.nombre}`)]));
}

/** Guarda un conteo (queda el valor del sistema y el contado) y deja el stock en lo contado. */
export async function guardarConteo(db: PoolClient, u: Usuario, shiftId: string, momento: string, items: { id: string; stock: number }[], conteo: Record<string, number>) {
  for (const it of items) {
    await db.query(
      `INSERT INTO inventory_counts (tenant_id, shift_id, momento, item_id, sistema, contado, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (shift_id, momento, item_id) DO UPDATE SET sistema = EXCLUDED.sistema, contado = EXCLUDED.contado, user_id = EXCLUDED.user_id, creado_en = now()`,
      [u.tenant_id, shiftId, momento, it.id, num(it.stock), conteo[it.id], u.id]
    );
    await db.query('UPDATE inventory_items SET stock = $2 WHERE id = $1', [it.id, conteo[it.id]]);
  }
}

/* ---------------- resumen del día (igual que LC.resumenTurno en public/store.js) ---------------- */
export async function calcularResumen(db: PoolClient, t: Turno) {
  const movs = (await db.query(
    `SELECT l.tipo, a.nombre AS cuenta, l.monto, l.concepto, l.categoria FROM ledger_entries l
     JOIN accounts a ON a.id = l.account_id WHERE l.shift_id = $1 ORDER BY l.creado_en`, [t.id])).rows;
  const ventasCuenta: Record<string, number> = Object.fromEntries((await cuentas(db)).map((c) => [c.nombre, 0]));
  let ventas = 0, gastos = 0, gastosOp = 0, compras = 0, ingresos = 0;
  const gastosLista: { concepto: string; cuenta: string; valor: number; categoria: string }[] = [];
  for (const m of movs) {
    if (m.tipo === 'venta') { ventasCuenta[m.cuenta] = (ventasCuenta[m.cuenta] || 0) + m.monto; ventas += m.monto; }
    else if (m.tipo === 'gasto') {
      const v = -m.monto; gastos += v;
      if (m.categoria === 'Compra de inventario') compras += v; else gastosOp += v;
      gastosLista.push({ concepto: m.concepto, cuenta: m.cuenta, valor: v, categoria: m.categoria || '' });
    } else if (m.tipo === 'ingreso') ingresos += m.monto;
  }

  // Detalle de lo vendido (productos, categorías, bebidas): sale de las cuentas cobradas en el servidor.
  // Los turnos de antes de la parte 4 lo traen en el cierre (ventasPOS), porque los pedidos vivían en la caja.
  const pos: any = (t.cierre && t.cierre.ventasPOS) || await ventasDelTurno(db, t.id);
  const ordenesPagadas = num(pos.ordenesPagadas);

  const items = (await db.query('SELECT id, tipo, nombre, unidad, precio, costo, sugerido FROM inventory_items WHERE activo ORDER BY nombre')).rows;
  const ent: Record<string, number> = Object.fromEntries((await db.query(
    `SELECT item_id, sum(cantidad) AS n FROM inventory_entries WHERE shift_id = $1 AND motivo = 'llegada' GROUP BY item_id`, [t.id]
  )).rows.map((x) => [x.item_id, num(x.n)]));
  const ap = t.apertura || {}, ci = t.cierre || null;
  const co = t.cocina_cierre && !t.cocina_cierre.sinInventario ? t.cocina_cierre : null;

  const inv = (tipo: string, iniMap: any, finMap: any, posMap: any) =>
    items.filter((it) => it.tipo === tipo).map((it) => {
      const ini = num(iniMap[it.id]), e = num(ent[it.id]);
      const fin = finMap ? num(finMap[it.id]) : null;
      const consumo = fin === null ? null : ini + e - fin;
      const row: any = {
        id: it.id, nombre: it.nombre, unidad: it.unidad, ini, ent: e, fin, consumo,
        costo: consumo === null ? 0 : Math.max(0, consumo) * num(it.costo),
        sugerido: num(it.sugerido), comprar: fin === null ? null : Math.max(0, num(it.sugerido) - fin)
      };
      if (tipo === 'bebida') {
        row.precio = num(it.precio); row.pos = num(posMap[it.id]);
        row.valor = consumo === null ? 0 : consumo * row.precio;
        row.dif = consumo === null ? null : consumo - row.pos;
      }
      return row;
    });
  const bebidas = inv('bebida', ap.bebidas || {}, ci && ci.bebidas, pos.bebidas || {});
  const utensilios = inv('utensilio', ap.utensilios || {}, ci && ci.utensilios, {});
  const insumos = inv('insumo', ap.insumos || {}, co && co.conteo, {});
  const sum = (arr: any[], k: string) => arr.reduce((a, r) => a + (r[k] || 0), 0);
  const costoBebidas = sum(bebidas, 'costo'), costoUtensilios = sum(utensilios, 'costo'), costoInsumos = sum(insumos, 'costo');
  const costoConsumo = costoBebidas + costoUtensilios + costoInsumos;
  const personal = (await db.query('SELECT user_id AS id, nombre, area FROM shift_staff WHERE shift_id = $1 ORDER BY nombre', [t.id])).rows;

  return {
    ventas, ventasCuenta, gastos, gastosOp, compras, ingresos, gastosLista,
    ordenesPagadas, ticketProm: ordenesPagadas ? ventas / ordenesPagadas : 0,
    porCategoria: pos.porCategoria || {}, productos: pos.productos || [], anulaciones: num(pos.anulaciones),
    bebidas, utensilios, insumos, ventaBebidasConteo: sum(bebidas, 'valor'),
    costoBebidas, costoUtensilios, costoInsumos, costoConsumo, cocinaCerrada: !!co,
    utilidad: ventas - costoConsumo - gastosOp, flujo: ventas + ingresos - gastos,
    descuadre: (ci && ci.descuadre) || null, personal
  };
}

/** Guarda el resumen; si la caja ya cerró y cocina ya contó (o se cerró sin cocina), el turno termina. */
export async function actualizarTurno(db: PoolClient, u: Usuario, id: string) {
  const t = (await db.query('SELECT * FROM shifts WHERE id = $1', [id])).rows[0] as Turno;
  const termina = !!t.caja_cerrada_en && !!t.cocina_cierre && !t.cerrado_en;
  if (termina) await db.query('UPDATE shifts SET cerrado_en = now(), cerrado_por = $2 WHERE id = $1', [id, u.id]);
  await db.query('UPDATE shifts SET resumen = $2 WHERE id = $1', [id, JSON.stringify(await calcularResumen(db, t))]);
  return termina;
}

/* ---------------- estado para la app (misma forma que LC.db en public/store.js) ---------------- */
export async function leerEstado(db: PoolClient, u: Usuario) {
  const dinero = puede(u, 'reportes.ver') || puede(u, 'turno.operar') || puede(u, 'caja.movimientos');
  const nombres: Record<string, string> = Object.fromEntries((await db.query('SELECT id, nombre FROM users')).rows.map((x) => [x.id, x.nombre]));
  const actual = await turnoActual(db);
  const filas: Turno[] = actual ? [actual] : [];
  if (puede(u, 'reportes.ver')) {
    filas.unshift(...(await db.query(
      `SELECT * FROM shifts WHERE cerrado_en IS NOT NULL AND dia >= (dia_colombia(now()) - 62) ORDER BY abierto_en`
    )).rows);
  }
  const staff = filas.length ? (await db.query('SELECT shift_id, user_id AS id, nombre, area FROM shift_staff WHERE shift_id = ANY($1)', [filas.map((t) => t.id)])).rows : [];

  const turnos = filas.map((t) => {
    const ap = t.apertura ? { ...t.apertura } : {};
    if (!dinero) { delete ap.saldosContados; delete ap.saldosSistema; }
    return {
      id: t.id, abiertoEn: t.abierto_en, abiertoPor: nombres[t.abierto_por] || '', estado: t.cerrado_en ? 'cerrado' : 'abierto',
      cajaCerrada: !!t.caja_cerrada_en, cajaCerradaEn: t.caja_cerrada_en, cerradoEn: t.cerrado_en,
      personal: staff.filter((s) => s.shift_id === t.id).map(({ id, nombre, area }) => ({ id, nombre, area })),
      seqOrden: t.seq_orden, seqComanda: t.seq_comanda, apertura: ap,
      cierre: dinero ? t.cierre : t.cierre ? { en: t.cierre.en, por: t.cierre.por } : null,
      cocina: { cierre: t.cocina_cierre }, resumen: dinero ? t.resumen : null
    };
  });

  const movimientos = dinero ? (await db.query(
    `SELECT l.id, l.creado_en AS fecha, l.shift_id AS "turnoId", l.tipo, a.nombre AS cuenta, l.monto, l.concepto,
            coalesce(l.categoria, '') AS categoria, l.ref_id AS ref, coalesce(u.nombre, 'sistema') AS usuario
     FROM ledger_entries l JOIN accounts a ON a.id = l.account_id LEFT JOIN users u ON u.id = l.user_id
     WHERE l.shift_id = $1 OR l.id IN (SELECT id FROM ledger_entries ORDER BY creado_en DESC LIMIT 300)
     ORDER BY l.creado_en`, [actual ? actual.id : null])).rows : [];

  const entradas = actual ? (await db.query(
    `SELECT e.id, e.creado_en AS fecha, e.shift_id AS "turnoId", i.tipo, e.item_id AS "itemId", i.nombre, i.unidad, e.cantidad,
            e.costo_total AS costo, a.nombre AS cuenta, coalesce(e.nota, '') AS nota, coalesce(u.nombre, '') AS usuario
     FROM inventory_entries e JOIN inventory_items i ON i.id = e.item_id LEFT JOIN accounts a ON a.id = e.account_id
     LEFT JOIN users u ON u.id = e.user_id WHERE e.shift_id = $1 AND e.motivo = 'llegada' ORDER BY e.creado_en`, [actual.id]
  )).rows.map((e) => ({ ...e, tipo: GRUPO[e.tipo], costo: dinero ? e.costo : 0, cuenta: dinero ? e.cuenta : null })) : [];

  return {
    turnos, turnoActualId: actual ? actual.id : null, movimientos, entradas,
    saldos: dinero ? await saldos(db) : {}, cuentas: (await cuentas(db)).map((c) => c.nombre)
  };
}

export const leerObs = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const leerTexto = texto;
