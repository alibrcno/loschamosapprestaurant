// POST /api/turno/llegada  { items: [{ itemId, cantidad, costo? }], cuenta?, nota?, foto? }
// foto: imagen de la factura ("data:image/jpeg;base64,…", la app la achica). Se borra sola a los 15 días.
// Si algo llega más caro que la última vez, se avisa al dueño (Telegram y correo) y queda en Reportes.
// Llegó mercancía (una factura con uno o varios artículos): sube el stock, actualiza el costo
// unitario y, si se pagó de una cuenta, registra el gasto en el libro.
// Permiso inventario.entradas (caja): cualquier artículo. Cocina (cocina.inventario): solo insumos.
// Decir de qué cuenta se pagó es cosa de caja (permiso caja.movimientos), no de cocina.
// Cocina puede registrar llegadas desde que abre su turno, aunque la encargada no haya abierto la caja.
import { auditar, conUsuario, puede } from '../../_lib/auth';
import { cantidad } from '../../_lib/catalogo';
import { esUuid } from '../../_lib/db';
import { ErrorApi, json, leerJson, pesos, ruta } from '../../_lib/http';
import { cuentaId, exigirTurnoActivo, leerEstado, leerObs, nuevoGrupo, registrar, turnoActual } from '../../_lib/turno';
import { enviarATodos, leerDestinos } from '../../_lib/avisos';

export const DIAS_FOTOS = 15;
const fmt = (n: number) => '$' + Math.round(n).toLocaleString('es-CO');
const q = (n: number) => (Math.round(n * 100) / 100).toLocaleString('es-CO');

