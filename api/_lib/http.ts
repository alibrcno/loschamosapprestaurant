// Utilidades HTTP compartidas por todas las rutas de la API.
// Los archivos de api/_lib no se publican como rutas (Vercel ignora lo que empieza con "_").

/** Error que se le muestra al usuario tal cual, con su código HTTP. */
export class ErrorApi extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function json(datos: unknown, status = 200, cabeceras: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(datos), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cabeceras }
  });
}

/** Envuelve una ruta: los ErrorApi se responden con su mensaje; cualquier otro error es 500 sin detalles. */
export function ruta(fn: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    try {
      return await fn(req);
    } catch (e) {
      if (e instanceof ErrorApi) return json({ error: e.message }, e.status);
      console.error('Error interno:', e instanceof Error ? e.message : e);
      return json({ error: 'Error interno. Intenta de nuevo.' }, 500);
    }
  };
}

/**
 * Lee el cuerpo JSON. Exige content-type application/json: un formulario de otra página
 * no puede enviar ese tipo sin permiso del navegador, así se frenan ataques CSRF.
 */
export async function leerJson(req: Request): Promise<Record<string, unknown>> {
  if (!(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    throw new ErrorApi(415, 'La petición debe enviarse como JSON');
  }
  let cuerpo: unknown;
  try {
    cuerpo = await req.json();
  } catch {
    throw new ErrorApi(400, 'Los datos enviados no son válidos');
  }
  if (!cuerpo || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) throw new ErrorApi(400, 'Los datos enviados no son válidos');
  return cuerpo as Record<string, unknown>;
}

export function texto(v: unknown, campo: string, { min = 1, max = 200 } = {}): string {
  if (typeof v !== 'string') throw new ErrorApi(400, `Falta ${campo}`);
  const t = v.trim();
  if (t.length < min) throw new ErrorApi(400, min > 1 ? `${campo} debe tener al menos ${min} caracteres` : `Falta ${campo}`);
  if (t.length > max) throw new ErrorApi(400, `${campo} es demasiado largo`);
  return t;
}

/** Pesos colombianos: solo enteros. Postgres redondearía 1000.5 en silencio, por eso se rechaza aquí. */
export function pesos(v: unknown, campo: string, { min = 0 } = {}): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new ErrorApi(400, `${campo} debe ser un valor en pesos, sin decimales`);
  if (v < min) throw new ErrorApi(400, `${campo} debe ser mayor o igual a ${min}`);
  return v;
}

export function leerCookies(req: Request): Record<string, string> {
  const r: Record<string, string> = {};
  for (const parte of (req.headers.get('cookie') || '').split(';')) {
    const i = parte.indexOf('=');
    if (i > 0) r[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim());
  }
  return r;
}

export function soloMetodos(req: Request, ...metodos: string[]) {
  if (!metodos.includes(req.method)) throw new ErrorApi(405, 'Método no permitido');
}
