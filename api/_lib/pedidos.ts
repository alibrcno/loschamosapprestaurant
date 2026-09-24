// Pedidos (órdenes), comandas de cocina, cobro y cola de impresión.
// Las meseras arman el pedido en su celular y lo envían todo junto; aquí se guarda con los
// precios del MENÚ DEL SERVIDOR (nunca con el precio que diga el celular).
import type { PoolClient } from 'pg';
import { Permiso, Usuario, puede } from './auth';
import { TAMANOS } from './catalogo';
import { esUuid } from './db';
import { ErrorApi, pesos, texto } from './http';
import type { Turno } from './turno';

const num = (v: unknown) => Number(v) || 0;
const pad3 = (n: number) => String(n || 0).padStart(3, '0');
export const tituloOrden = (o: { tipo: string; mesa: number | null; cliente: string | null }) =>
  o.tipo === 'mesa' ? `Mesa ${o.mesa}` : `Domicilio ${o.cliente}`;

/** Exige al menos uno de los permisos (conUsuario solo revisa uno). */
export function exigir(u: Usuario, ...permisos: Permiso[]) {
  if (!permisos.some((p) => puede(u, p))) throw new ErrorApi(403, 'Tu usuario no tiene permiso para esto. Pídeselo al administrador.');
}

/* ---------------- lectura: misma forma que LC.db.ordenes en public/store.js ---------------- */
export async function leerOrdenes(db: PoolClient, u: Usuario, shiftId: string, filtro: { desde?: Date | null; ids?: string[] } = {}) {
  const cond: string[] = ['o.shift_id = $1'];
  const args: unknown[] = [shiftId];
  if (filtro.desde) { args.push(filtro.desde); cond.push(`o.actualizado_en >= $${args.length}`); }
  if (filtro.ids) { args.push(filtro.ids); cond.push(`o.id = ANY($${args.length})`); }
  const ords = (await db.query(
    `SELECT o.*, m.nombre AS mesero, c.nombre AS cobrador FROM orders o
     LEFT JOIN users m ON m.id = o.mesero_id LEFT JOIN users c ON c.id = o.cobrado_por
     WHERE ${cond.join(' AND ')} ORDER BY o.creado_en`, args)).rows;
  if (!ords.length) return [];
  const ids = ords.map((o) => o.id);
  const [items, tickets, pagos] = await Promise.all([
    db.query(
      `SELECT i.*, a.nombre AS agrego, x.nombre AS anulo FROM order_items i
       LEFT JOIN users a ON a.id = i.agregado_por LEFT JOIN users x ON x.id = i.anulada_por
       WHERE i.order_id = ANY($1) ORDER BY i.creado_en, i.id`, [ids]),
    db.query(
      `SELECT k.*, u.nombre AS por FROM kitchen_tickets k LEFT JOIN users u ON u.id = k.user_id
       WHERE k.order_id = ANY($1) ORDER BY k.numero`, [ids]),
    // Cómo pagó cada cuenta: solo lo ve quien maneja la caja o los reportes
    puede(u, 'pos.cobrar') || puede(u, 'turno.operar') || puede(u, 'reportes.ver')
      ? db.query('SELECT p.order_id, a.nombre AS cuenta, p.monto FROM payments p JOIN accounts a ON a.id = p.account_id WHERE p.order_id = ANY($1) ORDER BY a.orden', [ids])
      : Promise.resolve({ rows: [] as any[] })
  ]);
  const numTicket: Record<string, number> = Object.fromEntries(tickets.rows.map((k) => [k.id, k.numero]));
  return ords.map((o) => ({
    id: o.id, turnoId: o.shift_id, numero: o.numero, tipo: o.tipo, mesa: o.mesa,
    cliente: o.cliente, telefono: o.telefono, direccion: o.direccion, nota: o.nota,
    estado: o.estado, creadaEn: o.creado_en, cerradaEn: o.cerrado_en, mesero: o.mesero || '',
    precuentaEn: o.precuenta_en, pagoCliente: o.pago_cliente || null, cobradoPor: o.cobrador || null, recibido: num(o.recibido), cambio: num(o.cambio),
    actualizadoEn: o.actualizado_en,
    lineas: items.rows.filter((l) => l.order_id === o.id).map((l) => ({
      lid: l.id, pid: l.product_id, bebidaId: l.inventory_item_id, nombre: l.nombre, categoria: l.categoria || '',
      detalle: l.detalle || '', obs: l.obs || '', precio: num(l.precio), qty: l.qty, sinCocina: l.sin_cocina,
      comanda: l.ticket_id ? numTicket[l.ticket_id] : null, por: l.agrego || '', en: l.creado_en,
      anulada: l.anulada ? { por: l.anulo || '', motivo: l.anulada_motivo, en: l.anulada_en } : null
    })),
    comandas: tickets.rows.filter((k) => k.order_id === o.id).map((k) => ({
      id: k.id, num: k.numero, en: k.creado_en, estado: k.estado, por: k.por || '', nota: k.nota || '', listoEn: k.listo_en, entregadoEn: k.entregado_en,
      lids: items.rows.filter((l) => l.ticket_id === k.id).map((l) => l.id)
    })),
    pagos: pagos.rows.filter((p) => p.order_id === o.id).map((p) => ({ cuenta: p.cuenta, monto: num(p.monto) }))
  }));
}
export type Orden = Awaited<ReturnType<typeof leerOrdenes>>[number];
export const totalOrden = (o: Orden) => o.lineas.filter((l) => !l.anulada).reduce((a, l) => a + l.precio * l.qty, 0);
/** Valor del envío de un domicilio (lo que se le paga al mensajero). */
export const envioOrden = (o: Orden) => o.lineas.filter((l) => !l.anulada && l.categoria === 'Domicilio').reduce((a, l) => a + l.precio * l.qty, 0);

