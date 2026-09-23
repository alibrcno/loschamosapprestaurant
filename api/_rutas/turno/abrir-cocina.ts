// POST /api/turno/abrir-cocina  (permiso cocina.inventario)
// Cocina llega antes que la encargada: desde las 2 p. m. (hora de Colombia) abre el turno para
// registrar lo que llega y preparar. Arranca con lo que contó cocina en el cierre anterior.
// Todavía no se vende: los pedidos y el dinero esperan a que la encargada abra la caja.
import { auditar, conUsuario } from '../../_lib/auth';
import { ErrorApi, json, ruta } from '../../_lib/http';
import { itemsDe, leerEstado, turnoActual } from '../../_lib/turno';

/** Hora desde la que cocina puede abrir (en pruebas se cambia con HORA_APERTURA_COCINA). */
const horaMinima = () => {
  const h = Number(process.env.HORA_APERTURA_COCINA);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 14;
};

export const POST = ruta(async (req) => {
  const r = await conUsuario(req, 'cocina.inventario', async (db, u) => {
    await db.query('SELECT id FROM tenants FOR UPDATE'); // una apertura a la vez
    const previo = await turnoActual(db);
    if (previo && previo.caja_cerrada_en) throw new ErrorApi(409, 'El turno anterior está esperando el inventario de cierre de cocina.');
    if (previo) throw new ErrorApi(409, 'El turno ya está abierto');
    const hora = (await db.query(`SELECT extract(hour FROM now() AT TIME ZONE 'America/Bogota')::int AS h`)).rows[0].h;
    const min = horaMinima();
    if (hora < min) throw new ErrorApi(409, `La cocina se puede abrir desde las ${min > 12 ? min - 12 : min} ${min >= 12 ? 'p. m.' : 'a. m.'}`);
    const insumos = await itemsDe(db, 'insumo');
    const apertura = { insumos: Object.fromEntries(insumos.map((i) => [i.id, Number(i.stock)])), cocina: { en: new Date().toISOString(), por: u.nombre } };
    const t = (await db.query('INSERT INTO shifts (tenant_id, abierto_por, apertura) VALUES ($1, $2, $3) RETURNING id', [u.tenant_id, u.id, JSON.stringify(apertura)])).rows[0];
    await db.query('INSERT INTO shift_staff (tenant_id, shift_id, user_id, nombre, area) VALUES ($1, $2, $3, $4, $5)', [u.tenant_id, t.id, u.id, u.nombre, 'Cocina']);
    await auditar(db, u.tenant_id, u.id, 'Apertura de cocina', 'La caja la abre la encargada cuando llegue');
    return leerEstado(db, u);
  });
  return json(r, 201);
});
