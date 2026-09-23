// POST /api/turno/cerrar-caja  (permiso turno.operar)
// { bebidas: {itemId: n}, utensilios: {itemId: n}, saldos: {Efectivo: n, ...}, obs, ventasPOS }
// Paso 1 del cierre (encargada): conteo final de bebidas y utensilios y arqueo. Si algo no cuadra,
// queda el ajuste en el libro y se exige explicación. Después de esto no se vende más en el turno.
// El turno termina cuando cocina haga su inventario (o ya lo hizo antes): ahí sale la utilidad.
import { auditar, conUsuario } from '../../_lib/auth';
import { ErrorApi, json, leerJson, ruta } from '../../_lib/http';
import {
  actualizarTurno, calcularResumen, cuentas, exigirCajaAbierta, guardarConteo, itemsDe, leerConteo, leerEstado, leerObs,
  leerSaldos, registrar, saldos, turnoActual
} from '../../_lib/turno';

const entero = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);

/** Detalle de lo vendido que manda la caja (mientras los pedidos viven en cada equipo). */
function leerVentasPOS(v: unknown) {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, any>;
  const productos = (Array.isArray(o.productos) ? o.productos : []).slice(0, 500)
    .filter((p: any) => p && typeof p.nombre === 'string')
    .map((p: any) => ({ nombre: p.nombre.slice(0, 120), qty: entero(p.qty), valor: entero(p.valor) }));
  const mapa = (m: unknown, max: number) => Object.fromEntries(Object.entries(m && typeof m === 'object' ? m : {}).slice(0, max).map(([k, x]) => [k.slice(0, 120), entero(x)]));
  return { productos, porCategoria: mapa(o.porCategoria, 100), bebidas: mapa(o.bebidas, 500), ordenesPagadas: entero(o.ordenesPagadas), anulaciones: entero(o.anulaciones) };
}

export const POST = ruta(async (req) => {
  const b = await leerJson(req);
  const r = await conUsuario(req, 'turno.operar', async (db, u) => {
    const t = exigirCajaAbierta(await turnoActual(db, true));
    const [bebidas, utensilios] = await Promise.all([itemsDe(db, 'bebida'), itemsDe(db, 'utensilio')]);
    const conteoB = leerConteo(b.bebidas, bebidas, 'bebidas');
    const conteoU = leerConteo(b.utensilios, utensilios, 'utensilios');
    const contados = await leerSaldos(db, b.saldos);
    const esperados = await saldos(db);
    const descuadre = Object.fromEntries(Object.keys(contados).map((c) => [c, contados[c] - (esperados[c] || 0)]));
    const obs = leerObs(b.obs);
    const cierre = {
      en: new Date().toISOString(), por: u.nombre, bebidas: conteoB, utensilios: conteoU,
      saldosContados: contados, saldosEsperados: esperados, descuadre, obs, ventasPOS: leerVentasPOS(b.ventasPOS)
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
    return { ...(await leerEstado(db, u)), turnoId: t.id, termino };
  });
  return json(r, 201);
});
