// POST /api/turno/traslado  (permiso caja.movimientos)
// { desde, hacia, monto, concepto }  → dos movimientos unidos: sale de una cuenta y entra a la otra.
import { auditar, conUsuario, puede } from '../../_lib/auth';
import { ErrorApi, json, leerJson, pesos, ruta } from '../../_lib/http';
import { cuentaId, leerEstado, leerObs, nuevoGrupo, registrar, turnoActual } from '../../_lib/turno';

export const POST = ruta(async (req) => {
  const b = await leerJson(req);
  const r = await conUsuario(req, 'caja.movimientos', async (db, u) => {
    if (b.desde === b.hacia) throw new ErrorApi(400, 'Elige dos cuentas diferentes');
    const monto = pesos(b.monto, 'El valor', { min: 1 });
    const desde = await cuentaId(db, b.desde), hacia = await cuentaId(db, b.hacia);
    const c = leerObs(b.concepto, 100) || 'Traslado';
    const t = await turnoActual(db);
    const enCaja = !!t && !!t.caja_abierta_en && !t.caja_cerrada_en;
    if (!enCaja && !puede(u, 'reportes.ver')) throw new ErrorApi(409, 'La caja está cerrada');
    const base = { shiftId: enCaja ? t!.id : null, tipo: 'traslado', categoria: 'Traslado', grupoId: nuevoGrupo() };
    await registrar(db, u, { ...base, cuentaId: desde, monto: -monto, concepto: `${c} hacia ${b.hacia}` });
    await registrar(db, u, { ...base, cuentaId: hacia, monto, concepto: `${c} desde ${b.desde}` });
    await auditar(db, u.tenant_id, u.id, 'Traslado', `$${monto.toLocaleString('es-CO')} de ${b.desde} a ${b.hacia}`);
    return leerEstado(db, u);
  });
  return json(r, 201);
});
