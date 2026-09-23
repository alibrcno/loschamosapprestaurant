// Avisos automáticos del cierre al dueño: Telegram y correo (Resend).
// Los envía el SERVIDOR, así nadie del personal ve las cifras en su teléfono.
// Claves en variables de entorno de Vercel (nunca en el código):
//   TELEGRAM_BOT_TOKEN  → token del bot creado con @BotFather
//   RESEND_API_KEY      → clave de resend.com;  RESEND_FROM (opcional) → remitente
// A quién se envía lo guarda cada negocio en tenants.config.avisos (chat de Telegram y correo).
// Si un aviso falla, el cierre NO se afecta: solo se anota en el registro del servidor.
import type { PoolClient } from 'pg';
import { avaluoAlmacen } from './almacen';
import { conNegocio } from './db';

const TG = () => process.env.TELEGRAM_API_URL || 'https://api.telegram.org';
const RESEND = () => process.env.RESEND_API_URL || 'https://api.resend.com';
const ESPERA_MS = 8000;

// Se quitan espacios y comillas que a veces se cuelan al copiar el token en Vercel
const tokenTelegram = () => (process.env.TELEGRAM_BOT_TOKEN || '').trim().replace(/^["']|["']$/g, '');
export const telegramDisponible = () => !!tokenTelegram();
export const correoDisponible = () => !!(process.env.RESEND_API_KEY || '').trim();

/* ---------------- Telegram ---------------- */
export async function telegram(metodo: string, datos: Record<string, unknown> = {}): Promise<any> {
  const r = await fetch(`${TG()}/bot${tokenTelegram()}/${metodo}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(datos), signal: AbortSignal.timeout(ESPERA_MS)
  });
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok || !j.ok) throw new Error(`Telegram respondió ${r.status}: ${j.description || 'sin detalle'}`);
  return j.result;
}
export async function enviarTelegram(chatId: string, texto: string) {
  // Telegram acepta hasta 4.096 caracteres por mensaje
  for (let i = 0; i < texto.length; i += 4000) await telegram('sendMessage', { chat_id: chatId, text: texto.slice(i, i + 4000) });
}

/* ---------------- Correo ---------------- */
export async function enviarCorreo(para: string, asunto: string, texto: string) {
  const r = await fetch(`${RESEND()}/emails`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${(process.env.RESEND_API_KEY || '').trim()}` },
    body: JSON.stringify({ from: process.env.RESEND_FROM || 'Los Chamos POS <onboarding@resend.dev>', to: [para], subject: asunto, text: texto }),
    signal: AbortSignal.timeout(ESPERA_MS)
  });
  if (!r.ok) throw new Error(`El correo respondió ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
}

/* ---------------- formato (igual que LC.fmt, LC.q y las fechas de la app) ---------------- */
const fmt = (n: number) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n || 0)).toLocaleString('es-CO');
const q = (n: number) => (Math.round((+n || 0) * 100) / 100).toLocaleString('es-CO');
const TZ = 'America/Bogota';
const fechaLarga = (d: Date) => d.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ });
const hora = (d: Date) => d.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit', timeZone: TZ });

export interface Destinos { telegramChatId?: string; correo?: string }

/** Texto del reporte (el mismo contenido que el WhatsApp de la app, LC.msgCierre). */
export interface Extra { almacen?: { total: number; bajos: { nombre: string; cantidad: number; minimo: number; unidad: string }[] }; semana?: { desde: string; turnos: number; ventas: number; utilidad: number } }
export function textoReporte(negocio: string, t: any, abrio: string, final: boolean, cuentas: string[], extra: Extra = {}): string {
  const r = t.resumen, ci = t.cierre || {}, co = t.cocina_cierre || {};
  const L: string[] = [];
  L.push(final ? `📊 RESULTADO DEL DÍA · ${negocio.toUpperCase()}` : `🔒 CIERRE DE CAJA · ${negocio.toUpperCase()}`);
  L.push(`📅 ${fechaLarga(new Date(t.abierto_en))}, ${hora(new Date(t.abierto_en))} a ${hora(new Date(t.cerrado_en || t.caja_cerrada_en || Date.now()))}`);
  L.push(`👤 Abrió ${abrio}, cerró la caja ${ci.por || ''}${final && co.por ? `, inventario de cocina ${co.por}` : ''}`);
  L.push('', `💰 VENTAS: ${fmt(r.ventas)}`, `${r.ordenesPagadas} cuentas, ticket promedio ${fmt(r.ticketProm)}`);
  // Las cuentas siempre en el orden del negocio (Efectivo, Nequi, Bancolombia, Datáfono)
  cuentas.forEach((c) => L.push(`• ${c}: ${fmt((r.ventasCuenta || {})[c] || 0)}`));
  const cats = Object.entries((r.porCategoria || {}) as Record<string, number>).sort((a, b) => b[1] - a[1]);
  if (cats.length) { L.push('', '🍕 Por categoría'); cats.forEach(([c, v]) => L.push(`• ${c}: ${fmt(v)}`)); }
  L.push('', `🥤 BEBIDAS SEGÚN CONTEO: ${fmt(r.ventaBebidasConteo)}`);
  r.bebidas.filter((b: any) => b.consumo).forEach((b: any) => L.push(`• ${b.nombre}: ${q(b.consumo)} (${fmt(b.valor)})${b.dif ? ` ⚠️ POS registró ${q(b.pos)}` : ''}`));
  L.push('', `🧾 GASTOS: ${fmt(r.gastos)}`);
  r.gastosLista.forEach((g: any) => L.push(`• ${g.concepto}: ${fmt(g.valor)} (${g.cuenta})`));
  if (ci.saldosContados) {
    L.push('', '🏦 ARQUEO');
    cuentas.forEach((c) => {
      const dif = (ci.descuadre || {})[c] || 0;
      L.push(`• ${c}: ${fmt(ci.saldosContados[c])} ${dif ? `⚠️ ${dif > 0 ? 'sobran' : 'faltan'} ${fmt(Math.abs(dif))}` : '✅'}`);
    });
  }
  L.push('', '📊 RESULTADO');
  if (!final) {
    L.push('⏳ Se calcula cuando cocina haga su inventario de cierre. Te llegará otro aviso.');
  } else {
    L.push(`Costo de lo consumido: ${fmt(r.costoConsumo)}${r.cocinaCerrada ? '' : ' (sin inventario de cocina)'}`);
    L.push(`Gastos operativos: ${fmt(r.gastosOp)}`, `UTILIDAD ESTIMADA: ${fmt(r.utilidad)}`);
    if (co.sinInventario) L.push(`⚠️ Terminado sin inventario de cocina: ${co.motivo}`);
  }
  if (r.anulaciones) L.push(`⚠️ Anulaciones en el turno: ${r.anulaciones}`);
  if (final) {
    if ((r.preparar || []).length) L.push('', `🍲 PREPARAR MAÑANA: ${r.preparar.join(', ')}`);
    const comp = r.bebidas.concat(r.utensilios, r.cocinaCerrada ? r.insumos : []).filter((x: any) => x.comprar > 0);
    L.push('', '🛒 COMPRAR PARA MAÑANA');
    // Si hay en el almacén del dueño, se saca de ahí y solo se compra lo que falte
    if (comp.length) comp.forEach((x: any) => L.push(x.sacar
      ? `• ${q(x.comprar)} ${x.unidad} de ${x.nombre}: en el almacén hay ${q(x.almacen)}, saca ${q(x.sacar)}${x.comprar - x.sacar > 0 ? ` y compra ${q(Math.round((x.comprar - x.sacar) * 1000) / 1000)}` : ' (no hay que comprar)'}`
      : `• ${q(x.comprar)} ${x.unidad} de ${x.nombre}`));
    else L.push('✅ Todo sobre el stock sugerido');
    if (extra.almacen) {
      L.push('', `📦 ALMACÉN: avalúo ${fmt(extra.almacen.total)}`);
      extra.almacen.bajos.forEach((x) => L.push(`• ⚠️ ${x.nombre}: quedan ${q(x.cantidad)} ${x.unidad} (mínimo ${q(x.minimo)})`));
    }
    if (extra.semana) L.push('', `📅 SEMANA (desde el martes ${extra.semana.desde}): ${extra.semana.turnos} turnos, ventas ${fmt(extra.semana.ventas)}, utilidad ${fmt(extra.semana.utilidad)}`);
  }
  L.push('', `👥 ${r.personal.map((p: any) => `${p.nombre} (${p.area})`).join(', ')}`);
  if (ci.obs) L.push('', `📝 Caja: ${ci.obs}`);
  if (final && co.obs) L.push(`📝 Cocina: ${co.obs}`);
  return L.join('\n');
}

export async function leerDestinos(db: PoolClient): Promise<{ negocio: string; destinos: Destinos }> {
  const n = (await db.query('SELECT nombre, config FROM tenants')).rows[0];
  return { negocio: n.nombre, destinos: (n.config && n.config.avisos) || {} };
}

type Resultado = 'enviado' | 'no configurado' | string;
/** Envía el texto por los canales configurados. Nunca lanza error: devuelve qué pasó con cada uno. */
export async function enviarATodos(d: Destinos, asunto: string, texto: string): Promise<{ telegram: Resultado; correo: Resultado }> {
  const uno = async (listo: boolean, fn: () => Promise<void>): Promise<Resultado> => {
    if (!listo) return 'no configurado';
    try { await fn(); return 'enviado'; } catch (e) { console.error('Aviso no enviado:', e instanceof Error ? e.message : e); return 'error'; }
  };
  const [telegramR, correoR] = await Promise.all([
    uno(telegramDisponible() && !!d.telegramChatId, () => enviarTelegram(d.telegramChatId!, texto)),
    uno(correoDisponible() && !!d.correo, () => enviarCorreo(d.correo!, asunto, texto))
  ]);
  return { telegram: telegramR, correo: correoR };
}

/** Reporte de apertura de caja (antes se mandaba por WhatsApp desde el equipo de la encargada). */
export function textoApertura(negocio: string, t: any, abrio: string, cuentas: string[], items: Record<string, string>, personal: string[]): string {
  const a = t.apertura || {}, L: string[] = [];
  const cc = a.cocina;
  L.push(`🟢 APERTURA DE CAJA · ${negocio.toUpperCase()}`);
  L.push(`📅 ${fechaLarga(new Date(t.caja_abierta_en || t.abierto_en))}, ${hora(new Date(t.caja_abierta_en || t.abierto_en))}`);
  L.push(`👤 Abre la caja: ${abrio}${cc ? ` (cocina abrió a las ${hora(new Date(cc.en))}, ${cc.por})` : ''}`);
  L.push(`👥 Personal: ${personal.join(', ')}`, '', '💵 Saldos al abrir');
  cuentas.forEach((c) => {
    const dif = ((a.saldosContados || {})[c] || 0) - ((a.saldosSistema || {})[c] || 0);
    L.push(`• ${c}: ${fmt((a.saldosContados || {})[c] || 0)}${dif ? ` ⚠️ dif. ${dif > 0 ? '+' : ''}${fmt(dif)}` : ''}`);
  });
  const difs = ['bebidas', 'utensilios'].flatMap((g) => Object.entries(((a.difInv || {})[g] || {}) as Record<string, number>)
    .map(([id, d]) => `• ${items[id] || 'Producto'}: ${d > 0 ? '+' : ''}${q(d)} frente al sistema`));
  L.push('', difs.length ? '⚠️ Diferencias en el conteo de bebidas y utensilios' : '✅ Bebidas y utensilios cuadran con el sistema');
  difs.forEach((x) => L.push(x));
  if (a.nota) L.push('', `📝 ${a.nota}`);
  return L.join('\n');
}

export async function avisarApertura(tenantId: string, turnoId: string) {
  try {
    const { negocio, destinos, texto, fecha } = await conNegocio(tenantId, async (db) => {
      const t = (await db.query('SELECT s.*, u.nombre AS abrio FROM shifts s JOIN users u ON u.id = s.caja_abierta_por WHERE s.id = $1', [turnoId])).rows[0];
      const { negocio, destinos } = await leerDestinos(db);
      const cuentas = (await db.query('SELECT nombre FROM accounts WHERE activo ORDER BY orden, nombre')).rows.map((x) => x.nombre);
      const items = Object.fromEntries((await db.query('SELECT id, nombre FROM inventory_items')).rows.map((x) => [x.id, x.nombre]));
      const personal = (await db.query('SELECT nombre, area FROM shift_staff WHERE shift_id = $1 ORDER BY nombre', [turnoId])).rows.map((p) => `${p.nombre} (${p.area})`);
      return { negocio, destinos, texto: textoApertura(negocio, t, t.abrio, cuentas, items, personal), fecha: fechaLarga(new Date(t.abierto_en)) };
    });
    return await enviarATodos(destinos, `Apertura de caja · ${negocio} · ${fecha}`, texto);
  } catch (e) {
    console.error('No se pudo preparar el aviso de apertura:', e instanceof Error ? e.message : e);
    return { telegram: 'error', correo: 'error' };
  }
}

/**
 * Aviso del cierre. Se llama DESPUÉS de guardar el cierre (fuera de la transacción), para que un
 * problema con Telegram o el correo nunca impida cerrar.
 *   final = false → la encargada cerró la caja (aviso corto; la utilidad llega después)
 *   final = true  → el turno terminó (cocina hizo el último cierre): reporte completo con la utilidad
 */
export async function avisarCierre(tenantId: string, turnoId: string, final: boolean) {
  try {
    const { negocio, destinos, texto, fecha } = await conNegocio(tenantId, async (db) => {
      const t = (await db.query('SELECT s.*, u.nombre AS abrio FROM shifts s JOIN users u ON u.id = s.abierto_por WHERE s.id = $1', [turnoId])).rows[0];
      const { negocio, destinos } = await leerDestinos(db);
      const cuentas = (await db.query('SELECT nombre FROM accounts WHERE activo ORDER BY orden, nombre')).rows.map((x) => x.nombre);
      const extra: Extra = {};
      if (final) {
        const a = await avaluoAlmacen(db);
        if (a.total || a.bajos.length) extra.almacen = { total: a.total, bajos: a.bajos };
        // La semana del negocio va de martes a lunes (el lunes se cierra la semana)
        const s = (await db.query(
          `WITH d AS (SELECT $1::date - ((extract(isodow FROM $1::date)::int + 5) % 7) AS martes)
           SELECT to_char(d.martes, 'DD/MM') AS desde, count(*) AS turnos, coalesce(sum((resumen->>'ventas')::bigint), 0) AS ventas,
                  coalesce(sum((resumen->>'utilidad')::numeric), 0) AS utilidad
           FROM shifts, d WHERE cerrado_en IS NOT NULL AND dia BETWEEN d.martes AND $1::date GROUP BY d.martes`, [t.dia])).rows[0];
        if (s) extra.semana = { desde: s.desde, turnos: Number(s.turnos), ventas: Number(s.ventas), utilidad: Number(s.utilidad) };
      }
      return { negocio, destinos, texto: textoReporte(negocio, t, t.abrio, final, cuentas, extra), fecha: fechaLarga(new Date(t.abierto_en)) };
    });
    return await enviarATodos(destinos, `${final ? 'Resultado del día' : 'Cierre de caja'} · ${negocio} · ${fecha}`, texto);
  } catch (e) {
    console.error('No se pudo preparar el aviso del cierre:', e instanceof Error ? e.message : e);
    return { telegram: 'error', correo: 'error' };
  }
}
