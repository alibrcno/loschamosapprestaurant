// ÚNICA función de la API en Vercel. Recibe todas las peticiones /api/... y las reparte.
// El plan Hobby de Vercel permite máximo 12 funciones por publicación; con una sola nunca
// llegamos al límite. Cada ruta vive en api/_rutas/ (Vercel no publica lo que empieza con "_").
// vercel.json manda /api/<ruta> a esta función como /api/index?ruta=<ruta>.
import { ErrorApi, json } from './_lib/http';
import * as instalar from './_rutas/auth/instalar';
import * as login from './_rutas/auth/login';
import * as logout from './_rutas/auth/logout';
import * as yo from './_rutas/auth/yo';
import * as catalogo from './_rutas/catalogo/index';
import * as categorias from './_rutas/catalogo/categorias';
import * as importar from './_rutas/catalogo/importar';
import * as inventario from './_rutas/catalogo/inventario';
import * as negocio from './_rutas/catalogo/negocio';
import * as pizzas from './_rutas/catalogo/pizzas';
import * as preparaciones from './_rutas/catalogo/preparaciones';
import * as productos from './_rutas/catalogo/productos';
import * as almacen from './_rutas/almacen';
import * as auditoria from './_rutas/auditoria';
import * as avisos from './_rutas/avisos';
import * as equipo from './_rutas/equipo';
import * as impresion from './_rutas/impresion';
import * as pedidos from './_rutas/pedidos';
import * as salud from './_rutas/salud';
import * as turnoAbrir from './_rutas/turno/abrir';
import * as turnoAbrirCocina from './_rutas/turno/abrir-cocina';
import * as turnoAjuste from './_rutas/turno/ajuste';
import * as turnoCerrarCaja from './_rutas/turno/cerrar-caja';
import * as turnoCerrarCocina from './_rutas/turno/cerrar-cocina';
import * as turnoEstado from './_rutas/turno/estado';
import * as turnoLlegada from './_rutas/turno/llegada';
import * as turnoMovimiento from './_rutas/turno/movimiento';
import * as turnoSinCocina from './_rutas/turno/terminar-sin-cocina';
import * as turnoTraslado from './_rutas/turno/traslado';
import * as usuarios from './_rutas/usuarios';

type Manejador = (req: Request) => Promise<Response>;
type Modulo = Partial<Record<'GET' | 'POST' | 'PATCH' | 'DELETE', Manejador>>;

/** Dirección → archivo que la atiende. Al crear una ruta nueva, se agrega aquí. */
export const RUTAS: Record<string, Modulo> = {
  'auth/instalar': instalar,
  'auth/login': login,
  'auth/logout': logout,
  'auth/yo': yo,
  catalogo,
  'catalogo/categorias': categorias,
  'catalogo/importar': importar,
  'catalogo/inventario': inventario,
  'catalogo/negocio': negocio,
  'catalogo/pizzas': pizzas,
  'catalogo/preparaciones': preparaciones,
  'catalogo/productos': productos,
  almacen,
  auditoria,
  avisos,
  equipo,
  impresion,
  pedidos,
  salud,
  turno: turnoEstado,
  'turno/abrir': turnoAbrir,
  'turno/abrir-cocina': turnoAbrirCocina,
  'turno/ajuste': turnoAjuste,
  'turno/cerrar-caja': turnoCerrarCaja,
  'turno/cerrar-cocina': turnoCerrarCocina,
  'turno/llegada': turnoLlegada,
  'turno/movimiento': turnoMovimiento,
  'turno/terminar-sin-cocina': turnoSinCocina,
  'turno/traslado': turnoTraslado,
  usuarios
};

/** "/api/catalogo/productos" o "/api/index?ruta=catalogo/productos" → "catalogo/productos" */
export function nombreRuta(url: string): string {
  const u = new URL(url);
  let r = u.pathname.replace(/^\/api\/?/, '');
  if (r === '' || r === 'index') r = u.searchParams.get('ruta') || '';
  return r.replace(/^\/+|\/+$/g, '');
}

async function despachar(req: Request): Promise<Response> {
  const modulo = RUTAS[nombreRuta(req.url)];
  if (!modulo) return json({ error: 'Esa dirección de la API no existe' }, 404);
  const fn = modulo[req.method as keyof Modulo];
  if (!fn) return json({ error: 'Método no permitido' }, 405, { allow: Object.keys(modulo).join(', ') });
  try {
    return await fn(req);
  } catch (e) {
    // Cada ruta ya maneja sus errores; esto es una red de seguridad
    if (e instanceof ErrorApi) return json({ error: e.message }, e.status);
    console.error('Error interno:', e instanceof Error ? e.message : e);
    return json({ error: 'Error interno. Intenta de nuevo.' }, 500);
  }
}

export const GET = despachar;
export const POST = despachar;
export const PATCH = despachar;
export const DELETE = despachar;