export const POST = ruta(async (req) => {
  const b = await leerJson(req);
  const r = await conUsuario(req, null, async (db, u) => {
    // Compatibilidad: un solo artículo sin lista
    const lista = Array.isArray(b.items) ? b.items : [{ itemId: b.itemId, cantidad: b.cantidad, costo: b.costo }];
    if (!lista.length || lista.length > 40) throw new ErrorApi(400, 'Agrega al menos un artículo');
    const cuenta = b.cuenta ? await cuentaId(db, b.cuenta) : null;
    if (cuenta && !puede(u, 'caja.movimientos')) throw new ErrorApi(403, 'Registrar de qué cuenta se pagó le corresponde a la caja');
    const t = exigirTurnoActivo(await turnoActual(db));
    const nota = leerObs(b.nota, 120) || null;
    const grupo = nuevoGrupo();
    // Foto de la factura (opcional). Las de hace más de 15 días se borran aquí mismo.
    await db.query(`DELETE FROM invoice_photos WHERE creado_en < now() - interval '${DIAS_FOTOS} days'`);
    let fotoId: string | null = null;
    if (b.foto !== undefined && b.foto !== null && b.foto !== '') {
      if (typeof b.foto !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(b.foto)) throw new ErrorApi(400, 'La foto de la factura debe ser una imagen');
      if (b.foto.length > 700000) throw new ErrorApi(400, 'La foto es muy pesada. Tómala de nuevo.');
      fotoId = (await db.query('INSERT INTO invoice_photos (tenant_id, imagen, user_id) VALUES ($1, $2, $3) RETURNING id', [u.tenant_id, b.foto, u.id])).rows[0].id;
    }
    const aumentos: { itemId: string; nombre: string; unidad: string; antes: number; ahora: number; pct: number }[] = [];
    let total = 0;
    const detalle: string[] = [];
    for (const x of lista as Record<string, unknown>[]) {
      if (!x || !esUuid(x.itemId)) throw new ErrorApi(400, 'Elige el producto de cada artículo');
      const it = (await db.query('SELECT id, tipo, nombre, unidad, stock, costo FROM inventory_items WHERE id = $1 AND activo FOR UPDATE', [x.itemId])).rows[0];
      if (!it) throw new ErrorApi(404, 'Uno de los productos no existe');
      if (!puede(u, 'inventario.entradas') && !(it.tipo === 'insumo' && puede(u, 'cocina.inventario'))) throw new ErrorApi(403, `Tu usuario no puede registrar ${it.nombre}`);
      const cant = cantidad(x.cantidad, `La cantidad de ${it.nombre}`);
      if (cant <= 0) throw new ErrorApi(400, `La cantidad de ${it.nombre} debe ser mayor a 0`);
      const costo = x.costo === undefined || x.costo === null || x.costo === '' ? 0 : pesos(x.costo, `El valor de ${it.nombre}`);
      if (cuenta && !costo) throw new ErrorApi(400, `Si se pagó desde una cuenta, escribe el valor de ${it.nombre}`);
      const nuevoCosto = costo > 0 ? Math.round((costo / cant) * 100) / 100 : Number(it.costo);
      await db.query('UPDATE inventory_items SET stock = stock + $2, costo = $3 WHERE id = $1', [it.id, cant, nuevoCosto]);
      const e = (await db.query(
        `INSERT INTO inventory_entries (tenant_id, shift_id, item_id, cantidad, motivo, costo_total, account_id, nota, user_id, foto_id)
         VALUES ($1, $2, $3, $4, 'llegada', $5, $6, $7, $8, $9) RETURNING id`,
        [u.tenant_id, t.id, it.id, cant, costo, cuenta, nota, u.id, fotoId]
      )).rows[0];
      if (cuenta) {
        await registrar(db, u, { shiftId: t.id, cuentaId: cuenta, tipo: 'gasto', monto: -costo, concepto: `Compra ${it.nombre} x${cant}${nota ? ` (${nota})` : ''}`, categoria: 'Compra de inventario', refId: e.id, grupoId: grupo });
      }
      total += costo;
      // ¿Llegó más caro que la última vez? (costo por unidad, con 1 % de margen por redondeos)
      const antes = Number(it.costo);
      if (costo > 0 && antes > 0 && nuevoCosto > antes * 1.01) {
        aumentos.push({ itemId: it.id, nombre: it.nombre, unidad: it.unidad, antes, ahora: nuevoCosto, pct: Math.round(((nuevoCosto - antes) / antes) * 1000) / 10 });
      }
      detalle.push(`${it.nombre} +${cant} ${it.unidad}${costo ? ` por $${costo.toLocaleString('es-CO')}` : ''}${nuevoCosto !== Number(it.costo) ? ` (costo unitario ${it.costo} a ${nuevoCosto})` : ''}`);
    }
    await auditar(db, u.tenant_id, u.id, 'Llegada de mercancía', `${nota ? nota + ': ' : ''}${detalle.join('; ')}${total ? `. Total $${total.toLocaleString('es-CO')}` : ''}${fotoId ? ' (con foto de la factura)' : ''}`);
    for (const a of aumentos) {
      await auditar(db, u.tenant_id, u.id, 'Llegó más caro', `${a.nombre}: ${fmt(a.antes)} a ${fmt(a.ahora)} por ${a.unidad} (+${q(a.pct)} %)`, a);
    }
    const { negocio, destinos } = aumentos.length ? await leerDestinos(db) : { negocio: '', destinos: {} };
    return { ...(await leerEstado(db, u)), aumentos, negocio, destinos, quien: u.nombre };
  });
  // Aviso al dueño después de guardar: si falla, la llegada ya quedó registrada
  if (r.aumentos.length) {
    const texto = [`⚠️ LLEGÓ MÁS CARO · ${r.negocio.toUpperCase()}`, `Registró: ${r.quien}`, '',
      ...r.aumentos.map((a) => `• ${a.nombre}: antes ${fmt(a.antes)}, ahora ${fmt(a.ahora)} por ${a.unidad} (+${q(a.pct)} %)`),
      '', 'Revisa si hay que subir el precio de lo que se vende con esto (Reportes → Cuentas).'].join('\n');
    await enviarATodos(r.destinos, `Llegó más caro · ${r.negocio}`, texto);
  }
  return json({ ...r, negocio: undefined, destinos: undefined, quien: undefined }, 201);
});
