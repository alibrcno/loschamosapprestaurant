// POST /api/turno/cerrar-caja  (permiso turno.operar)
// { bebidas: {itemId: n}, utensilios: {itemId: n}, saldos: {Efectivo: n, ...}, obs }
// Paso 1 del cierre (encargada): conteo final de bebidas y utensilios y arqueo. Si algo no cuadra,
// queda el ajuste en el libro y se exige explicación. Después de esto no se vende más en el turno.
// El turno termina cuando cocina haga su inventario (o ya lo hizo antes): ahí sale la utilidad.
import { auditar, conUsuario } from '../../_lib/auth';
import { avisarCierre } from '../../_lib/avisos';
import { ErrorApi, json, leerJson, ruta } from '../../_lib/http';
import {
  actualizarTurno, calcularResumen, cuentas, exigirCajaAbierta, guardarConteo, itemsDe, leerConteo, leerEstado, leerObs,
  leerSaldos, registrar, saldos, turnoActual
} from '../../_lib/turno';

export const POST = ruta(async (req) => {
  const b = await leerJson(req);
  const r = await conUsuario(req, 'turno.operar', async (db, u) => {
    const t = exigirCajaAbierta(await turnoActual(db, true));
    const abiertas = (await db.query(`SELECT count(*) AS n FROM orders WHERE shift_id = $1 AND estado = 'abierta'`, [t.id])).rows[0].n;
    if (Number(abiertas)) throw new ErrorApi(409, 'Hay cuentas sin cerrar. Cóbralas o anúlalas antes de cerrar la caja.');
    const [bebidas, utensilios] = await Promise.all([itemsDe(db, 'bebida'), itemsDe(db, 'utensilio')]);
    const conteoB = leerConteo(b.bebidas, bebidas, 'bebidas');
    const conteoU = leerConteo(b.utensilios, utensilios, 'utensilios');
    const contados = await leerSaldos(db, b.saldos);
    const esperados = await saldos(db);
    const descuadre = Object.fromEntries(Object.keys(contados).map((c) => [c, contados[c] - (esperados[c] || 0)]));
    const obs = leerObs(b.obs);
    const cierre = {
      en: new Date().toISOString(), por: u.nombre, bebidas: conteoB, utensilios: conteoU,
      saldosContados: contados, saldosEsperados: esperados, descuadre, obs
    };
    // ¿Cuadra? Las bebidas que faltan según el conteo deben coincidir con las cobradas
    const previo = await calcularResumen(db, { ...t, cierre });
    const hayDesc = Object.values(descuadre).some((x) => x !== 0);
    const hayDifB = previo.bebidas.some((x: any) => x.dif);
    if ((hayDesc || hayDifB) && !obs) throw new ErrorApi(400, 'Explica las diferencias antes de cerrar la caja');

    for (const c of await cuentas(db)) {
      await registrar(db, u, { shiftId: t.id, cuentaId: c.id, tipo: 'ajuste', monto: descuadre[c.nombre] || 0, concepto: 'Descuadre en cierre de caja', categoria: 'Arqueo' });
    }
    await guardarConteo(db, u, t.id, 'cierre', bebidas, conteoB);
    await guardarConteo(db, u, t.id, 'cierre', utensilios, conteoU);
    await db.query('UPDATE shifts SET caja_cerrada_en = now(), caja_cerrada_por = $2, nota_cierre = $3, cierre = $4 WHERE id = $1', [
      t.id, u.id, obs || null, JSON.stringify(cierre)
    ]);
    const termino = await actualizarTurno(db, u, t.id);
    const totalDesc = Object.values(descuadre).reduce((a, x) => a + x, 0);
    await auditar(db, u.tenant_id, u.id, 'Cierre de caja', `Ventas $${previo.ventas.toLocaleString('es-CO')}, descuadre $${totalDesc.toLocaleString('es-CO')}${termino ? '. Turno terminado' : '. Falta el inventario de cocina'}`);
    return { ...(await leerEstado(db, u)), tenantId: u.tenant_id, turnoId: t.id, termino };
  });
  // Aviso al dueño: caja cerrada (o reporte completo si cocina ya había contado)
  const avisos = await avisarCierre(r.tenantId, r.turnoId, r.termino);
  return json({ ...r, tenantId: undefined, avisos }, 201);
});
