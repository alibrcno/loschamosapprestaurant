// Pruebas de la API contra un Postgres LOCAL (ver pruebas/correr.sh). Nunca contra Neon.
// Llaman a las rutas igual que lo haría Vercel: con un Request y esperando un Response.
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import * as equipo from '../api/_rutas/equipo';
import * as instalar from '../api/_rutas/auth/instalar';
import * as login from '../api/_rutas/auth/login';
import * as logout from '../api/_rutas/auth/logout';
import * as yo from '../api/_rutas/auth/yo';
import { cerrarConexiones } from '../api/_lib/db';
import { pesos } from '../api/_lib/http';
import * as salud from '../api/_rutas/salud';
import * as usuarios from '../api/_rutas/usuarios';

type Ruta = (req: Request) => Promise<Response>;
const URL_BASE = 'https://loschamos.test/api';

async function llamar(fn: Ruta, metodo: string, cuerpo?: unknown, cookie?: string) {
  const headers: Record<string, string> = {};
  if (cuerpo !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fn(new Request(URL_BASE, { method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) }));
  const setCookie = res.headers.get('set-cookie') || '';
  return { status: res.status, datos: (await res.json()) as any, cookie: setCookie.split(';')[0], setCookie };
}
const entrar = (usuario: string, clave: string, codigo = 'loschamos') => llamar(login.POST, 'POST', { codigo, usuario, clave });

after(cerrarConexiones);

