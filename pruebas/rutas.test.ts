// Pruebas de la función única de la API (api/index.ts) y del límite de funciones de Vercel.
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import * as api from '../api/index';
import { cerrarConexiones } from '../api/_lib/db';

after(cerrarConexiones);
const RAIZ = join(__dirname, '..', '..');

/** Archivos que Vercel convierte en funciones: .ts dentro de api/ que no empiezan con "_" (ni sus carpetas). */
function funcionesPublicadas(dir = join(RAIZ, 'api')): string[] {
  return readdirSync(dir).flatMap((f) => {
    if (f.startsWith('_') || f.startsWith('.')) return [];
    const p = join(dir, f);
    return statSync(p).isDirectory() ? funcionesPublicadas(p) : f.endsWith('.ts') ? [p] : [];
  });
}

describe('API: función única', () => {
  test('Vercel publica una sola función (el plan Hobby permite máximo 12)', () => {
    assert.deepEqual(funcionesPublicadas().map((f) => f.slice(RAIZ.length + 1)), ['api/index.ts']);
  });

  test('Entiende la dirección original y la que llega por vercel.json', () => {
    assert.equal(api.nombreRuta('https://x.app/api/catalogo/productos'), 'catalogo/productos');
    assert.equal(api.nombreRuta('https://x.app/api/index?ruta=catalogo/productos'), 'catalogo/productos');
    assert.equal(api.nombreRuta('https://x.app/api/index?ruta=auth%2Flogin'), 'auth/login');
    assert.equal(api.nombreRuta('https://x.app/api/salud/'), 'salud');
  });

  test('Cada ruta registrada tiene al menos un método', () => {
    for (const [nombre, m] of Object.entries(api.RUTAS)) {
      assert.ok(['GET', 'POST', 'PATCH', 'DELETE'].some((k) => typeof (m as any)[k] === 'function'), nombre);
    }
  });

  test('Reparte las peticiones y responde 404 y 405 en español', async () => {
    const salud = await api.GET(new Request('https://x.app/api/index?ruta=salud'));
    assert.equal(salud.status, 200);
    assert.equal(((await salud.json()) as any).baseDeDatos, 'conectada');
    const no = await api.GET(new Request('https://x.app/api/index?ruta=no-existe'));
    assert.equal(no.status, 404);
    assert.match(((await no.json()) as any).error, /no existe/);
    const metodo = await api.DELETE(new Request('https://x.app/api/salud', { method: 'DELETE' }));
    assert.equal(metodo.status, 405);
    const sinSesion = await api.GET(new Request('https://x.app/api/index?ruta=usuarios'));
    assert.equal(sinSesion.status, 401, 'las rutas protegidas siguen exigiendo sesión');
  });
});
