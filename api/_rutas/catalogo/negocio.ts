// PATCH /api/catalogo/negocio  (permiso catalogo.editar)
// { nombre, whatsapp, nit, direccion, telefono, mesas, ticket, valorDomicilio, imprimirComandas, ticketEncabezado, ticketPie, logo? }
// logo: imagen en "data:image/…;base64,…" (la app la achica antes), null para quitarlo, o sin enviar para dejarlo igual.
// El código del negocio, el plan y si está activo NO se cambian aquí (la base ni lo permite).
import { auditar, conUsuario } from '../../_lib/auth';
import { ErrorApi, json, leerJson, pesos, ruta, texto } from '../../_lib/http';

async function guardarLogo(db: import('pg').PoolClient, logo: unknown) {
  if (logo !== null && (typeof logo !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(logo))) throw new ErrorApi(400, 'El logo debe ser una imagen PNG, JPG o WEBP');
  if (typeof logo === 'string' && logo.length > 120000) throw new ErrorApi(400, 'El logo es muy pesado: usa una imagen más pequeña');
  await db.query('UPDATE tenants SET logo = $1', [logo]);
}
const opcional = (v: unknown, campo: string, max: number) => (v === undefined || v === null || v === '' ? '' : texto(v, campo, { max }));

export const PATCH = ruta(async (req) => {
  const b = await leerJson(req);
  const r = await conUsuario(req, 'catalogo.editar', async (db, yo) => {
    // Solo el logo: { logo } (una imagen, o null para quitarlo). No toca los demás datos.
    if (Object.keys(b).length === 1 && 'logo' in b) {
      await guardarLogo(db, b.logo);
      await auditar(db, yo.tenant_id, yo.id, b.logo ? 'Logo cambiado' : 'Logo quitado');
      return { ok: true };
    }
    const nombre = texto(b.nombre, 'el nombre del negocio', { max: 80 });
    const whatsapp = texto(b.whatsapp, 'el WhatsApp', { max: 20 }).replace(/\D/g, '');
    if (whatsapp.length < 10) throw new ErrorApi(400, 'El WhatsApp debe tener el indicativo y el número, ej. 573001234567');
    const mesas = b.mesas;
    if (typeof mesas !== 'number' || !Number.isInteger(mesas) || mesas < 1 || mesas > 60) throw new ErrorApi(400, 'El número de mesas debe estar entre 1 y 60');
    if (b.ticket !== 58 && b.ticket !== 80) throw new ErrorApi(400, 'El ancho de impresora debe ser 58 u 80 mm');
    const config = {
      mesas, ticket: b.ticket, valorDomicilio: pesos(b.valorDomicilio ?? 0, 'El valor del domicilio'), imprimirComandas: b.imprimirComandas !== false,
      // Lo que sale en los tickets: líneas extra arriba (ej. "Domicilios 300 123 4567") y el mensaje del final
      ticketEncabezado: opcional(b.ticketEncabezado, 'el encabezado del ticket', 200), ticketPie: opcional(b.ticketPie, 'el mensaje del ticket', 200)
    };
    if (b.logo !== undefined) await guardarLogo(db, b.logo);
    await db.query(
      `UPDATE tenants SET nombre = $1, whatsapp = $2, nit = $3, direccion = $4, telefono = $5, config = config || $6::jsonb`,
      [nombre, whatsapp, opcional(b.nit, 'el NIT', 30), opcional(b.direccion, 'la dirección', 120), opcional(b.telefono, 'el teléfono', 30), JSON.stringify(config)]
    );
    await auditar(db, yo.tenant_id, yo.id, 'Configuración editada', nombre);
    return { ok: true };
  });
  return json(r);
});