/** La cuenta, bloqueada para cambiarla. Debe ser del turno actual y seguir abierta. */
export async function ordenAbierta(db: PoolClient, t: Turno, id: unknown) {
  if (!esUuid(id)) throw new ErrorApi(400, 'Falta la cuenta');
  const o = (await db.query('SELECT * FROM orders WHERE id = $1 AND shift_id = $2 FOR UPDATE', [id, t.id])).rows[0];
  if (!o) throw new ErrorApi(404, 'Esa cuenta no existe en este turno');
  if (o.estado !== 'abierta') throw new ErrorApi(409, o.estado === 'pagada' ? 'Esa cuenta ya se cobró' : 'Esa cuenta ya se cerró');
  return o;
}
export const tocar = (db: PoolClient, orderId: string) => db.query('UPDATE orders SET actualizado_en = now() WHERE id = $1', [orderId]);
/** Al cobrar o cerrar una cuenta sus comandas salen de la pantalla de cocina, aunque cocina no las haya marcado. */
export const entregarComandas = (db: PoolClient, orderId: string) => db.query(
  `UPDATE kitchen_tickets SET estado = 'entregado', entregado_en = now(), listo_en = coalesce(listo_en, now())
   WHERE order_id = $1 AND estado <> 'entregado'`, [orderId]);

/* ---------------- productos que manda la mesera: se validan contra el menú ---------------- */
export interface LineaNueva {
  productId: string | null; itemId: string | null; nombre: string; categoria: string; detalle: string; obs: string;
  precio: number; qty: number; sinCocina: boolean;
}
function cantidadEntera(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 99) throw new ErrorApi(400, 'La cantidad debe ser un número entero entre 1 y 99');
  return v;
}
const obsDe = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 120) : '');

