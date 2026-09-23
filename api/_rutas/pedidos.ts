// /api/pedidos  — cuentas de mesa y domicilio, comandas de cocina y cobro
//   GET  ?desde=<fecha>  → cuentas del turno (solo las que cambiaron desde esa fecha, si se da)
//   POST { accion, ... } (cada acción revisa su permiso):
//     enviar     { orden | nueva, lineas, lote }  pos.tomar      → guarda el pedido y crea la comanda
//     quitar     { orden, linea }                pos.tomar      → quita uno de algo que no va a cocina (antes de la pre-cuenta)
//     anular     { orden, linea, motivo }        pos.anular     → anula un producto ya enviado o ya en la pre-cuenta
//     mover      { orden, mesa }                 pos.tomar      → cambia de mesa
//     liberar    { orden }                       pos.tomar      → cierra sin cobrar una cuenta en $0
//     precuenta  { orden }                       pos.precuenta o pos.cobrar
//     domicilio  { orden }                       pos.tomar      → imprime los datos de envío
//     cobrar     { orden, total, pagos, recibido, imprimir }  pos.cobrar
//     comanda    { comanda, estado }             cocina.comandas → listo / entregado
// Todo lo impreso va a la cola de impresión: lo imprime el PC de caja (/api/impresion).
import { auditar, conUsuario } from '../_lib/auth';
import { esUuid } from '../_lib/db';
import { ErrorApi, json, leerJson, pesos, ruta, texto } from '../_lib/http';
import {
  encolar, exigir, imprimirComandas, leerLineas, leerNueva, leerOrdenes, numeroMesas, ordenAbierta, siguiente, tituloOrden, tocar, totalOrden
} from '../_lib/pedidos';
import { cuentaId, exigirCajaAbierta, leerEstado, turnoActual } from '../_lib/turno';

const pad3 = (n: number) => String(n || 0).padStart(3, '0');
const fmt = (n: number) => '$' + Math.round(n).toLocaleString('es-CO');

export const GET = ruta(async (req) => {
  const d = new URL(req.url).searchParams.get('desde');
  const desde = d && !Number.isNaN(Date.parse(d)) ? new Date(d) : null;
  return json(await conUsuario(req, null, async (db, u) => {
    exigir(u, 'pos.tomar', 'pos.precuenta', 'pos.cobrar', 'cocina.comandas', 'turno.operar', 'reportes.ver');
    // Se devuelve la hora del servidor menos 30 s: la próxima consulta se solapa un poco con esta,
    // así no se pierde un cambio que se estaba guardando justo en este momento.
    const hasta = (await db.query(`SELECT now() - interval '30 seconds' AS h`)).rows[0].h;
    const t = await turnoActual(db);
    if (!t) return { turnoId: null, ordenes: [], hasta, impresionPendiente: 0 };
    const pend = (await db.query(
      `SELECT count(*) AS n FROM print_jobs WHERE shift_id = $1 AND impreso_en IS NULL AND creado_en < now() - interval '20 seconds'`, [t.id])).rows[0].n;
    return { turnoId: t.id, ordenes: await leerOrdenes(db, u, t.id, { desde }), hasta, impresionPendiente: Number(pend) };
  }));
});

