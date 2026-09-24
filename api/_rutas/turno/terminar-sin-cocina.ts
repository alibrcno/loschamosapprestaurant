// POST /api/turno/terminar-sin-cocina  (permiso turno.operar)
// { motivo }  → si cocina no hizo su inventario de cierre, termina el turno igual para poder
// abrir el siguiente. El resultado del día queda SIN el costo de insumos y queda anotado por qué.
import { auditar, conUsuario } from '../../_lib/auth';
import { avisarCierre } from '../../_lib/avisos';
import { ErrorApi, json, leerJson, ruta, texto } from '../../_lib/http';
import { actualizarTurno, leerEstado, turnoActual } from '../../_lib/turno';

export const POST = ruta(async (req) => {
  const b = await leerJson(req);
  const r = await conUsuario(req, 'turno.operar', async (db, u) => {
    const t = await turnoActual(db, true);
    if (!t || !t.caja_cerrada_en) throw new ErrorApi(409, 'Primero hay que cerrar la caja');
    if (t.cocina_cierre) throw new ErrorApi(409, 'Cocina ya hizo su inventario');
    const motivo = texto(b.motivo, 'el motivo', { max: 200 });
    await db.query('UPDATE shifts SET cocina_cierre = $2 WHERE id = $1', [t.id, JSON.stringify({ sinInventario: true, motivo, en: new Date().toISOString(), por: u.nombre })]);
    await actualizarTurno(db, u, t.id);
    await auditar(db, u.tenant_id, u.id, 'Turno terminado sin inventario de cocina', motivo);
    return { ...(await leerEstado(db, u)), tenantId: u.tenant_id, turnoId: t.id, termino: true };
  });
  const avisos = await avisarCierre(r.tenantId, r.turnoId, true);
  return json({ ...r, tenantId: undefined, avisos }, 201);
});