describe('API: ingreso, sesiones y usuarios', () => {
  let admin = '', mesera = '', idMesera = '';

  test('La API llega a la base de datos', async () => {
    const r = await llamar(salud.GET, 'GET');
    assert.equal(r.status, 200);
    assert.equal(r.datos.baseDeDatos, 'conectada');
  });

  test('Instalar el primer administrador exige la clave de instalación', async () => {
    delete process.env.CLAVE_INSTALACION;
    const datos = { codigo: 'loschamos', claveInstalacion: 'x', nombre: 'Ali', usuario: 'ali', clave: 'clave-segura-1' };
    assert.equal((await llamar(instalar.POST, 'POST', datos)).status, 503, 'sin variable configurada no se puede instalar');
    process.env.CLAVE_INSTALACION = 'frase-de-instalacion-larga';
    assert.equal((await llamar(instalar.POST, 'POST', datos)).status, 403, 'con clave equivocada no se puede');
    const r = await llamar(instalar.POST, 'POST', { ...datos, claveInstalacion: 'frase-de-instalacion-larga' });
    assert.equal(r.status, 201);
    assert.match(r.setCookie, /HttpOnly; Secure; SameSite=Lax/, 'la cookie no es legible desde JavaScript y solo viaja por HTTPS');
    admin = r.cookie;
    const otra = await llamar(instalar.POST, 'POST', { ...datos, usuario: 'intruso', claveInstalacion: 'frase-de-instalacion-larga' });
    assert.equal(otra.status, 409, 'no se puede instalar dos veces');
  });

  test('"¿Quién soy?" responde con el usuario y su negocio', async () => {
    const r = await llamar(yo.GET, 'GET', undefined, admin);
    assert.equal(r.status, 200);
    assert.equal(r.datos.usuario.rol, 'admin');
    assert.equal(r.datos.negocio.codigo, 'loschamos');
  });

  test('El administrador crea a la mesera con una clave sencilla', async () => {
    const corta = await llamar(usuarios.POST, 'POST', { nombre: 'María', usuario: 'maria', clave: '123', rol: 'mesera' }, admin);
    assert.equal(corta.status, 400, 'menos de 4 caracteres no se acepta');
    const r = await llamar(usuarios.POST, 'POST', { nombre: 'María', usuario: 'Maria', clave: '1234', rol: 'mesera' }, admin);
    assert.equal(r.status, 201);
    assert.deepEqual(r.datos.usuario.permisos, ['pos.tomar', 'pos.precuenta'], 'toma los permisos del rol');
    assert.equal(r.datos.usuario.usuario, 'maria');
    assert.equal(r.datos.usuario.password_hash, undefined, 'nunca se devuelve el hash de la clave');
    idMesera = r.datos.usuario.id;
    const dup = await llamar(usuarios.POST, 'POST', { nombre: 'Otra', usuario: 'maria', clave: '9999', rol: 'mesera' }, admin);
    assert.equal(dup.status, 409);
    const adminDebil = await llamar(usuarios.POST, 'POST', { nombre: 'Jefe', usuario: 'jefe', clave: '1234', rol: 'admin' }, admin);
    assert.equal(adminDebil.status, 400, 'un administrador necesita al menos 8 caracteres');
  });

  test('La mesera ingresa con código de negocio, usuario y clave', async () => {
    const malCodigo = await entrar('maria', '1234', 'otro-negocio');
    const malaClave = await entrar('maria', '9999');
    assert.equal(malCodigo.status, 401);
    assert.equal(malaClave.datos.error, malCodigo.datos.error, 'el mensaje no revela qué dato estaba mal');
    const r = await entrar('  MARIA ', '1234');
    assert.equal(r.status, 200);
    mesera = r.cookie;
  });

  test('Los permisos se revisan en el servidor', async () => {
    const r = await llamar(usuarios.GET, 'GET', undefined, mesera);
    assert.equal(r.status, 403, 'la mesera no puede ver usuarios');
    const c = await llamar(usuarios.POST, 'POST', { nombre: 'X', usuario: 'xx1', clave: '1234', rol: 'admin' }, mesera);
    assert.equal(c.status, 403, 'la mesera no puede crear usuarios');
    assert.equal((await llamar(usuarios.GET, 'GET')).status, 401, 'sin sesión no hay acceso');
  });

  test('Una sesión no sirve en otro negocio aunque se cambie la cookie', async () => {
    // El atacante reemplaza el id del negocio en su cookie por el de otro negocio
    const otroNegocio = '00000000-0000-4000-8000-000000000000';
    const falsa = mesera.replace(/lc_sesion=[^.]+/, 'lc_sesion=' + otroNegocio);
    assert.notEqual(falsa, mesera);
    assert.equal((await llamar(yo.GET, 'GET', undefined, falsa)).status, 401);
    assert.equal((await llamar(yo.GET, 'GET', undefined, 'lc_sesion=basura')).status, 401);
  });

  test('Solo acepta JSON (protección contra formularios de otras páginas)', async () => {
    const res = await login.POST(new Request(URL_BASE, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'codigo=loschamos' }));
    assert.equal(res.status, 415);
  });

  test('Tras 5 claves erradas el usuario se bloquea; el administrador lo desbloquea con clave nueva', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await entrar('maria', 'nop' + i)).status, 401);
    const bloqueada = await entrar('maria', '1234');
    assert.equal(bloqueada.status, 429, 'aunque ahora ponga la clave correcta, está bloqueada');
    assert.equal((await llamar(yo.GET, 'GET', undefined, mesera)).status, 200, 'el bloqueo frena nuevos ingresos; su sesión abierta sigue');
    const r = await llamar(usuarios.PATCH, 'PATCH', { id: idMesera, clave: '4321' }, admin);
    assert.equal(r.status, 200);
    assert.equal(r.datos.usuario.bloqueado, false);
    assert.equal((await llamar(yo.GET, 'GET', undefined, mesera)).status, 401, 'la clave nueva cierra sus sesiones anteriores');
    const ok = await entrar('maria', '4321');
    assert.equal(ok.status, 200);
    mesera = ok.cookie;
  });

  test('Una encargada no puede crear administradores ni dar permisos que no tiene', async () => {
    const e = await llamar(usuarios.POST, 'POST', { nombre: 'Encargada', usuario: 'enc', clave: '1234', rol: 'encargada', permisos: ['pos.cobrar', 'usuarios.gestionar'] }, admin);
    assert.equal(e.status, 201);
    const enc = (await entrar('enc', '1234')).cookie;
    const a = await llamar(usuarios.POST, 'POST', { nombre: 'Yo admin', usuario: 'yoadmin', clave: '12345678', rol: 'admin' }, enc);
    assert.equal(a.status, 403);
    const p = await llamar(usuarios.PATCH, 'PATCH', { id: idMesera, permisos: ['pos.tomar', 'reportes.ver'] }, enc);
    assert.equal(p.status, 403, 'no puede dar reportes.ver porque ella no lo tiene');
    const quitarAdmin = await llamar(usuarios.PATCH, 'PATCH', { id: e.datos.usuario.id, rol: 'admin' }, enc);
    assert.equal(quitarAdmin.status, 403, 'no puede hacerse administradora a sí misma');
  });

  test('Siempre queda al menos un administrador activo', async () => {
    const lista = await llamar(usuarios.GET, 'GET', undefined, admin);
    const yoAdmin = lista.datos.usuarios.find((u: any) => u.rol === 'admin');
    const r = await llamar(usuarios.PATCH, 'PATCH', { id: yoAdmin.id, rol: 'mesera' }, admin);
    assert.equal(r.status, 400);
    assert.equal((await llamar(yo.GET, 'GET', undefined, admin)).datos.usuario.rol, 'admin', 'el cambio se deshizo');
  });

  test('El personal para la apertura muestra solo nombres y exige permiso de caja', async () => {
    const r = await llamar(equipo.GET, 'GET', undefined, admin);
    assert.equal(r.status, 200);
    assert.ok(r.datos.equipo.some((u: any) => u.nombre === 'María'));
    assert.deepEqual(Object.keys(r.datos.equipo[0]).sort(), ['id', 'nombre', 'rol'], 'no expone usuario, permisos ni claves');
    assert.equal((await llamar(equipo.GET, 'GET', undefined, mesera)).status, 403, 'la mesera no abre caja');
  });

  test('Desactivar a alguien lo saca de todos sus equipos', async () => {
    assert.equal((await llamar(usuarios.PATCH, 'PATCH', { id: idMesera, activo: false }, admin)).status, 200);
    assert.equal((await llamar(yo.GET, 'GET', undefined, mesera)).status, 401);
    assert.equal((await entrar('maria', '4321')).status, 401);
  });

  test('Salir cierra la sesión en el servidor', async () => {
    const r = await llamar(logout.POST, 'POST', undefined, admin);
    assert.match(r.setCookie, /Max-Age=0/);
    assert.equal((await llamar(yo.GET, 'GET', undefined, admin)).status, 401, 'la cookie vieja ya no sirve');
  });
});

describe('API: dinero solo en pesos enteros', () => {
  test('Rechaza decimales, textos y negativos', () => {
    assert.equal(pesos(50000, 'El valor'), 50000);
    assert.throws(() => pesos(1000.5, 'El valor'), /sin decimales/);
    assert.throws(() => pesos('50000', 'El valor'), /sin decimales/);
    assert.throws(() => pesos(-1, 'El valor'), /mayor o igual/);
    assert.throws(() => pesos(Number.MAX_SAFE_INTEGER + 2, 'El valor'), /sin decimales/);
  });
});
