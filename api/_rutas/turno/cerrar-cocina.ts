// POST /api/turno/cerrar-cocina  (permiso cocina.inventario)
// { conteo: {insumoId: cantidad}, obs, preparar: ['Salsa de pizza', ...] }
// Inventario de cierre de cocina: pesa o cuenta lo que queda. Con esto se sabe cuánto se gastó.
// Normalmente es el ÚLTIMO paso de la noche: si la caja ya está cerrada, el turno termina aquí y
// se calcula el resultado del día (ventas − costo de lo consumido − gastos). Si cocina cuenta antes
// de que cierren la caja, puede volver a contar; el turno termina cuando la encargada cierre.
import { auditar, conUsuario } from '../../_lib/auth';
import { avisarCierre } from '../../_lib/avisos';
import { ErrorApi, json, leerJson, ruta } from '../../_lib/http';
import { actualizarTurno, guardarConteo, itemsDe, leerConteo, leerEstado, leerObs, turnoActual } from '../../_lib/turno';

export const POST = ruta(async (req) => {
  const b = await leerJson(req);
  const r = await conUsuario(req, 'cocina.inventario', async (db, u) => {
    const t = await turnoActual(db, true);
    if (!t) throw new ErrorApi(409, 'No hay un turno abierto');
    const insumos = await itemsDe(db, 'insumo');
    const conteo = leerConteo(b.conteo, insumos, 'insumos');
    const obs = leerObs(b.obs);
    // Qué hay que preparar mañana (lo configura el dueño en Ajustes → Preparaciones)
    const config = (await db.query('SELECT config FROM tenants')).rows[0].config || {};
    const nombres = ((config.preparaciones || []) as { nombre: string }[]).map((p) => p.nombre);
    const preparar = Array.isArray(b.preparar) ? [...new Set(b.preparar as unknown[])] : [];
    if (preparar.some((p) => !nombres.includes(p as string))) throw new ErrorApi(400, 'Una preparación ya no existe. Recarga la página.');
    await guardarConteo(db, u, t.id, 'cocina_cierre', insumos, conteo);
    await db.query('UPDATE shifts SET cocina_cierre = $2 WHERE id = $1', [t.id, JSON.stringify({ en: new Date().toISOString(), por: u.nombre, conteo, obs, preparar })]);
    const termino = await actualizarTurno(db, u, t.id);
    await auditar(db, u.tenant_id, u.id, 'Inventario de cierre de cocina', termino ? 'Turno terminado' : 'La caja sigue abierta');
    return { ...(await leerEstado(db, u)), tenantId: u.tenant_id, turnoId: t.id, termino };
  });
  // Si el turno terminó, el dueño recibe el reporte completo con la utilidad
  const avisos = r.termino ? await avisarCierre(r.tenantId, r.turnoId, true) : null;
  return json({ ...r, tenantId: undefined, avisos }, 201);
});
