// GET /api/turno  → estado del turno: si la caja está abierta, personal, movimientos, llegadas y saldos.
// Cualquier usuario conectado lo puede pedir (la mesera necesita saber si la caja está abierta),
// pero el dinero (saldos, movimientos, arqueos) solo lo reciben quienes manejan caja o reportes.
import { conUsuario } from '../../_lib/auth';
import { json, ruta } from '../../_lib/http';
import { leerEstado } from '../../_lib/turno';

export const GET = ruta(async (req) => json(await conUsuario(req, null, (db, u) => leerEstado(db, u))));
