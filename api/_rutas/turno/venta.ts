// POST /api/turno/venta  (permiso pos.cobrar)
// { pagos: [{ cuenta, monto }], concepto }  → registra en el libro el cobro de una cuenta.
// Provisional (fase 3, parte 3): el pedido todavía vive en el equipo que lo cobra; en la parte 4
// el cobro se hará sobre la orden guardada en el servidor y quedará unido a ella.
import { conUsuario } from '../../_lib/auth';
import { ErrorApi, json, leerJson, pesos, ruta, texto } from '../../_lib/http';
import { cuentaId, exigirCajaAbierta, leerEstado, registrar, turnoActual } from '../../_lib/turno';

export const POST = ruta(async (req) => {
  const b = await leerJson(req);
  const r = await conUsuario(req, 'pos.cobrar', async (db, u) => {
    const t = exigirCajaAbierta(await turnoActual(db, true));
    const concepto = texto(b.concepto, 'el concepto', { max: 120 });
    if (!Array.isArray(b.pagos) || !b.pagos.length || b.pagos.length > 8) throw new ErrorApi(400, 'Faltan los pagos');
    const pagos = [];
    for (const p of b.pagos as Record<string, unknown>[]) {
      pagos.push({ cuentaId: await cuentaId(db, p && p.cuenta), monto: pesos(p && p.monto, 'El pago', { min: 1 }) });
    }
    for (const p of pagos) await registrar(db, u, { shiftId: t.id, cuentaId: p.cuentaId, tipo: 'venta', monto: p.monto, concepto, categoria: 'Venta' });
    return leerEstado(db, u);
  });
  return json(r, 201);
});
