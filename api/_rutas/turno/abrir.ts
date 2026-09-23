// POST /api/turno/abrir  (permiso turno.operar)
// { personal: [{ id?, nombre, area }], bebidas: {itemId: n}, utensilios: {itemId: n}, saldos: {Efectivo: n, ...}, nota }
// Registra quién trabaja, el conteo ciego de bebidas y utensilios y el arqueo de cada cuenta.
// Si lo contado no coincide con el sistema, queda un ajuste en el libro y se exige explicación.
import { auditar, conUsuario } from '../../_lib/auth';
import { esUuid } from '../../_lib/db';
import { ErrorApi, json, leerJson, ruta, texto } from '../../_lib/http';
import { AREAS, cuentas, guardarConteo, itemsDe, leerConteo, leerEstado, leerObs, leerSaldos, registrar, saldos, turnoActual } from '../../_lib/turno';

function leerPersonal(v: unknown) {
  if (!Array.isArray(v) || !v.length || v.length > 40) throw new ErrorApi(400, 'Marca quién trabaja hoy');
  const p = v.map((x) => {
    const o = (x || {}) as Record<string, unknown>;
    if (!AREAS.includes(o.area as string)) throw new ErrorApi(400, 'El área de trabajo no es válida');
    return { id: esUuid(o.id) ? o.id : null, nombre: texto(o.nombre, 'el nombre', { max: 80 }), area: o.area as string };
  });
  if (!p.some((x) => x.area === 'Cocina')) throw new ErrorApi(400, 'Indica quién está en cocina hoy');
  if (new Set(p.map((x) => x.nombre.toLowerCase())).size !== p.length) throw new ErrorApi(400, 'Hay una persona repetida en el personal');
  return p;
}

export const POST = ruta(async (req) => {
  const b = await leerJson(req);
  const r = await conUsuario(req, 'turno.operar', async (db, u) => {
    await db.query('SELECT id FROM tenants FOR UPDATE'); // una apertura a la vez
    const previo = await turnoActual(db);
    if (previo && previo.caja_cerrada_en) throw new ErrorApi(409, 'El turno anterior está esperando el inventario de cierre de cocina.');
    if (previo) throw new ErrorApi(409, 'La caja ya está abierta');

    const personal = leerPersonal(b.personal);
    const [bebidas, utensilios, insumos] = await Promise.all([itemsDe(db, 'bebida'), itemsDe(db, 'utensilio'), itemsDe(db, 'insumo')]);
    const conteoB = leerConteo(b.bebidas, bebidas, 'bebidas');
    const conteoU = leerConteo(b.utensilios, utensilios, 'utensilios');
    const contados = await leerSaldos(db, b.saldos);
    const sistema = await saldos(db);
    const nota = leerObs(b.nota);
    const hayDif = Object.keys(contados).some((c) => contados[c] !== (sistema[c] || 0));
    if (hayDif && !nota) throw new ErrorApi(400, 'Explica la diferencia en cuentas');

    const difInv: Record<string, Record<string, number>> = { bebidas: {}, utensilios: {} };
    for (const [g, items, conteo] of [['bebidas', bebidas, conteoB], ['utensilios', utensilios, conteoU]] as const) {
      for (const it of items) { const d = conteo[it.id] - Number(it.stock); if (d) difInv[g][it.id] = Math.round(d * 1000) / 1000; }
    }
    const apertura = {
      bebidas: conteoB, utensilios: conteoU, insumos: Object.fromEntries(insumos.map((i) => [i.id, Number(i.stock)])),
      saldosContados: contados, saldosSistema: sistema, difInv, nota
    };
    const t = (await db.query(
      'INSERT INTO shifts (tenant_id, abierto_por, nota_apertura, apertura) VALUES ($1, $2, $3, $4) RETURNING id',
      [u.tenant_id, u.id, nota || null, JSON.stringify(apertura)]
    )).rows[0];
    for (const p of personal) {
      await db.query('INSERT INTO shift_staff (tenant_id, shift_id, user_id, nombre, area) VALUES ($1, $2, $3, $4, $5)', [u.tenant_id, t.id, p.id, p.nombre, p.area]);
    }
    await guardarConteo(db, u, t.id, 'apertura', bebidas, conteoB);
    await guardarConteo(db, u, t.id, 'apertura', utensilios, conteoU);
    for (const c of await cuentas(db)) {
      await registrar(db, u, { shiftId: t.id, cuentaId: c.id, tipo: 'ajuste', monto: contados[c.nombre] - (sistema[c.nombre] || 0), concepto: 'Diferencia en arqueo de apertura', categoria: 'Arqueo' });
    }
    await auditar(db, u.tenant_id, u.id, 'Apertura de caja', `Personal: ${personal.map((p) => p.nombre).join(', ')}${hayDif ? '. Diferencia en arqueo: ' + nota : ''}`);
    return leerEstado(db, u);
  });
  return json(r, 201);
});
