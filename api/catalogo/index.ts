// GET /api/catalogo  → menú, pizzas, inventario y datos del negocio.
// Lo necesita cualquier usuario conectado (la mesera para tomar pedidos, la cocina para su inventario).
import { conUsuario } from '../_lib/auth';
import { catalogoVacio, leerCatalogo } from '../_lib/catalogo';
import { json, ruta } from '../_lib/http';

export const GET = ruta(async (req) =>
  json(await conUsuario(req, null, async (db) => ({ ...(await leerCatalogo(db)), vacio: await catalogoVacio(db) })))
);
