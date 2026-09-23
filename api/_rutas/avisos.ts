// /api/avisos  (permiso reportes.ver: los avisos llevan el dinero del negocio)
//   GET  → estado: si el servidor tiene Telegram/correo configurados y a quién se envía
//   POST { accion: 'telegram-codigo' }            → enlace para conectar el Telegram del dueño
//   POST { accion: 'telegram-confirmar' }         → busca el mensaje "Iniciar" y guarda el chat
//   POST { accion: 'telegram-quitar' }
//   POST { accion: 'correo', correo }             → guarda (o borra con "") el correo del reporte
//   POST { accion: 'probar' }                     → envía un mensaje de prueba por los canales activos
import { randomBytes } from 'crypto';
import type { PoolClient } from 'pg';
import { auditar, conUsuario } from '../_lib/auth';
import { Destinos, correoDisponible, enviarATodos, enviarTelegram, leerDestinos, telegram, telegramDisponible } from '../_lib/avisos';
import { ErrorApi, json, leerJson, ruta } from '../_lib/http';

async function guardar(db: PoolClient, d: Destinos & { telegramCodigo?: string | null; codigoVence?: number | null }) {
  await db.query(`UPDATE tenants SET config = jsonb_set(config, '{avisos}', $1::jsonb, true)`, [JSON.stringify(d)]);
}
/** Nombre del bot, o por qué Telegram no lo reconoce (token mal copiado, bot borrado…). */
async function revisarBot(): Promise<{ bot: string | null; problema: string | null }> {
  if (!telegramDisponible()) return { bot: null, problema: 'Falta TELEGRAM_BOT_TOKEN en Vercel' };
  try { return { bot: (await telegram('getMe')).username, problema: null }; }
  catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { bot: null, problema: /401|404/.test(m)
      ? 'Telegram no reconoce el token guardado en Vercel (TELEGRAM_BOT_TOKEN). Revisa que esté completo, sin espacios ni comillas, y vuelve a publicar (Redeploy).'
      : 'No se pudo hablar con Telegram: ' + m };
  }
}
async function estado(db: PoolClient) {
  const { destinos } = await leerDestinos(db);
  const { bot, problema } = await revisarBot();
  return {
    telegram: { disponible: telegramDisponible(), bot, problema, conectado: !!destinos.telegramChatId },
    correo: { disponible: correoDisponible(), correo: destinos.correo || '' }
  };
}

export const GET = ruta(async (req) => json(await conUsuario(req, 'reportes.ver', (db) => estado(db))));

export const POST = ruta(async (req) => {
  const b = await leerJson(req);
  const r = await conUsuario(req, 'reportes.ver', async (db, u) => {
    const { negocio, destinos } = await leerDestinos(db);
    const d = { ...destinos } as Destinos & { telegramCodigo?: string | null; codigoVence?: number | null };

    if (b.accion === 'telegram-codigo') {
      const { bot, problema } = await revisarBot();
      if (!bot) throw new ErrorApi(503, problema || 'Telegram no respondió');
      d.telegramCodigo = randomBytes(6).toString('hex');
      d.codigoVence = Date.now() + 15 * 60_000;
      await guardar(db, d);
      return { enlace: `https://t.me/${bot}?start=${d.telegramCodigo}` };
    }
    if (b.accion === 'telegram-confirmar') {
      if (!d.telegramCodigo || !d.codigoVence || d.codigoVence < Date.now()) throw new ErrorApi(409, 'El enlace venció. Toca "Conectar Telegram" otra vez.');
      const updates: any[] = await telegram('getUpdates', { allowed_updates: ['message'] });
      const m = updates.map((x) => x.message).reverse().find((x) => x && typeof x.text === 'string' && x.text.trim() === `/start ${d.telegramCodigo}`);
      if (!m) throw new ErrorApi(409, 'Todavía no llega tu mensaje. En Telegram toca "Iniciar" (Start) en el bot y vuelve a intentar.');
      d.telegramChatId = String(m.chat.id);
      d.telegramCodigo = null; d.codigoVence = null;
      await guardar(db, d);
      await enviarTelegram(d.telegramChatId, `✅ Listo. Aquí te llegarán los cierres de ${negocio}.`);
      await auditar(db, u.tenant_id, u.id, 'Avisos por Telegram conectados');
      return estado(db);
    }
    if (b.accion === 'telegram-quitar') {
      delete d.telegramChatId;
      await guardar(db, d);
      await auditar(db, u.tenant_id, u.id, 'Avisos por Telegram desconectados');
      return estado(db);
    }
    if (b.accion === 'correo') {
      const correo = typeof b.correo === 'string' ? b.correo.trim().toLowerCase() : '';
      if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(correo)) throw new ErrorApi(400, 'Ese correo no es válido');
      if (correo) d.correo = correo; else delete d.correo;
      await guardar(db, d);
      await auditar(db, u.tenant_id, u.id, 'Correo de reportes', correo || 'quitado');
      return estado(db);
    }
    if (b.accion === 'probar') {
      const res = await enviarATodos(d, `Prueba · ${negocio}`, `🔔 Prueba de avisos de ${negocio}. Si ves esto, los cierres te llegarán aquí.`);
      return { ...(await estado(db)), prueba: res };
    }
    throw new ErrorApi(400, 'Acción no válida');
  });
  return json(r);
});