export const POST = ruta(async (req) => {
  const b = await leerJson(req);
  const r = await conUsuario(req, null, async (db, u) => {
    // El turno se bloquea: dos meseras enviando a la misma mesa se atienden una detrás de otra
    const t = await turnoActual(db, true);
    if (!t) throw new ErrorApi(409, 'La caja está cerrada. Primero hay que abrirla.');
    const devolver = async (id: string, extra: Record<string, unknown> = {}) => ({ orden: (await leerOrdenes(db, u, t.id, { ids: [id] }))[0], ...extra });

    switch (b.accion) {
      case 'enviar': {
        exigir(u, 'pos.tomar');
        exigirCajaAbierta(t);
        if (!esUuid(b.lote)) throw new ErrorApi(400, 'Falta el identificador del envío');
        // ¿Este mismo envío ya llegó? (el celular reintentó después de un corte de internet)
        const ya = (await db.query('SELECT order_id FROM order_items WHERE lote = $1 LIMIT 1', [b.lote])).rows[0];
        if (ya) return devolver(ya.order_id, { comanda: null, repetido: true });

        let o;
        if (b.orden) o = await ordenAbierta(db, t, b.orden);
        else {
          const n = leerNueva(b.nueva, await numeroMesas(db));
          // Si otra mesera ya abrió esa mesa, el pedido se suma a la misma cuenta
          if (n.tipo === 'mesa') o = (await db.query(`SELECT * FROM orders WHERE shift_id = $1 AND tipo = 'mesa' AND mesa = $2 AND estado = 'abierta' FOR UPDATE`, [t.id, n.mesa])).rows[0];
          if (!o) {
            o = (await db.query(
              `INSERT INTO orders (tenant_id, shift_id, numero, tipo, mesa, cliente, telefono, direccion, nota, mesero_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
              [u.tenant_id, t.id, await siguiente(db, t.id, 'seq_orden'), n.tipo, n.mesa, n.cliente, n.telefono, n.direccion, n.nota, u.id])).rows[0];
          }
        }
        const lineas = await leerLineas(db, b.lineas, o.tipo);
        const cocina = lineas.some((l) => !l.sinCocina);
        let comanda: number | null = null, ticketId: string | null = null;
        if (cocina) {
          comanda = await siguiente(db, t.id, 'seq_comanda');
          ticketId = (await db.query('INSERT INTO kitchen_tickets (tenant_id, order_id, numero, user_id) VALUES ($1, $2, $3, $4) RETURNING id', [u.tenant_id, o.id, comanda, u.id])).rows[0].id;
        }
        for (const l of lineas) {
          await db.query(
            // clock_timestamp(): cada producto con su hora exacta, así se muestran en el orden en que se pidieron
            `INSERT INTO order_items (tenant_id, order_id, product_id, inventory_item_id, nombre, categoria, detalle, obs, precio, qty, sin_cocina, ticket_id, agregado_por, lote, creado_en)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, clock_timestamp())`,
            [u.tenant_id, o.id, l.productId, l.itemId, l.nombre, l.categoria, l.detalle || null, l.obs || null, l.precio, l.qty, l.sinCocina, l.sinCocina ? null : ticketId, u.id, b.lote]);
        }
        await tocar(db, o.id);
        const res = await devolver(o.id, { comanda });
        if (comanda && (await imprimirComandas(db))) await encolar(db, u, res.orden, 'comanda', comanda);
        return res;
      }

      case 'quitar': {
        exigir(u, 'pos.tomar');
        exigirCajaAbierta(t);
        const o = await ordenAbierta(db, t, b.orden);
        const l = esUuid(b.linea) ? (await db.query('SELECT * FROM order_items WHERE id = $1 AND order_id = $2 FOR UPDATE', [b.linea, o.id])).rows[0] : null;
        if (!l || l.anulada) throw new ErrorApi(404, 'Ese producto ya no está en la cuenta');
        // Lo que ya fue a cocina o salió en la pre-cuenta impresa solo se quita anulando (con permiso y motivo)
        if (l.ticket_id) throw new ErrorApi(409, 'Eso ya se envió a cocina: solo se puede anular');
        if (o.precuenta_en && l.creado_en <= o.precuenta_en) throw new ErrorApi(409, 'Eso ya salió en la pre-cuenta: solo se puede anular');
        if (l.qty > 1) await db.query('UPDATE order_items SET qty = qty - 1 WHERE id = $1', [l.id]);
        else await db.query('DELETE FROM order_items WHERE id = $1', [l.id]);
        await tocar(db, o.id);
        return devolver(o.id);
      }

      case 'anular': {
        exigir(u, 'pos.anular');
        const o = await ordenAbierta(db, t, b.orden);
        const motivo = texto(b.motivo, 'el motivo', { max: 200 });
        const l = esUuid(b.linea) ? (await db.query('SELECT * FROM order_items WHERE id = $1 AND order_id = $2 FOR UPDATE', [b.linea, o.id])).rows[0] : null;
        if (!l) throw new ErrorApi(404, 'Ese producto no está en la cuenta');
        if (l.anulada) throw new ErrorApi(409, 'Ese producto ya estaba anulado');
        await db.query('UPDATE order_items SET anulada = true, anulada_motivo = $2, anulada_por = $3, anulada_en = now() WHERE id = $1', [l.id, motivo, u.id]);
        await tocar(db, o.id);
        await auditar(db, u.tenant_id, u.id, 'Producto anulado', `${tituloOrden(o)}: ${l.qty} ${l.nombre} (${fmt(l.precio * l.qty)}). Motivo: ${motivo}`);
        return devolver(o.id);
      }

      case 'mover': {
        exigir(u, 'pos.tomar');
        const o = await ordenAbierta(db, t, b.orden);
        if (o.tipo !== 'mesa') throw new ErrorApi(400, 'Solo las mesas se cambian de lugar');
        const mesa = leerNueva({ tipo: 'mesa', mesa: b.mesa }, await numeroMesas(db)).mesa;
        const ocupada = (await db.query(`SELECT 1 FROM orders WHERE shift_id = $1 AND tipo = 'mesa' AND mesa = $2 AND estado = 'abierta'`, [t.id, mesa])).rows[0];
        if (ocupada) throw new ErrorApi(409, `La mesa ${mesa} ya está ocupada`);
        await db.query('UPDATE orders SET mesa = $2, actualizado_en = now() WHERE id = $1', [o.id, mesa]);
        await auditar(db, u.tenant_id, u.id, 'Cambio de mesa', `Mesa ${o.mesa} a mesa ${mesa}`);
        return devolver(o.id);
      }

      case 'liberar': {
        exigir(u, 'pos.tomar', 'pos.cobrar');
        const o = await ordenAbierta(db, t, b.orden);
        const orden = (await leerOrdenes(db, u, t.id, { ids: [o.id] }))[0];
        if (totalOrden(orden) !== 0) throw new ErrorApi(409, 'La cuenta tiene productos por cobrar. Cóbrala o anula los productos.');
        await db.query(`UPDATE orders SET estado = 'anulada', cerrado_en = now(), actualizado_en = now() WHERE id = $1`, [o.id]);
        await auditar(db, u.tenant_id, u.id, 'Cuenta liberada sin cobro', tituloOrden(o));
        return devolver(o.id);
      }

      case 'precuenta': {
        exigir(u, 'pos.precuenta', 'pos.cobrar');
        const o = await ordenAbierta(db, t, b.orden);
        await db.query('UPDATE orders SET precuenta_en = now(), actualizado_en = now() WHERE id = $1', [o.id]);
        const res = await devolver(o.id);
        await encolar(db, u, res.orden, 'precuenta');
        await auditar(db, u.tenant_id, u.id, 'Pre-cuenta impresa', `${tituloOrden(o)} ${fmt(totalOrden(res.orden))}`);
        return res;
      }

      case 'domicilio': {
        exigir(u, 'pos.tomar', 'pos.cobrar');
        const o = await ordenAbierta(db, t, b.orden);
        if (o.tipo !== 'domicilio') throw new ErrorApi(400, 'Esa cuenta no es un domicilio');
        const res = await devolver(o.id);
        await encolar(db, u, res.orden, 'domicilio');
        return res;
      }

      case 'cobrar': {
        exigir(u, 'pos.cobrar');
        exigirCajaAbierta(t);
        const o = await ordenAbierta(db, t, b.orden);
        const orden = (await leerOrdenes(db, u, t.id, { ids: [o.id] }))[0];
        const total = totalOrden(orden);
        // Si alguien agregó o anuló algo mientras la caja cobraba, se avisa en vez de cobrar otro valor
        if (pesos(b.total, 'El total') !== total) throw new ErrorApi(409, `La cuenta cambió mientras cobrabas: ahora es ${fmt(total)}. Revísala y cobra de nuevo.`);
        if (total <= 0) throw new ErrorApi(409, 'La cuenta está en $0: usa "Liberar sin cobrar"');
        if (!Array.isArray(b.pagos) || !b.pagos.length || b.pagos.length > 8) throw new ErrorApi(400, 'Faltan los pagos');
        const pagos: { cuenta: string; cuentaId: string; monto: number }[] = [];
        for (const p of b.pagos as Record<string, unknown>[]) {
          pagos.push({ cuenta: String(p && p.cuenta), cuentaId: await cuentaId(db, p && p.cuenta), monto: pesos(p && p.monto, 'El pago', { min: 1 }) });
        }
        const suma = pagos.reduce((a, p) => a + p.monto, 0);
        if (suma !== total) throw new ErrorApi(400, `Los pagos suman ${fmt(suma)} y la cuenta es ${fmt(total)}`);
        const efectivo = pagos.filter((p) => p.cuenta === 'Efectivo').reduce((a, p) => a + p.monto, 0);
        let recibido = b.recibido === undefined || b.recibido === null || b.recibido === 0 ? efectivo : pesos(b.recibido, 'El efectivo recibido');
        if (!efectivo) recibido = 0;
        if (recibido < efectivo) throw new ErrorApi(400, 'El efectivo entregado es menor que el valor en efectivo');
        const concepto = `${tituloOrden(o)}, orden #${pad3(o.numero)}`;
        // Cada pago: un movimiento en el libro contable y su pago unido a la cuenta
        for (const p of pagos) {
          const l = (await db.query(
            `INSERT INTO ledger_entries (tenant_id, shift_id, account_id, tipo, monto, concepto, categoria, ref_id, user_id)
             VALUES ($1, $2, $3, 'venta', $4, $5, 'Venta', $6, $7) RETURNING id`,
            [u.tenant_id, t.id, p.cuentaId, p.monto, concepto, o.id, u.id])).rows[0];
          await db.query('INSERT INTO payments (tenant_id, order_id, account_id, monto, ledger_id, user_id) VALUES ($1, $2, $3, $4, $5, $6)',
            [u.tenant_id, o.id, p.cuentaId, p.monto, l.id, u.id]);
        }
        await db.query(
          `UPDATE orders SET estado = 'pagada', cerrado_en = now(), cobrado_por = $2, recibido = $3, cambio = $4, actualizado_en = now() WHERE id = $1`,
          [o.id, u.id, recibido, recibido - efectivo]);
        const res = await devolver(o.id);
        if (b.imprimir) await encolar(db, u, res.orden, 'recibo');
        return { ...res, estado: await leerEstado(db, u) };
      }

      case 'comanda': {
        exigir(u, 'cocina.comandas');
        const k = esUuid(b.comanda) ? (await db.query(
          'SELECT k.* FROM kitchen_tickets k JOIN orders o ON o.id = k.order_id WHERE k.id = $1 AND o.shift_id = $2 FOR UPDATE', [b.comanda, t.id])).rows[0] : null;
        if (!k) throw new ErrorApi(404, 'Esa comanda no existe en este turno');
        if (b.estado === 'listo' && k.estado === 'pendiente') await db.query(`UPDATE kitchen_tickets SET estado = 'listo', listo_en = now() WHERE id = $1`, [k.id]);
        else if (b.estado === 'entregado' && k.estado !== 'entregado') await db.query(`UPDATE kitchen_tickets SET estado = 'entregado', entregado_en = now(), listo_en = coalesce(listo_en, now()) WHERE id = $1`, [k.id]);
        else if (b.estado !== 'listo' && b.estado !== 'entregado') throw new ErrorApi(400, 'Estado de comanda no válido');
        await tocar(db, k.order_id);
        return devolver(k.order_id);
      }
    }
    throw new ErrorApi(400, 'Acción no válida');
  });
  return json(r, 201);
});
