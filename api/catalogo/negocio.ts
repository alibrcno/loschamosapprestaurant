// PATCH /api/catalogo/negocio  (permiso catalogo.editar)
// { nombre, whatsapp, nit, direccion, telefono, mesas, ticket, valorDomicilio, imprimirComandas }
// El código del negocio, el plan y si está activo NO se cambian aquí (la base ni lo permite).
import { auditar, conUsuario } from '../_lib/auth';
import { ErrorApi, json, leerJson, pesos, ruta, texto } from '../_lib/http';

const opcional = (v: unknown, campo: string, max: number) => (v === undefined || v === null || v === '' ? '' : texto(v, campo, { max }));

export const PATCH = ruta(async (req) => {
  const b = await leerJson(req);
  const r = await conUsuario(req, 'catalogo.editar', async (db, yo) => {
    const nombre = texto(b.nombre, 'el nombre del negocio', { max: 80 });
    const whatsapp = texto(b.whatsapp, 'el WhatsApp', { max: 20 }).replace(/\D/g, '');
    if (whatsapp.length < 10) throw new ErrorApi(400, 'El WhatsApp debe tener el indicativo y el número, ej. 573001234567');
    const mesas = b.mesas;
    if (typeof mesas !== 'number' || !Number.isInteger(mesas) || mesas < 1 || mesas > 60) throw new ErrorApi(400, 'El número de mesas debe estar entre 1 y 60');
    if (b.ticket !== 58 && b.ticket !== 80) throw new ErrorApi(400, 'El ancho de impresora debe ser 58 u 80 mm');
    const config = { mesas, ticket: b.ticket, valorDomicilio: pesos(b.valorDomicilio ?? 0, 'El valor del domicilio'), imprimirComandas: b.imprimirComandas !== false };
    await db.query(
      `UPDATE tenants SET nombre = $1, whatsapp = $2, nit = $3, direccion = $4, telefono = $5, config = config || $6::jsonb`,
      [nombre, whatsapp, opcional(b.nit, 'el NIT', 30), opcional(b.direccion, 'la dirección', 120), opcional(b.telefono, 'el teléfono', 30), JSON.stringify(config)]
    );
    await auditar(db, yo.tenant_id, yo.id, 'Configuración editada', nombre);
    return { ok: true };
  });
  return json(r);
});
