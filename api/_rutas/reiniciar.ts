// POST /api/reiniciar  { clave, confirmacion: 'REINICIAR' }  → deja el restaurante en 0.
// Solo el ADMINISTRADOR (rol, no un permiso que se pueda regalar) y con la clave de reinicio, que vive
// en la variable de entorno CLAVE_REINICIO de Vercel (nunca en el código). Sin esa variable, el botón
// está apagado. No funciona con un turno abierto. Borra turnos, ventas, pedidos, dinero, auditoría,
// almacén, fotos e impresiones del negocio; conserva usuarios, cuentas, menú y configuración.
// Tras 5 claves equivocadas en 15 minutos se bloquea. Al dueño le llega un aviso por Telegram y correo.
import { createHash, timingSafeEqual } from 'crypto';
import { auditar, conUsuario } from '../_lib/auth';
import { enviarATodos, leerDestinos } from '../_lib/avisos';
import { ErrorApi, json, leerJson, ruta } from '../_lib/http';

const claveReinicio = () => (process.env.CLAVE_REINICIO || '').trim();
const igual = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

export const GET = ruta(async (req) => json(await conUsuario(req, null, async (_db, u) => ({ disponible: u.rol === 'admin' && claveReinicio().length >= 6 }))));

export const POST = ruta(async (req) => {
  const b = await leerJson(req);
  const r = await conUsuario(req, null, async (db, u) => {
    if (u.rol !== 'admin') throw new ErrorApi(403, 'Solo el administrador puede reiniciar el restaurante');
    const clave = claveReinicio();
    if (clave.length < 6) throw new ErrorApi(403, 'El reinicio está apagado (falta CLAVE_REINICIO en Vercel)');
    const fallos = Number((await db.query(
      `SELECT count(*) AS n FROM audit_log WHERE accion = 'Reinicio: clave equivocada' AND creado_en > now() - interval '15 minutes'`)).rows[0].n);
    if (fallos >= 5) throw new ErrorApi(429, 'Demasiados intentos con clave equivocada. Espera 15 minutos.');
    if (b.confirmacion !== 'REINICIAR') throw new ErrorApi(400, 'Escribe REINICIAR para confirmar');
    if (typeof b.clave !== 'string' || !igual(b.clave, clave)) {
      await auditar(db, u.tenant_id, u.id, 'Reinicio: clave equivocada');
      return { mal: true } as const;
    }
    let antes;
    try {
      await db.query('SAVEPOINT reinicio');
      antes = (await db.query('SELECT reiniciar_negocio() AS r')).rows[0].r;
    } catch (e) {
      if ((e as { code?: string }).code === '23514') throw new ErrorApi(409, 'Hay un turno abierto: ciérralo antes de reiniciar');
      throw e;
    }
    await auditar(db, u.tenant_id, u.id, 'Restaurante reiniciado a 0',
      `Se borraron ${antes.turnos} turnos, ${antes.pedidos} pedidos, ${antes.movimientos} movimientos de dinero y ${antes.fotos} fotos`, antes);
    const { negocio, destinos } = await leerDestinos(db);
    return { ok: true, antes, negocio, destinos, quien: u.nombre };
  });
  if ('mal' in r) return json({ error: 'La clave de reinicio no es correcta' }, 403);
  await enviarATodos(r.destinos, `Restaurante reiniciado · ${r.negocio}`,
    `⚠️ ${r.quien} reinició ${r.negocio} a 0: se borraron ${r.antes.turnos} turnos, ${r.antes.pedidos} pedidos y ${r.antes.movimientos} movimientos de dinero.`);
  return json({ ok: true, antes: r.antes });
});
