// Pruebas de los avisos del cierre (Telegram y correo) con servidores FALSOS locales que
// imitan a Telegram y a Resend: nunca se escribe a Telegram ni se envían correos de verdad.
// Negocio de prueba: "chamos-e".
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import * as api from '../api/index';
import { cerrarConexiones } from '../api/_lib/db';

// ---------- Telegram y Resend de mentira ----------
const recibidos: { canal: string; datos: any }[] = [];
let falla = false, codigoEnTelegram = '';
let falso: Server;
before(async () => {
  falso = createServer((req, res) => {
    let cuerpo = '';
    req.on('data', (c) => (cuerpo += c));
    req.on('end', () => {
      const datos = cuerpo ? JSON.parse(cuerpo) : {};
      const responder = (status: number, j: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (falla) return responder(500, { ok: false, description: 'caído' });
      if (req.url!.endsWith('/getMe')) return responder(200, { ok: true, result: { username: 'LosChamosBot' } });
      if (req.url!.endsWith('/getUpdates')) return responder(200, { ok: true, result: [{ update_id: 1, message: { text: codigoEnTelegram.endsWith(' ') ? codigoEnTelegram : `/start ${codigoEnTelegram}`, chat: { id: 987654 } } }] });
      if (req.url!.endsWith('/sendMessage')) { recibidos.push({ canal: 'telegram', datos }); return responder(200, { ok: true, result: {} }); }
      if (req.url === '/emails') {
        assert.equal(req.headers.authorization, 'Bearer clave-resend-prueba');
        recibidos.push({ canal: 'correo', datos }); return responder(200, { id: 'x' });
      }
      responder(404, { ok: false });
    });
  });
  await new Promise<void>((ok) => falso.listen(0, ok));
  const url = `http://127.0.0.1:${(falso.address() as AddressInfo).port}`;
  Object.assign(process.env, {
    TELEGRAM_BOT_TOKEN: 'token-prueba', TELEGRAM_API_URL: url, RESEND_API_KEY: 'clave-resend-prueba', RESEND_API_URL: url,
    CLAVE_INSTALACION: 'frase-de-instalacion-larga'
  });
});
after(async () => {
  for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_API_URL', 'RESEND_API_KEY', 'RESEND_API_URL']) delete process.env[k];
  falso.close();
  await cerrarConexiones();
});

async function llamar(ruta: string, metodo: string, cuerpo?: unknown, cookie?: string) {
  const headers: Record<string, string> = {};
  if (cuerpo !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await ((api as any)[metodo] as (r: Request) => Promise<Response>)(new Request('https://x.app/api/' + ruta, { method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) }));
  return { status: res.status, datos: (await res.json()) as any, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

describe('Avisos del cierre por Telegram y correo', () => {
  let admin = '', enc = '', cocina = '', ids: any = {};
  const saldos = { Efectivo: 0, Nequi: 0, Bancolombia: 0, 'Datáfono': 0 };

  test('Preparar el negocio', async () => {
    admin = (await llamar('auth/instalar', 'POST', { codigo: 'chamos-e', claveInstalacion: 'frase-de-instalacion-larga', nombre: 'Dueño E', usuario: 'duenoe', clave: 'clave-segura-e' })).cookie;
    await llamar('usuarios', 'POST', { nombre: 'Encargada E', usuario: 'ence', clave: '1234', rol: 'encargada' }, admin);
    await llamar('usuarios', 'POST', { nombre: 'Cocina E', usuario: 'cocie', clave: '1234', rol: 'cocina' }, admin);
    enc = (await llamar('auth/login', 'POST', { codigo: 'chamos-e', usuario: 'ence', clave: '1234' })).cookie;
    cocina = (await llamar('auth/login', 'POST', { codigo: 'chamos-e', usuario: 'cocie', clave: '1234' })).cookie;
    ids = (await llamar('catalogo/importar', 'POST', {
      bebidas: [{ id: 'c', nombre: 'Coca-Cola', unidad: 'und', precio: 4000, costo: 2600, sugerido: 24, stock: 10 }],
      utensilios: [], insumos: [{ id: 'q', nombre: 'Queso', unidad: 'kg', costo: 20000, sugerido: 5, stock: 2 }]
    }, admin)).datos.ids;
  });

  test('Solo quien ve reportes configura los avisos', async () => {
    assert.equal((await llamar('avisos', 'GET', undefined, enc)).status, 403);
    const r = await llamar('avisos', 'GET', undefined, admin);
    assert.deepEqual(r.datos, { telegram: { disponible: true, bot: 'LosChamosBot', problema: null, conectado: false }, correo: { disponible: true, correo: '' } });
  });

  test('Si el token de Telegram está mal copiado, lo dice claro', async () => {
    const bueno = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = ' "token-prueba" ';
    assert.equal((await llamar('avisos', 'GET', undefined, admin)).datos.telegram.bot, 'LosChamosBot', 'se ignoran espacios y comillas al copiar');
    falla = true;
    const r = await llamar('avisos', 'POST', { accion: 'telegram-codigo' }, admin);
    falla = false;
    process.env.TELEGRAM_BOT_TOKEN = bueno;
    assert.equal(r.status, 503);
    assert.match(r.datos.error, /No se pudo hablar con Telegram/);
  });

  test('Conectar Telegram con un enlace y el botón Iniciar', async () => {
    const r = await llamar('avisos', 'POST', { accion: 'telegram-codigo' }, admin);
    assert.match(r.datos.enlace, /^https:\/\/t\.me\/LosChamosBot\?start=[0-9a-f]{12}$/);
    codigoEnTelegram = 'otro-codigo';
    assert.equal((await llamar('avisos', 'POST', { accion: 'telegram-confirmar' }, admin)).status, 409, 'sin el mensaje correcto no conecta');
    codigoEnTelegram = r.datos.enlace.split('start=')[1] + ' ';  // escrito a mano, con un espacio de más
    const ok = await llamar('avisos', 'POST', { accion: 'telegram-confirmar' }, admin);
    assert.equal(ok.datos.telegram.conectado, true);
    assert.match(recibidos.pop()!.datos.text, /Aquí te llegarán los cierres de Chamos E/);
  });

  test('Guardar el correo y enviar una prueba', async () => {
    assert.equal((await llamar('avisos', 'POST', { accion: 'correo', correo: 'no-es-correo' }, admin)).status, 400);
    assert.equal((await llamar('avisos', 'POST', { accion: 'correo', correo: 'Dueno@Ejemplo.com' }, admin)).datos.correo.correo, 'dueno@ejemplo.com');
    recibidos.length = 0;
    const p = await llamar('avisos', 'POST', { accion: 'probar' }, admin);
    assert.deepEqual(p.datos.prueba, { telegram: 'enviado', correo: 'enviado' });
    assert.deepEqual(recibidos.map((x) => x.canal).sort(), ['correo', 'telegram']);
    assert.equal(recibidos.find((x) => x.canal === 'telegram')!.datos.chat_id, '987654');
  });

  test('Al cerrar la caja llega el aviso; al cerrar cocina llega el resultado con la utilidad', async () => {
    recibidos.length = 0;
    const ab = await llamar('turno/abrir', 'POST', { personal: [{ nombre: 'Cocina E', area: 'Cocina' }], bebidas: { [ids.c]: 10 }, utensilios: {}, saldos }, enc);
    assert.deepEqual(ab.datos.avisos, { telegram: 'enviado', correo: 'enviado' }, 'la apertura ya no va por WhatsApp: la envía el servidor');
    assert.match(recibidos.find((x) => x.canal === 'telegram')!.datos.text, /APERTURA DE CAJA · CHAMOS E[\s\S]*Personal: Cocina E \(Cocina\)/);
    const o = (await llamar('pedidos', 'POST', { accion: 'enviar', lote: randomUUID(), nueva: { tipo: 'mesa', mesa: 1 }, lineas: [{ tipo: 'bebida', id: ids.c, qty: 2 }] }, enc)).datos.orden;
    await llamar('pedidos', 'POST', { accion: 'cobrar', orden: o.id, total: 8000, pagos: [{ cuenta: 'Efectivo', monto: 8000 }] }, enc);
    recibidos.length = 0;
    const caja = await llamar('turno/cerrar-caja', 'POST', { bebidas: { [ids.c]: 8 }, utensilios: {}, saldos: { ...saldos, Efectivo: 8000 } }, enc);
    assert.equal(caja.status, 201);
    assert.deepEqual(caja.datos.avisos, { telegram: 'enviado', correo: 'enviado' });
    assert.equal(caja.datos.tenantId, undefined, 'no se devuelven datos internos');
    const tg1 = recibidos.find((x) => x.canal === 'telegram')!.datos.text as string;
    assert.match(tg1, /CIERRE DE CAJA · CHAMOS E/);
    assert.match(tg1, /VENTAS: \$8\.000/);
    assert.match(tg1, /Se calcula cuando cocina haga su inventario/);
    assert.match(recibidos.find((x) => x.canal === 'correo')!.datos.subject, /^Cierre de caja · Chamos E/);

    recibidos.length = 0;
    const coc = await llamar('turno/cerrar-cocina', 'POST', { conteo: { [ids.q]: 1.5 } }, cocina);
    assert.equal(coc.status, 201);
    assert.equal(coc.datos.termino, true);
    const tg2 = recibidos.find((x) => x.canal === 'telegram')!.datos.text as string;
    // 8.000 − 2 Coca-Cola × 2.600 − 0,5 kg de queso × 20.000 = −7.200
    assert.match(tg2, /RESULTADO DEL DÍA · CHAMOS E/);
    assert.match(tg2, /UTILIDAD ESTIMADA: -\$7\.200/);
    assert.match(tg2, /inventario de cocina Cocina E/);
    assert.match(tg2, /SEMANA \(desde el martes \d\d\/\d\d\): 1 turnos, ventas \$8\.000/, 'el reporte final trae cómo va la semana');
    assert.match(recibidos.find((x) => x.canal === 'correo')!.datos.subject, /^Resultado del día · Chamos E/);
  });

  test('Si Telegram y el correo están caídos, el cierre se guarda igual', async () => {
    await llamar('turno/abrir', 'POST', { personal: [{ nombre: 'Cocina E', area: 'Cocina' }], bebidas: { [ids.c]: 8 }, utensilios: {}, saldos: { ...saldos, Efectivo: 8000 } }, enc);
    falla = true;
    const caja = await llamar('turno/cerrar-caja', 'POST', { bebidas: { [ids.c]: 8 }, utensilios: {}, saldos: { ...saldos, Efectivo: 8000 } }, enc);
    falla = false;
    assert.equal(caja.status, 201, 'la caja se cerró');
    assert.deepEqual(caja.datos.avisos, { telegram: 'error', correo: 'error' });
    const t = caja.datos.turnos.find((x: any) => x.id === caja.datos.turnoId);
    assert.equal(t.cajaCerrada, true);
  });
});
