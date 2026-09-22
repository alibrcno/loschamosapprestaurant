// GET /api/salud  → confirma que la API está publicada y que llega a la base de datos.
// No muestra ningún detalle de la conexión.
import { probarConexion } from './_lib/db';
import { json, ruta } from './_lib/http';

export const GET = ruta(async () => {
  try {
    await probarConexion();
    return json({ ok: true, baseDeDatos: 'conectada' });
  } catch (e) {
    console.error('Salud: sin conexión a la base:', e instanceof Error ? e.message : e);
    return json({ ok: false, baseDeDatos: 'sin conexión' }, 503);
  }
});