export async function leerLineas(db: PoolClient, v: unknown, tipoOrden: string): Promise<LineaNueva[]> {
  if (!Array.isArray(v) || !v.length) throw new ErrorApi(400, 'El pedido no tiene productos');
  if (v.length > 60) throw new ErrorApi(400, 'Demasiados productos en un solo envío');
  const r: LineaNueva[] = [];
  for (const x of v as Record<string, any>[]) {
    if (!x || typeof x !== 'object') throw new ErrorApi(400, 'Producto no válido');
    const qty = cantidadEntera(x.qty), obs = obsDe(x.obs);
    if (x.tipo === 'producto') {
      const p = esUuid(x.id) ? (await db.query(
        `SELECT p.id, p.nombre, p.precio, p.sin_cocina, c.nombre AS categoria, c.extras FROM products p
         LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = $1 AND p.activo`, [x.id])).rows[0] : null;
      if (!p) throw new ErrorApi(409, 'Un producto del pedido ya no está en el menú. Recarga y vuelve a agregarlo.');
      // Extras de la categoría (queso extra, tocineta…): el precio sale del menú del servidor
      const pedidos = x.extras === undefined ? [] : x.extras;
      if (!Array.isArray(pedidos) || pedidos.length > 30) throw new ErrorApi(400, 'Los extras no son válidos');
      const extras = [...new Set(pedidos as unknown[])].map((nom) => {
        const e = ((p.extras || []) as { nombre: string; precio: number }[]).find((y) => y.nombre === nom);
        if (!e) throw new ErrorApi(409, `El extra "${String(nom)}" ya no está en el menú. Recarga y vuelve a agregarlo.`);
        return e;
      });
      r.push({
        productId: p.id, itemId: null, nombre: p.nombre, categoria: p.categoria || 'Otros', obs, qty, sinCocina: p.sin_cocina,
        detalle: extras.length ? 'Con ' + extras.map((e) => e.nombre).join(', ') : '',
        precio: num(p.precio) + extras.reduce((a, e) => a + num(e.precio), 0)
      });
    } else if (x.tipo === 'bebida') {
      const b = esUuid(x.id) ? (await db.query(`SELECT id, nombre, precio FROM inventory_items WHERE id = $1 AND tipo = 'bebida' AND activo`, [x.id])).rows[0] : null;
      if (!b || b.precio === null) throw new ErrorApi(409, 'Una bebida del pedido ya no está a la venta. Recarga y vuelve a agregarla.');
      r.push({ productId: null, itemId: b.id, nombre: b.nombre, categoria: 'Bebidas', detalle: '', obs, precio: num(b.precio), qty, sinCocina: true });
    } else if (x.tipo === 'pizza') {
      const tp = esUuid(x.id) ? (await db.query('SELECT * FROM pizza_types WHERE id = $1 AND activo', [x.id])).rows[0] : null;
      if (!tp) throw new ErrorApi(409, 'Ese tipo de pizza ya no está en el menú. Recarga y vuelve a armarla.');
      const tam = x.tamano;
      if (!TAMANOS.includes(tam) || !(num(tp.precios[tam]) > 0)) throw new ErrorApi(400, `La ${tp.nombre} no se vende en ese tamaño`);
      if (!Array.isArray(x.sabores) || !x.sabores.length) throw new ErrorApi(400, 'Elige al menos un sabor');
      const sab = [...new Set(x.sabores as unknown[])];
      if (sab.some((s) => typeof s !== 'string' || !tp.sabores.includes(s))) throw new ErrorApi(409, `Un sabor ya no está en la ${tp.nombre}. Recarga y vuelve a armarla.`);
      const extras = Math.max(0, sab.length - num(tp.gratis));
      r.push({
        productId: null, itemId: null, nombre: `${tp.nombre} ${tam}`, categoria: 'Pizzas', obs, qty, sinCocina: false,
        detalle: sab.join(', ') + (extras ? ` (${extras} adicional${extras > 1 ? 'es' : ''})` : ''),
        precio: num(tp.precios[tam]) + extras * num(tp.extra[tam])
      });
    } else if (x.tipo === 'domicilio') {
      if (tipoOrden !== 'domicilio') throw new ErrorApi(400, 'El valor del domicilio solo va en un domicilio');
      r.push({ productId: null, itemId: null, nombre: 'Servicio de domicilio', categoria: 'Domicilio', detalle: '', obs: '', precio: pesos(x.monto, 'El valor del domicilio', { min: 1 }), qty: 1, sinCocina: true });
    } else throw new ErrorApi(400, 'Producto no válido');
  }
  return r;
}

/** Datos de una cuenta nueva: mesa, o domicilio con cliente y dirección. */
export function leerNueva(v: unknown, mesas: number, cuentas: string[] = []) {
  const n = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  if (n.tipo === 'mesa') {
    const mesa = n.mesa;
    if (typeof mesa !== 'number' || !Number.isInteger(mesa) || mesa < 1 || mesa > mesas) throw new ErrorApi(400, 'Esa mesa no existe');
    return { tipo: 'mesa', mesa, cliente: null, telefono: null, direccion: null, nota: null, pagoCliente: null };
  }
  if (n.tipo === 'domicilio') {
    const opc = (x: unknown, max: number) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, max) : null);
    return {
      tipo: 'domicilio', mesa: null, cliente: texto(n.cliente, 'el nombre del cliente', { max: 80 }),
      telefono: opc(n.telefono, 30), direccion: texto(n.direccion, 'la dirección', { max: 160 }), nota: opc(n.nota, 200),
      pagoCliente: (() => { if (!cuentas.includes(n.pagoCliente as string)) throw new ErrorApi(400, 'Indica cómo va a pagar el cliente'); return n.pagoCliente as string; })()
    };
  }
  throw new ErrorApi(400, 'Falta la mesa o los datos del domicilio');
}

