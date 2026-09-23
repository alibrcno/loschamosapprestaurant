// POST /api/turno/movimiento  (permiso caja.movimientos)
// { tipo: 'gasto' | 'ingreso', cuenta, monto, concepto, categoria }
// Siempre dice de qué cuenta salió o a cuál entró. Con la caja cerrada solo puede registrarlo
// quien ve reportes (el administrador): queda fuera de cualquier turno.
import { auditar, conUsuario, puede } from '../../_lib/auth';
import { ErrorApi, json, leerJson, pesos, ruta, texto } from '../../_lib/http';
import { CAT_GASTO, CAT_INGRESO, cuentaId, leerEstado, registrar, turnoActual } from '../../_lib/turno';

export const POST = ruta(async (req) => {
  const b = await leerJson(req);
  const r = await conUsuario(req, 'caja.movimientos', async (db, u) => {
    if (b.tipo !== 'gasto' && b.tipo !== 'ingreso') throw new ErrorApi(400, 'El tipo debe ser gasto o ingreso');
    const gasto = b.tipo === 'gasto';
    const categoria = texto(b.categoria, 'la categoría', { max: 40 });
    if (!(gasto ? CAT_GASTO : CAT_INGRESO).includes(categoria)) throw new ErrorApi(400, 'La categoría no es válida');
    const monto = pesos(b.monto, 'El valor', { min: 1 });
    const concepto = texto(b.concepto, 'el concepto', { max: 120 });
    const t = await turnoActual(db);
    const enCaja = t && !t.caja_cerrada_en;
    if (!enCaja && !puede(u, 'reportes.ver')) throw new ErrorApi(409, 'La caja está cerrada');
    const cuenta = await cuentaId(db, b.cuenta);
    await registrar(db, u, { shiftId: enCaja ? t.id : null, cuentaId: cuenta, tipo: b.tipo, monto: gasto ? -monto : monto, concepto, categoria });
    await auditar(db, u.tenant_id, u.id, gasto ? 'Gasto registrado' : 'Ingreso registrado', `${concepto} $${monto.toLocaleString('es-CO')} (${b.cuenta})`);
    return leerEstado(db, u);
  });
  return json(r, 201);
});
