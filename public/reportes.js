/* =====================================================================
   Los Chamos POS v2 — Reportes y finanzas (solo con permiso reportes.ver)
   ===================================================================== */
'use strict';
(function () {
  const LC = window.LC;
  const esc = LC.esc;
  const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

  LC.V.reportes = (p) => {
    if (!LC.can('reportes.ver')) return LC.sinPermiso();
    const tabs = [['resumen', 'Cuentas'], ['turnos', 'Turnos'], ['semana', 'Semana'], ['mes', 'Mes'], ['movimientos', 'Movimientos'], ['auditoria', 'Auditoría']];
    const tab = tabs.some((x) => x[0] === p.tab) ? p.tab : 'resumen';
    const body = { resumen, turnos, semana, mes, movimientos, auditoria }[tab](p);
    return `<div class="page-head"><h1>Reportes</h1></div>${LC.tabs(tabs, tab, 'reportes')}${body}`;
  };

  function resumen() {
    const s = LC.db.saldos;
    const total = LC.CUENTAS.reduce((a, c) => a + (s[c] || 0), 0);
    const t = LC.turno();
    const r = t ? LC.resumenTurno(t) : null;
    const bajos = [];
    ['bebidas', 'utensilios', 'insumos'].forEach((tp) => LC.db[tp].forEach((it) => { if (LC.num(it.stock) < LC.num(it.sugerido)) bajos.push({ tp, it }); }));
    return `
    <section class="hero-turno abierto slim"><p class="ht-estado">Debería haber en total</p><h1 class="num">${LC.fmt(total)}</h1>
      <p>Saldo según el libro: arqueos, ventas, gastos y traslados registrados.</p></section>
    <div class="saldo-grid">${LC.CUENTAS.map((c) => `<div class="saldo"><span>${c}</span><strong class="num">${LC.fmt(s[c])}</strong></div>`).join('')}</div>
    <div class="actions-grid">
      <button class="btn" data-a="movNuevo" data-tipo="gasto">Registrar gasto</button>
      <button class="btn" data-a="movNuevo" data-tipo="ingreso">Registrar ingreso</button>
      <button class="btn" data-a="trasladoNuevo">Pasar entre cuentas</button>
    </div>
    ${r ? `<h3 class="sec">Turno en curso</h3>
      <div class="stat-row">
        <div class="stat"><span>Ventas</span><strong class="num">${LC.fmt(r.ventas)}</strong></div>
        <div class="stat"><span>Gastos</span><strong class="num neg">${LC.fmt(r.gastos)}</strong></div>
        <div class="stat"><span>Ticket promedio</span><strong class="num">${LC.fmt(r.ticketProm)}</strong></div>
      </div>
      <table class="tbl"><thead><tr><th>Cuenta</th><th>Ventas del turno</th></tr></thead><tbody>${LC.CUENTAS.map((c) => `<tr><td>${c}</td><td>${LC.fmt(r.ventasCuenta[c])}</td></tr>`).join('')}</tbody></table>` : ''}
    <h3 class="sec">Por debajo del stock sugerido</h3>
    ${bajos.length ? `<table class="tbl"><thead><tr><th>Ítem</th><th>Hay</th><th>Sugerido</th></tr></thead><tbody>${bajos.map(({ tp, it }) => `<tr><td>${esc(it.nombre)} <small>${LC.INV[tp]}</small></td><td class="neg">${LC.q(it.stock)}</td><td>${LC.q(it.sugerido)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Todo está sobre el stock sugerido.</p>'}`;
  }

  function turnos() {
    const ts = LC.db.turnos.filter((t) => t.estado === 'cerrado').slice().reverse();
    if (!ts.length) return '<div class="empty"><h2>Sin turnos cerrados</h2><p>Cuando la encargada cierre caja, el turno aparece aquí con su cuadre.</p></div>';
    return `<div class="list">${ts.map((t) => {
      const r = t.resumen;
      const desc = Object.values((t.cierre && t.cierre.descuadre) || {}).reduce((a, b) => a + b, 0);
      return `<button class="list-item" data-a="turnoVer" data-id="${t.id}">
        <div><strong>${LC.fecha(t.abiertoEn)}</strong><small>${esc(t.abiertoPor)}, ${LC.hora(t.abiertoEn)} a ${LC.hora(t.cerradoEn)}</small></div>
        <div class="right"><strong class="num">${LC.fmt(r.ventas)}</strong><small class="${r.utilidad < 0 ? 'neg' : ''}">Utilidad ${LC.fmt(r.utilidad)}</small>
          ${desc ? `<small class="neg">Descuadre ${LC.fmt(desc)}</small>` : '<small class="pos">Cuadró</small>'}</div>
      </button>`;
    }).join('')}</div>`;
  }

  LC.A.turnoVer = (d) => {
    const t = LC.db.turnos.find((x) => x.id === d.id); if (!t) return;
    const r = t.resumen || LC.resumenTurno(t);
    const ci = t.cierre || {};
    LC.modal(`${LC.modalHead('Turno del ' + LC.fecha(t.abiertoEn))}
      <div class="stat-row">
        <div class="stat"><span>Ventas</span><strong class="num">${LC.fmt(r.ventas)}</strong></div>
        <div class="stat"><span>Gastos</span><strong class="num neg">${LC.fmt(r.gastos)}</strong></div>
        <div class="stat"><span>Utilidad estimada</span><strong class="num">${LC.fmt(r.utilidad)}</strong></div>
      </div>
      <table class="tbl"><thead><tr><th>Cuenta</th><th>Ventas</th><th>Esperado</th><th>Contado</th><th>Dif.</th></tr></thead><tbody>
      ${LC.CUENTAS.map((c) => { const dif = (ci.descuadre || {})[c] || 0; return `<tr><td>${c}</td><td>${LC.fmt(r.ventasCuenta[c])}</td><td>${LC.fmt((ci.saldosEsperados || {})[c])}</td><td>${LC.fmt((ci.saldosContados || {})[c])}</td><td class="${dif < 0 ? 'neg' : dif > 0 ? 'pos' : ''}">${dif ? LC.fmt(dif) : 'Cuadra'}</td></tr>`; }).join('')}
      </tbody></table>
      <table class="tbl"><tbody>
        <tr><td>Costo de bebidas vendidas</td><td>${LC.fmt(r.costoBebidas)}</td></tr>
        <tr><td>Costo de insumos de cocina${r.cocinaCerrada ? '' : ' (cocina no hizo inventario)'}</td><td>${LC.fmt(r.costoInsumos)}</td></tr>
        <tr><td>Costo de utensilios</td><td>${LC.fmt(r.costoUtensilios)}</td></tr>
        <tr><td>Gastos operativos</td><td>${LC.fmt(r.gastosOp)}</td></tr>
        <tr><td>Compras de inventario pagadas</td><td>${LC.fmt(r.compras)}</td></tr>
        <tr><td>Anulaciones</td><td>${r.anulaciones}</td></tr>
      </tbody></table>
      ${r.productos.length ? `<h3 class="sec">Lo más vendido</h3><table class="tbl"><tbody>${r.productos.slice(0, 10).map((x) => `<tr><td>${esc(x.nombre)}</td><td>${LC.q(x.qty)}</td><td>${LC.fmt(x.valor)}</td></tr>`).join('')}</tbody></table>` : ''}
      ${ci.obs ? `<p class="notice">Caja: ${esc(ci.obs)}</p>` : ''}
      ${t.cocina && t.cocina.cierre && t.cocina.cierre.obs ? `<p class="notice">Cocina: ${esc(t.cocina.cierre.obs)}</p>` : ''}
      ${(r.preparar || []).length ? `<p><strong>Preparar al día siguiente:</strong> ${r.preparar.map(esc).join(', ')}</p>` : ''}
      ${(() => { const c = r.bebidas.concat(r.utensilios, r.cocinaCerrada ? r.insumos : []).filter((x) => x.comprar > 0);
        return c.length ? `<h3 class="sec">Compras sugeridas</h3><ul class="compras">${c.map((x) => `<li><strong>${LC.q(x.comprar)} ${esc(x.unidad)}</strong> ${esc(x.nombre)}${x.sacar ? ` <small>(en el almacén hay ${LC.q(x.almacen)}: saca ${LC.q(x.sacar)}${x.comprar - x.sacar > 0 ? ` y compra ${LC.q(x.comprar - x.sacar)}` : ''})</small>` : ''}</li>`).join('')}</ul>` : ''; })()}
      <button class="btn primary block" data-a="turnoWhats" data-id="${t.id}">Reenviar reporte por WhatsApp</button>`, true);
  };
  LC.A.turnoWhats = (d) => { const t = LC.db.turnos.find((x) => x.id === d.id); if (t) LC.whatsapp(LC.msgCierre(t)); };

  /* ---------- herramientas para agrupar turnos ---------- */
  const diaDe = (t) => LC.diaLocal(new Date(t.abiertoEn)); // día comercial: el día en que se abrió
  const sumarDias = (dia, n) => { const d = new Date(dia + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  // La semana del negocio va de martes a lunes (el lunes se cierra la semana)
  const martesDe = (dia) => sumarDias(dia, -((new Date(dia + 'T12:00:00Z').getUTCDay() + 5) % 7));
  const nombreDia = (dia) => `${DIAS[new Date(dia + 'T12:00:00Z').getUTCDay()]} ${+dia.slice(8)}/${+dia.slice(5, 7)}`;
  const cerrados = (desde, hasta) => LC.db.turnos.filter((t) => t.estado === 'cerrado' && t.resumen && diaDe(t) >= desde && diaDe(t) <= hasta)
    .sort((a, b) => (a.abiertoEn < b.abiertoEn ? -1 : 1));
  const totalCuentas = (m) => (m ? LC.CUENTAS.reduce((a, c) => a + (m[c] || 0), 0) : null);
  // Dinero en las cuentas: lo contado al abrir el primer turno y al cerrar el último (se acumula de un día a otro)
  function dineroHTML(ts, titulo) {
    const ini = ts.length ? totalCuentas(ts[0].apertura && ts[0].apertura.saldosContados) : null;
    const fin = ts.length ? totalCuentas(ts[ts.length - 1].cierre && ts[ts.length - 1].cierre.saldosContados) : null;
    if (ini === null || fin === null) return '';
    const flujo = ts.reduce((a, t) => a + (t.resumen.flujo || 0), 0);
    return `<h3 class="sec">${titulo}</h3><table class="tbl"><tbody>
      <tr><td>Había en las cuentas al abrir el primer turno</td><td class="num">${LC.fmt(ini)}</td></tr>
      <tr><td>Entró por ventas e ingresos, menos gastos y compras</td><td class="num ${flujo < 0 ? 'neg' : 'pos'}">${LC.fmt(flujo)}</td></tr>
      <tr><td>Quedó al cerrar el último turno</td><td class="num"><strong>${LC.fmt(fin)}</strong></td></tr>
      <tr><td>Diferencia</td><td class="num ${fin - ini < 0 ? 'neg' : 'pos'}">${LC.fmt(fin - ini)}</td></tr></tbody></table>`;
  }
  const catsTexto = (pc) => Object.entries(pc || {}).sort((a, b) => b[1] - a[1]).map(([c, v]) => `${esc(c)} ${LC.fmt(v)}`).join(' · ');

  /* ---------- semana de martes a lunes ---------- */
  function semana(p) {
    const desde = p.desde || martesDe(LC.diaLocal()), hasta = sumarDias(desde, 6);
    const ts = cerrados(desde, hasta);
    const dias = Array.from({ length: 7 }, (_, i) => sumarDias(desde, i));
    const tot = { ventas: 0, costo: 0, gastosOp: 0, utilidad: 0 }, porCat = {}, prods = {}, insumos = {};
    ts.forEach((t) => {
      const r = t.resumen;
      tot.ventas += r.ventas; tot.costo += r.costoConsumo; tot.gastosOp += r.gastosOp; tot.utilidad += r.utilidad;
      Object.entries(r.porCategoria || {}).forEach(([c, v]) => (porCat[c] = (porCat[c] || 0) + v));
      (r.productos || []).forEach((x) => { const q = (prods[x.nombre] = prods[x.nombre] || { nombre: x.nombre, qty: 0, valor: 0 }); q.qty += x.qty; q.valor += x.valor; });
      (r.insumos || []).forEach((x) => {
        const it = (insumos[x.id] = insumos[x.id] || { nombre: x.nombre, unidad: x.unidad, dias: {}, ent: 0, gasto: 0 });
        const d = (it.dias[diaDe(t)] = it.dias[diaDe(t)] || { ent: 0, gasto: 0 });
        d.ent += x.ent || 0; d.gasto += x.consumo || 0; it.ent += x.ent || 0; it.gasto += x.consumo || 0;
      });
    });
    const maxCat = Math.max(1, ...Object.values(porCat));
    const ins = Object.values(insumos).filter((x) => x.ent || x.gasto);
    return `
    <div class="filters"><button class="btn sm" data-a="go" data-v="reportes" data-tab="semana" data-desde="${sumarDias(desde, -7)}">← Semana anterior</button>
      <strong>Martes ${+desde.slice(8)}/${+desde.slice(5, 7)} a lunes ${+hasta.slice(8)}/${+hasta.slice(5, 7)}</strong>
      <button class="btn sm" data-a="go" data-v="reportes" data-tab="semana" data-desde="${sumarDias(desde, 7)}">Siguiente →</button></div>
    <div class="stat-row">
      <div class="stat"><span>Ventas</span><strong class="num">${LC.fmt(tot.ventas)}</strong></div>
      <div class="stat"><span>Costo + gastos operativos</span><strong class="num neg">${LC.fmt(tot.costo + tot.gastosOp)}</strong></div>
      <div class="stat"><span>Utilidad estimada</span><strong class="num ${tot.utilidad < 0 ? 'neg' : 'pos'}">${LC.fmt(tot.utilidad)}</strong></div>
    </div>
    <p class="muted">${ts.length} turnos cerrados en la semana.</p>
    ${dineroHTML(ts, 'Dinero en las cuentas en la semana')}
    <h3 class="sec">Ventas de cada día</h3>
    <table class="tbl"><thead><tr><th>Día</th><th>Ventas</th><th>Por categoría</th></tr></thead><tbody>
      ${dias.map((d) => { const td = ts.filter((t) => diaDe(t) === d); const v = td.reduce((a, t) => a + t.resumen.ventas, 0);
        const pc = {}; td.forEach((t) => Object.entries(t.resumen.porCategoria || {}).forEach(([c, x]) => (pc[c] = (pc[c] || 0) + x)));
        return `<tr><td>${nombreDia(d)}</td><td class="num">${td.length ? LC.fmt(v) : '<span class="muted">sin turno</span>'}</td><td><small>${catsTexto(pc)}</small></td></tr>`; }).join('')}
    </tbody></table>
    <h3 class="sec">Ventas por categoría</h3>
    <div class="card bars">${Object.entries(porCat).sort((a, b) => b[1] - a[1]).map(([c, v]) => `<div class="bar-row"><span>${esc(c)}</span><div class="bar"><i style="width:${Math.round((v / maxCat) * 100)}%"></i></div><strong class="num">${LC.fmt(v)}</strong></div>`).join('') || '<p class="muted">Sin ventas.</p>'}</div>
    <h3 class="sec">Lo más vendido</h3>
    ${Object.keys(prods).length ? `<table class="tbl"><thead><tr><th>Producto</th><th>Cant.</th><th>Valor</th></tr></thead><tbody>${Object.values(prods).sort((a, b) => b.qty - a.qty).slice(0, 15).map((x) => `<tr><td>${esc(x.nombre)}</td><td>${LC.q(x.qty)}</td><td>${LC.fmt(x.valor)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Sin ventas.</p>'}
    <h3 class="sec">Compras y gasto de cocina por día</h3>
    <p class="muted">"+" es lo que entró (compras y salidas del almacén); "−" lo que se gastó según el inventario de cierre de cocina.</p>
    ${ins.length ? `<div class="tabla-scroll"><table class="tbl"><thead><tr><th>Insumo</th>${dias.map((d) => `<th>${DIAS[new Date(d + 'T12:00:00Z').getUTCDay()].slice(0, 3)}</th>`).join('')}<th>Entró</th><th>Gastó</th></tr></thead><tbody>
      ${ins.map((x) => `<tr><td>${esc(x.nombre)} <small>${esc(x.unidad)}</small></td>${dias.map((d) => { const v = x.dias[d]; return `<td><small>${v && v.ent ? '+' + LC.q(v.ent) : ''}${v && v.gasto ? '<br>−' + LC.q(v.gasto) : ''}</small></td>`; }).join('')}<td><strong>${LC.q(x.ent)}</strong></td><td><strong>${LC.q(x.gasto)}</strong></td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">Sin inventarios de cocina en la semana.</p>'}`;
  }

  function mes(p) {
    const m = p.mes || LC.diaLocal().slice(0, 7);
    const ts = LC.db.turnos.filter((t) => t.estado === 'cerrado' && LC.diaLocal(new Date(t.abiertoEn)).slice(0, 7) === m);
    const tot = { ventas: 0, gastos: 0, gastosOp: 0, costo: 0, utilidad: 0, desc: 0 };
    const dias = DIAS.map(() => ({ v: 0, n: 0 }));
    const personas = {}, prods = {};
    ts.forEach((t) => {
      const r = t.resumen;
      tot.ventas += r.ventas; tot.gastos += r.gastos; tot.gastosOp += r.gastosOp; tot.costo += r.costoConsumo; tot.utilidad += r.utilidad;
      tot.desc += Object.values((t.cierre && t.cierre.descuadre) || {}).reduce((a, b) => a + b, 0);
      const dw = LC.diaSemana(t.abiertoEn);
      dias[dw].v += r.ventas; dias[dw].n++;
      (t.personal || []).forEach((x) => {
        const k = x.nombre.trim().toLowerCase();
        const pe = (personas[k] = personas[k] || { nombre: x.nombre, dias: 0, areas: {} });
        pe.dias++; pe.areas[x.area] = (pe.areas[x.area] || 0) + 1;
      });
      r.productos.forEach((x) => { const q = (prods[x.nombre] = prods[x.nombre] || { nombre: x.nombre, qty: 0, valor: 0 }); q.qty += x.qty; q.valor += x.valor; });
    });
    // Promedio por día de la semana y categoría: para saber qué día conviene hacer promociones
    const catDia = {};
    ts.forEach((t) => { const dw = LC.diaSemana(t.abiertoEn); Object.entries(t.resumen.porCategoria || {}).forEach(([c, v]) => { (catDia[c] = catDia[c] || DIAS.map(() => 0))[dw] += v; }); });
    const prom = dias.map((x) => (x.n ? x.v / x.n : 0));
    const max = Math.max(1, ...prom);
    const orden = [1, 2, 3, 4, 5, 6, 0];
    return `
    <label class="inline-label">Mes<input type="month" value="${m}" data-ch="mesCambio"></label>
    <div class="stat-row">
      <div class="stat"><span>Ventas</span><strong class="num">${LC.fmt(tot.ventas)}</strong></div>
      <div class="stat"><span>Costo + gastos operativos</span><strong class="num neg">${LC.fmt(tot.costo + tot.gastosOp)}</strong></div>
      <div class="stat"><span>Utilidad estimada</span><strong class="num ${tot.utilidad < 0 ? 'neg' : 'pos'}">${LC.fmt(tot.utilidad)}</strong></div>
    </div>
    <p class="muted">${ts.length} turnos cerrados. Descuadres acumulados: <strong class="${tot.desc ? 'neg' : ''}">${LC.fmt(tot.desc)}</strong>. Gastos pagados (incluye compras): ${LC.fmt(tot.gastos)}.</p>
    <h3 class="sec">Venta promedio por día</h3>
    <div class="card bars">${orden.map((i) => `<div class="bar-row"><span>${DIAS[i]}</span><div class="bar"><i style="width:${Math.round((prom[i] / max) * 100)}%"></i></div><strong class="num">${LC.fmt(prom[i])}</strong></div>`).join('')}</div>
    ${dineroHTML(ts.slice().sort((a, b) => (a.abiertoEn < b.abiertoEn ? -1 : 1)), 'Dinero en las cuentas en el mes')}
    <h3 class="sec">Venta promedio por día y categoría</h3>
    <p class="muted">Sirve para ver qué día se vende menos cada cosa y ahí lanzar promociones.</p>
    ${Object.keys(catDia).length ? `<div class="tabla-scroll"><table class="tbl"><thead><tr><th>Categoría</th>${orden.map((i) => `<th>${DIAS[i].slice(0, 3)}</th>`).join('')}</tr></thead><tbody>
      ${Object.entries(catDia).map(([c, arr]) => `<tr><td>${esc(c)}</td>${orden.map((i) => `<td><small>${dias[i].n ? LC.fmt(arr[i] / dias[i].n) : ''}</small></td>`).join('')}</tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">Sin ventas este mes.</p>'}
    <h3 class="sec">Días trabajados</h3>
    ${Object.keys(personas).length ? `<table class="tbl"><thead><tr><th>Persona</th><th>Días</th><th>Áreas</th></tr></thead><tbody>${Object.values(personas).sort((a, b) => b.dias - a.dias).map((x) => `<tr><td>${esc(x.nombre)}</td><td><strong>${x.dias}</strong></td><td>${Object.entries(x.areas).map(([a, n]) => `${a} ${n}`).join(', ')}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Sin registros este mes.</p>'}
    <h3 class="sec">Productos más vendidos</h3>
    ${Object.keys(prods).length ? `<table class="tbl"><thead><tr><th>Producto</th><th>Cant.</th><th>Valor</th></tr></thead><tbody>${Object.values(prods).sort((a, b) => b.valor - a.valor).slice(0, 15).map((x) => `<tr><td>${esc(x.nombre)}</td><td>${LC.q(x.qty)}</td><td>${LC.fmt(x.valor)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Sin ventas este mes.</p>'}`;
  }
  LC.A.mesCambio = (d, el) => LC.go('reportes', { tab: 'mes', mes: el.value });

  function movimientos(p) {
    const cu = p.cuenta || '', tp = p.tipo || '';
    const lista = LC.db.movimientos.filter((m) => (!cu || m.cuenta === cu) && (!tp || m.tipo === tp)).slice(-300).reverse();
    const sel = (name, val, opts) => `<select data-ch="movFiltro" name="${name}"><option value="">${name === 'cuenta' ? 'Todas las cuentas' : 'Todos los tipos'}</option>${opts.map((o) => `<option ${o === val ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
    return `<div class="filters">${sel('cuenta', cu, LC.CUENTAS)}${sel('tipo', tp, ['venta', 'gasto', 'ingreso', 'traslado', 'ajuste'])}</div>
    <div class="card">${lista.length ? lista.map((m) => `<div class="mov"><div><strong>${esc(m.concepto)}</strong><small>${LC.fecha(m.fecha)} ${LC.hora(m.fecha)}, ${m.tipo}, ${esc(m.cuenta)}, ${esc(m.usuario)}</small></div><span class="num ${m.monto < 0 ? 'neg' : 'pos'}">${LC.fmt(m.monto)}</span></div>`).join('') : '<p class="muted">Sin movimientos.</p>'}</div>`;
  }
  LC.A.movFiltro = (d, el) => {
    const f = el.parentElement.querySelectorAll('select');
    LC.go('reportes', { tab: 'movimientos', cuenta: f[0].value, tipo: f[1].value });
  };

  // Auditoría del servidor (caja, usuarios, precios, stock) + lo que todavía registra este equipo (pedidos)
  let audSrv = null, cargandoAud = false;
  function cargarAuditoria() {
    if (cargandoAud) return;
    cargandoAud = true;
    LC.api('auditoria').then((r) => {
      audSrv = r.auditoria;
      if (LC.state.view === 'reportes' && LC.state.params.tab === 'auditoria' && !LC.$('#modal-root').innerHTML) LC.render();
    }).catch((e) => LC.toast(e.message, 'error')).finally(() => { cargandoAud = false; });
  }
  function auditoria() {
    if (!audSrv) { cargarAuditoria(); return '<p class="muted">Cargando auditoría…</p>'; }
    const srv = audSrv; audSrv = null; // la próxima vez que se abra, se vuelve a pedir
    const l = srv.concat(LC.db.auditoria.slice(-300)).sort((a, b) => (a.fecha < b.fecha ? 1 : -1)).slice(0, 400);
    return `<p class="muted">Todo lo que hace cada usuario queda aquí: anulaciones, cambios de precio, ajustes de stock y accesos.</p>
    <div class="card">${l.map((a) => `<div class="mov"><div><strong>${esc(a.accion)}</strong><small>${esc(a.detalle)}</small></div><small class="right">${LC.fecha(a.fecha)} ${LC.hora(a.fecha)}<br>${esc(a.usuario)}</small></div>`).join('')}</div>`;
  }
})();