/** Siguiente número del turno (orden o comanda). El turno ya está bloqueado, no hay choques. */
export async function siguiente(db: PoolClient, shiftId: string, campo: 'seq_orden' | 'seq_comanda'): Promise<number> {
  return (await db.query(`UPDATE shifts SET ${campo} = ${campo} + 1 WHERE id = $1 RETURNING ${campo} AS n`, [shiftId])).rows[0].n;
}

/* ---------------- cola de impresión (la imprime el PC de caja) ---------------- */
export async function encolar(db: PoolClient, u: Usuario, o: Orden, tipo: 'comanda' | 'precuenta' | 'recibo' | 'domicilio', comandaNum?: number) {
  const titulos = { comanda: `Comanda #${comandaNum}`, precuenta: 'Pre-cuenta', recibo: 'Recibo de pago', domicilio: 'Datos del domicilio' };
  const datos = { orden: o, comanda: comandaNum ? o.comandas.find((c) => c.num === comandaNum) : null };
  await db.query(
    `INSERT INTO print_jobs (tenant_id, shift_id, order_id, tipo, titulo, datos, creado_por) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [u.tenant_id, o.turnoId, o.id, tipo, `${titulos[tipo]} · ${tituloOrden(o)}${o.numero ? ` #${pad3(o.numero)}` : ''}`, JSON.stringify(datos), u.id]
  );
}

/** ¿Imprimir la comanda al enviarla a cocina? (Ajustes → Negocio; por defecto sí). */
export async function imprimirComandas(db: PoolClient): Promise<boolean> {
  const c = (await db.query('SELECT config FROM tenants')).rows[0].config || {};
  return c.imprimirComandas !== false;
}
export async function numeroMesas(db: PoolClient): Promise<number> {
  const c = (await db.query('SELECT config FROM tenants')).rows[0].config || {};
  return Math.min(200, Math.max(1, Math.floor(num(c.mesas)) || 8));
}

/* ---------------- lo vendido en el turno (para el resumen del día) ---------------- */
export async function ventasDelTurno(db: PoolClient, shiftId: string) {
  const items = (await db.query(
    `SELECT i.nombre, i.categoria, i.precio, i.qty, i.inventory_item_id FROM order_items i JOIN orders o ON o.id = i.order_id
     WHERE o.shift_id = $1 AND o.estado = 'pagada' AND NOT i.anulada`, [shiftId])).rows;
  const porCategoria: Record<string, number> = {}, bebidas: Record<string, number> = {};
  const productos: Record<string, { nombre: string; qty: number; valor: number }> = {};
  for (const l of items) {
    const v = num(l.precio) * l.qty, cat = l.categoria || 'Otros';
    porCategoria[cat] = (porCategoria[cat] || 0) + v;
    const p = (productos[l.nombre] = productos[l.nombre] || { nombre: l.nombre, qty: 0, valor: 0 });
    p.qty += l.qty; p.valor += v;
    if (l.inventory_item_id) bebidas[l.inventory_item_id] = (bebidas[l.inventory_item_id] || 0) + l.qty;
  }
  const c = (await db.query(
    `SELECT (SELECT count(*) FROM orders WHERE shift_id = $1 AND estado = 'pagada') AS pagadas,
            (SELECT count(*) FROM orders WHERE shift_id = $1 AND estado = 'anulada')
          + (SELECT count(*) FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.shift_id = $1 AND i.anulada) AS anulaciones`, [shiftId])).rows[0];
  return {
    productos: Object.values(productos).sort((a, b) => b.valor - a.valor), porCategoria, bebidas,
    ordenesPagadas: num(c.pagadas), anulaciones: num(c.anulaciones)
  };
}
