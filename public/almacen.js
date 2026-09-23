/* =====================================================================
   Los Chamos POS v2 — Almacén del dueño: insumos guardados aparte que la
   encargada no cuenta. Entradas con su precio (avalúo), salidas al stock
   del día autorizadas por el dueño y ajustes con motivo.
   ===================================================================== */
'use strict';
(function () {
  const LC = window.LC;
  const esc = LC.esc;
  let alm = null; // lo que devolvió el servidor

  const cargar = () => LC.api('almacen').then((r) => { alm = r; if (LC.state.view === 'almacen' && !LC.$('#modal-root').innerHTML) LC.render(); })
    .catch((e) => LC.toast(e.message, 'error'));

  LC.V.almacen = () => {
    if (!LC.can('almacen.gestionar')) return LC.sinPermiso();
    if (!alm) { cargar(); return '<div class="page-head"><h1>Almacén</h1></div><p class="muted">Cargando…</p>'; }
    const grupos = { bebida: 'Bebidas', utensilio: 'Utensilios y desechables', insumo: 'Insumos de cocina' };
    const conAlgo = alm.items.filter((x) => x.cantidad || x.minimo);
    return `<div class="page-head"><h1>Almacén</h1><p class="muted">Lo que guardas aparte. La encargada no lo cuenta: solo entra al stock del día cuando tú lo sacas.</p></div>
    <div class="stat-row"><div class="stat"><span>Avalúo del almacén</span><strong class="num">${LC.fmt(alm.total)}</strong></div>
      <div class="stat"><span>Artículos con existencias</span><strong class="num">${alm.items.filter((x) => x.cantidad > 0).length}</strong></div></div>
    ${alm.bajos.length ? `<div class="notice bad"><strong>Por debajo del mínimo:</strong> ${alm.bajos.map((x) => `${esc(x.nombre)} (hay ${LC.q(x.cantidad)}, mínimo ${LC.q(x.minimo)})`).join(', ')}</div>` : ''}
    <div class="actions-grid">
      <button class="btn primary" data-a="almMov" data-accion="entrada">Guardar en el almacén</button>
      <button class="btn" data-a="almMov" data-accion="salida">Sacar al turno</button>
      <button class="btn ghost" data-a="almMov" data-accion="ajuste">Corregir conteo</button>
    </div>
    ${Object.entries(grupos).map(([g, t]) => {
      const f = conAlgo.filter((x) => x.tipo === g);
      if (!f.length) return '';
      return `<h3 class="sec">${t}</h3><table class="tbl"><thead><tr><th>Artículo</th><th>Hay</th><th>Costo unit.</th><th>Valor</th><th>Mínimo</th></tr></thead><tbody>
        ${f.map((x) => `<tr class="${x.minimo && x.cantidad < x.minimo ? 'neg' : ''}"><td>${esc(x.nombre)} <small>${esc(x.unidad)}</small></td><td>${LC.q(x.cantidad)}</td><td>${LC.fmt(x.costo)}</td><td>${LC.fmt(x.valor)}</td>
          <td><button class="link" data-a="almMinimo" data-id="${x.id}">${x.minimo ? LC.q(x.minimo) : 'Poner'}</button></td></tr>`).join('')}
      </tbody></table>`;
    }).join('') || '<p class="empty">El almacén está vacío. Usa "Guardar en el almacén" cuando compres para guardar.</p>'}
    <h3 class="sec">Últimos movimientos</h3>
    <div class="card">${alm.movimientos.map((m) => `<div class="mov"><div><strong>${esc(m.nombre)}: ${m.cantidad > 0 ? '+' : ''}${LC.q(m.cantidad)} ${esc(m.unidad)}</strong>
      <small>${LC.fecha(m.fecha)} ${LC.hora(m.fecha)}, ${{ entrada: 'entrada', salida: 'salió al turno', ajuste: 'ajuste' }[m.tipo]}, ${esc(m.usuario)}${m.nota ? ', ' + esc(m.nota) : ''}${m.cuenta ? ', pagado de ' + esc(m.cuenta) : ''}</small></div>
      <span class="num">${m.costo ? LC.fmt(m.costo) : ''}</span></div>`).join('') || '<p class="muted">Sin movimientos.</p>'}</div>`;
  };

  const opciones = (soloConExistencias) => ['bebidas', 'utensilios', 'insumos'].map((g) => {
    const its = LC.db[g].filter((it) => !soloConExistencias || (alm.items.find((x) => x.id === it.id) || {}).cantidad > 0);
    return its.length ? `<optgroup label="${LC.INV[g]}">${its.map((it) => `<option value="${it.id}">${esc(it.nombre)} (${esc(it.unidad)})${alm ? `, hay ${LC.q((alm.items.find((x) => x.id === it.id) || {}).cantidad || 0)}` : ''}</option>`).join('')}</optgroup>` : '';
  }).join('');

  LC.A.almMov = (d) => {
    const a = d.accion;
    const titulo = { entrada: 'Guardar en el almacén', salida: 'Sacar al turno', ajuste: 'Corregir conteo del almacén' }[a];
    LC.modal(`${LC.modalHead(titulo)}
      <form class="form" data-submit="almGuardar"><input type="hidden" name="accion" value="${a}">
        ${a === 'salida' ? '<p class="muted">Lo que saques entra al stock de hoy, como si hubiera llegado: la encargada o cocina lo cuentan al cerrar.</p>' : ''}
        <label>Artículo<select name="itemId" required><option value="">Elige</option>${opciones(a === 'salida')}</select></label>
        <label>${a === 'ajuste' ? 'Cuánto hay de verdad (lo contado)' : 'Cantidad'}<input type="number" name="cantidad" min="0" step="any" inputmode="decimal" required></label>
        ${a === 'entrada' ? `<label>Valor total pagado (para el avalúo)<input type="number" name="costo" min="0" step="1" inputmode="numeric"></label>
          <label>Se pagó desde<select name="cuenta"><option value="">Con mi plata (no sale de las cuentas del negocio)</option>${LC.CUENTAS.map((c) => `<option>${c}</option>`).join('')}</select></label>` : ''}
        <label>${a === 'ajuste' ? 'Motivo (obligatorio)' : 'Nota (opcional)'}<input name="nota" ${a === 'ajuste' ? 'required' : ''} placeholder="${a === 'entrada' ? 'Ej. Makro, factura 123' : a === 'salida' ? 'Ej. para el turno de hoy' : 'Ej. se dañaron 2'}"></label>
        <button class="btn primary lg block">Guardar</button></form>`);
  };
  LC.A.almGuardar = async (d, f) => {
    const body = { accion: d.accion, itemId: d.itemId, cantidad: LC.num(d.cantidad), nota: (d.nota || '').trim() };
    if (d.accion === 'entrada') { body.costo = Math.round(LC.num(d.costo)); body.cuenta = d.cuenta || null; }
    const btn = f.querySelector('button.primary'); btn.disabled = true;
    try { alm = await LC.api('almacen', { method: 'POST', body }); } catch (e) { btn.disabled = false; return LC.toast(e.message, 'error'); }
    // Una salida cambia el stock del día y una compra pagada cambia los saldos
    LC.cargarTurno().catch(() => {}); LC.cargarCatalogo().catch(() => {});
    LC.cerrarModal(); LC.toast('Guardado'); LC.render();
  };
  LC.A.almMinimo = async (d) => {
    const x = alm.items.find((i) => i.id === d.id); if (!x) return;
    const v = prompt(`¿Cuánto quieres tener como mínimo en el almacén de ${x.nombre} (${x.unidad})? Escribe 0 para no avisar.`, x.minimo || '');
    if (v === null) return;
    try { alm = await LC.api('almacen', { method: 'POST', body: { accion: 'minimo', itemId: d.id, minimo: LC.num(v) } }); } catch (e) { return LC.toast(e.message, 'error'); }
    LC.render();
  };
  // Al volver a entrar a la pantalla se recargan las existencias
  LC.almacenOlvidar = () => { alm = null; };
})();
