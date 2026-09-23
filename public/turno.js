/* =====================================================================
   Los Chamos POS v2 — Turno: apertura, caja, llegadas de mercancía,
   gastos, inventario de cocina y cierre con reporte por WhatsApp
   ===================================================================== */
'use strict';
(function () {
  const LC = window.LC;
  const esc = LC.esc;
  let W = null; // asistente en curso (apertura, cierre o cierre de cocina)

  const stepper = (pasos, i) =>
    `<ol class="stepper">${pasos.map((p, k) => `<li class="${k < i ? 'done' : k === i ? 'on' : ''}">${p}</li>`).join('')}</ol>`;
  const campoConteo = (it, val) =>
    `<label class="row-count"><span>${esc(it.nombre)}<small>${esc(it.unidad || 'und')}</small></span><input type="number" name="c_${it.id}" min="0" step="any" inputmode="decimal" required value="${val == null ? '' : val}"></label>`;
  const leerConteo = (items, d) => Object.fromEntries(items.map((it) => [it.id, LC.num(d['c_' + it.id])]));
  const difClase = (n) => (n < 0 ? 'neg' : n > 0 ? 'pos' : '');
  const signo = (n) => (n > 0 ? '+' : '') + LC.q(n);
  const signoPesos = (n) => (n > 0 ? '+' : '') + LC.fmt(n);
  // Al cerrar sesión se descarta el asistente: la siguiente persona no ve los conteos de la anterior
  LC.wizReset = () => { W = null; };
  LC.A.wizAtras = () => { if (W && W.paso > 0) { W.paso--; LC.render(); } };
  LC.A.wizCancelar = (d) => { W = null; LC.go(d.v || 'inicio'); };

  /* ================= APERTURA ================= */
  const PASOS_AP = ['Personal', 'Bebidas', 'Utensilios', 'Cuentas', 'Confirmar'];

  LC.V.apertura = () => {
    if (!LC.can('turno.operar')) return LC.sinPermiso();
    if (LC.turno()) return `<div class="empty"><h2>La caja ya está abierta</h2><button class="btn" data-a="go" data-v="caja">Ir a caja</button></div>`;
    if (LC.esperandoCocina()) return esperandoCocinaHTML();
    if (LC.catalogoVacio) return `<div class="empty"><h2>Primero sube el menú al servidor</h2>
      <p>Los conteos de la caja usan las bebidas y utensilios del servidor. El administrador debe subir el menú una vez en Ajustes.</p>
      ${LC.can('catalogo.editar') ? '<button class="btn primary" data-a="go" data-v="ajustes">Ir a Ajustes</button>' : ''}</div>`;
    if (!W || W.tipo !== 'apertura') {
      W = { tipo: 'apertura', paso: 0, personal: [], bebidas: null, utensilios: null, saldos: null };
      // El personal viene del servidor; si no alcanzó a cargar al ingresar, se pide de nuevo
      if (!LC.equipo.length) LC.cargarEquipo().then(() => { if (LC.state.view === 'apertura' && W && W.paso === 0 && LC.equipo.length) LC.render(); });
    }
    const nav = (txt) => `<div class="wiz-nav">${W.paso > 0 ? '<button type="button" class="btn" data-a="wizAtras">Atrás</button>' : '<button type="button" class="btn ghost" data-a="wizCancelar">Cancelar</button>'}<button class="btn primary lg">${txt}</button></div>`;
    let body = '';

    if (W.paso === 0) {
      const sel = (id) => (W.personal.find((p) => p.id === id) || {}).area || (id === LC.user.id && !W.personal.length ? 'Caja' : '');
      body = `<form class="card form" data-submit="apPersonal">
        <h2>¿Quién trabaja hoy?</h2>
        <p class="muted">Queda registrado para contar los días trabajados de cada persona en el mes. Debe haber al menos una persona en cocina.</p>
        ${LC.equipo.map((u) => `
          <label class="row-count"><span>${esc(u.nombre)}<small>${esc((LC.ROLES[u.rol] || {}).nombre || u.rol)}</small></span>
          <select name="p_${u.id}"><option value="">No trabaja hoy</option>${LC.AREAS.map((a) => `<option ${sel(u.id) === a ? 'selected' : ''}>${a}</option>`).join('')}</select></label>`).join('')}
        <p class="muted">¿Alguien sin usuario en la app?</p>
        ${[1, 2].map((i) => `<div class="row-count"><input name="xn${i}" placeholder="Nombre"><select name="xa${i}">${LC.AREAS.map((a) => `<option>${a}</option>`).join('')}</select></div>`).join('')}
        ${nav('Siguiente: bebidas')}
      </form>`;
    } else if (W.paso === 1 || W.paso === 2) {
      const tipo = W.paso === 1 ? 'bebidas' : 'utensilios';
      body = `<form class="card form" data-submit="apConteo">
        <h2>Cuenta ${tipo === 'bebidas' ? 'las bebidas' : 'los utensilios y desechables'}</h2>
        <p class="muted">Escribe lo que hay físicamente. El sistema compara al final con lo que debería haber.</p>
        <input type="hidden" name="_tipo" value="${tipo}">
        ${LC.db[tipo].map((it) => campoConteo(it, W[tipo] ? W[tipo][it.id] : null)).join('')}
        ${nav(tipo === 'bebidas' ? 'Siguiente: utensilios' : 'Siguiente: cuentas')}
      </form>`;
    } else if (W.paso === 3) {
      body = `<form class="card form" data-submit="apSaldos">
        <h2>Arqueo de cuentas</h2>
        <p class="muted">Cuenta el efectivo de la caja y revisa en la app de cada banco cuánto hay ahora mismo.</p>
        ${LC.CUENTAS.map((c) => `<label class="row-count"><span>${c}</span><input type="number" name="s_${c}" min="0" step="1" inputmode="numeric" required value="${W.saldos ? W.saldos[c] : ''}"></label>`).join('')}
        ${nav('Revisar')}
      </form>`;
    } else {
      const tabla = (tipo) => `<table class="tbl"><thead><tr><th>${LC.INV[tipo]}</th><th>Sistema</th><th>Contado</th><th>Dif.</th></tr></thead><tbody>${LC.db[tipo].map((it) => {
        const s = LC.num(it.stock), c = LC.num(W[tipo][it.id]);
        return `<tr><td>${esc(it.nombre)}</td><td>${LC.q(s)}</td><td>${LC.q(c)}</td><td class="${difClase(c - s)}">${c - s ? signo(c - s) : ''}</td></tr>`;
      }).join('')}</tbody></table>`;
      const difS = LC.CUENTAS.map((c) => [c, W.saldos[c] - Math.round(LC.db.saldos[c] || 0)]);
      const hayDif = difS.some(([, v]) => v !== 0);
      body = `<form class="card form" data-submit="apConfirmar">
        <h2>Revisa antes de abrir</h2>
        <p class="muted">Personal: ${W.personal.map((p) => `${esc(p.nombre)} (${p.area})`).join(', ')}</p>
        <table class="tbl"><thead><tr><th>Cuenta</th><th>Según sistema</th><th>Contado</th><th>Dif.</th></tr></thead><tbody>
        ${difS.map(([c, v]) => `<tr><td>${c}</td><td>${LC.fmt(LC.db.saldos[c])}</td><td>${LC.fmt(W.saldos[c])}</td><td class="${difClase(v)}">${v ? signoPesos(v) : ''}</td></tr>`).join('')}
        </tbody></table>
        ${tabla('bebidas')}${tabla('utensilios')}
        ${hayDif ? '<label>Explica la diferencia en cuentas<textarea name="nota" required rows="2" placeholder="Ej. el dueño retiró $50.000 en la mañana"></textarea></label>' : '<label>Nota (opcional)<textarea name="nota" rows="2"></textarea></label>'}
        ${nav('Abrir caja y enviar reporte')}
      </form>`;
    }
    return `<div class="page-head"><h1>Abrir caja</h1></div>${stepper(PASOS_AP, W.paso)}${body}`;
  };

  LC.A.apPersonal = (d) => {
    const personal = [];
    LC.equipo.forEach((u) => { if (d['p_' + u.id]) personal.push({ id: u.id, nombre: u.nombre, area: d['p_' + u.id] }); });
    [1, 2].forEach((i) => { const n = (d['xn' + i] || '').trim(); if (n) personal.push({ id: null, nombre: n, area: d['xa' + i] }); });
    if (!personal.length) return LC.toast('Marca quién trabaja hoy', 'error');
    if (!personal.some((p) => p.area === 'Cocina')) return LC.toast('Indica quién está en cocina hoy', 'error');
    W.personal = personal; W.paso = 1; LC.render();
  };
  LC.A.apConteo = (d) => { W[d._tipo] = leerConteo(LC.db[d._tipo], d); W.paso++; LC.render(); };
  LC.A.apSaldos = (d) => { W.saldos = Object.fromEntries(LC.CUENTAS.map((c) => [c, Math.round(LC.num(d['s_' + c]))])); W.paso = 4; LC.render(); };

  LC.A.apConfirmar = async (d, f) => {
    if (LC.turno()) return LC.toast('La caja ya está abierta', 'error');
    const btn = f.querySelector('button.primary');
    btn.disabled = true;
    try {
      // El servidor registra el personal, los conteos, el arqueo (con sus ajustes en el libro) y el stock
      await LC.accionTurno('abrir', { personal: W.personal, bebidas: W.bebidas, utensilios: W.utensilios, saldos: W.saldos, nota: (d.nota || '').trim() });
    } catch (e) {
      btn.disabled = false;
      return LC.toast(e.message, 'error');
    }
    const t = LC.turno();
    LC.log('Apertura de caja', `Personal: ${W.personal.map((p) => p.nombre).join(', ')}`);
    LC.save();
    if (t) LC.whatsapp(msgApertura(t));
    W = null;
    LC.toast('Caja abierta');
    LC.go('inicio');
  };

  function msgApertura(t) {
    const a = t.apertura, L = [];
    L.push(`*APERTURA DE CAJA, ${LC.db.config.negocio.toUpperCase()}*`);
    L.push(`📅 ${LC.fechaLarga(t.abiertoEn)}, ${LC.hora(t.abiertoEn)}`, `👤 Abre: ${t.abiertoPor}`);
    L.push(`👥 Personal: ${t.personal.map((p) => `${p.nombre} (${p.area})`).join(', ')}`, '');
    L.push('*💵 Saldos al abrir*');
    LC.CUENTAS.forEach((c) => {
      const dif = a.saldosContados[c] - Math.round(a.saldosSistema[c] || 0);
      L.push(`• ${c}: ${LC.fmt(a.saldosContados[c])}${dif ? ` ⚠️ dif. ${signoPesos(dif)}` : ''}`);
    });
    ['bebidas', 'utensilios'].forEach((tipo) => {
      L.push('', `*${tipo === 'bebidas' ? '🥤 Bebidas' : '🍴 Utensilios'}*`);
      LC.db[tipo].forEach((it) => {
        const dif = a.difInv[tipo][it.id];
        L.push(`• ${it.nombre}: ${LC.q(a[tipo][it.id])}${dif ? ` ⚠️ (${signo(dif)} vs sistema)` : ''}`);
      });
    });
    if (a.nota) L.push('', `📝 ${a.nota}`);
    return L.join('\n');
  }

  /* ================= CAJA DEL TURNO ================= */
  LC.V.caja = () => {
    if (!LC.guard('turno.operar', 'caja.movimientos', 'inventario.entradas')) return LC.sinPermiso();
    const t = LC.turno();
    if (!t && LC.esperandoCocina()) return esperandoCocinaHTML();
    if (!t) return `<div class="empty big"><h2>La caja está cerrada</h2>
      <p>Al abrir se registra el personal del día, el conteo de bebidas y utensilios, y lo que hay en cada cuenta.</p>
      ${LC.can('turno.operar') ? '<button class="btn primary lg" data-a="go" data-v="apertura">Abrir caja</button>' : '<p class="muted">Espera a que la encargada abra la caja.</p>'}</div>`;
    const r = LC.resumenTurno(t);
    const movs = LC.db.movimientos.filter((m) => m.turnoId === t.id && m.tipo !== 'venta').slice().reverse();
    const ents = LC.db.entradas.filter((e) => e.turnoId === t.id).slice().reverse();
    return `
    <div class="page-head"><h1>Caja del turno</h1><p class="muted">Abierta por ${esc(t.abiertoPor)} a las ${LC.hora(t.abiertoEn)}</p></div>
    <div class="stat-row">
      <div class="stat"><span>Ventas</span><strong class="num">${LC.fmt(r.ventas)}</strong></div>
      <div class="stat"><span>Gastos</span><strong class="num neg">${LC.fmt(r.gastos)}</strong></div>
      <div class="stat"><span>Cuentas cerradas</span><strong class="num">${r.ordenesPagadas}</strong></div>
    </div>
    <div class="actions-grid">
      ${LC.can('caja.movimientos') ? `
        <button class="btn" data-a="movNuevo" data-tipo="gasto">Registrar gasto</button>
        <button class="btn" data-a="movNuevo" data-tipo="ingreso">Registrar ingreso</button>
        <button class="btn" data-a="trasladoNuevo">Pasar dinero entre cuentas</button>` : ''}
      ${LC.guard('inventario.entradas', 'cocina.inventario') ? '<button class="btn" data-a="entradaNueva">Llegó mercancía</button>' : ''}
    </div>
    ${LC.can('turno.operar') ? '<button class="btn dark lg block" data-a="go" data-v="cierre">Cerrar caja</button>' : ''}
    ${LC.can('pos.cobrar') ? `<h3 class="sec">Impresora</h3>
    <div class="card"><label class="check"><input type="checkbox" data-ch="estacionCambiar" ${LC.estacionActiva() ? 'checked' : ''}><span>Imprimir en este equipo las comandas, pre-cuentas y recibos</span></label>
      <p class="muted">Actívalo solo en el PC de caja que tiene la impresora, y deja la app abierta ahí.</p>
      <button class="btn sm" data-a="impresionesVer">Ver impresiones y reimprimir</button></div>` : ''}
    <h3 class="sec">Personal de hoy</h3>
    <div class="chips static">${t.personal.map((p) => `<span class="chip">${esc(p.nombre)}, ${p.area}</span>`).join('')}</div>
    <h3 class="sec">Gastos, ingresos y traslados</h3>
    <div class="card">${movs.length ? movs.map((m) => `<div class="mov"><div><strong>${esc(m.concepto)}</strong><small>${LC.hora(m.fecha)}, ${esc(m.cuenta)}, ${esc(m.usuario)}</small></div><span class="num ${m.monto < 0 ? 'neg' : 'pos'}">${LC.fmt(m.monto)}</span></div>`).join('') : '<p class="muted">Sin movimientos todavía.</p>'}</div>
    <h3 class="sec">Mercancía recibida</h3>
    <div class="card">${ents.length ? ents.map((e) => `<div class="mov"><div><strong>${esc(e.nombre)}: +${LC.q(e.cantidad)} ${esc(e.unidad)}</strong><small>${LC.hora(e.fecha)}, ${esc(e.usuario)}${e.nota ? ', ' + esc(e.nota) : ''}</small></div><span class="num">${e.costo ? LC.fmt(e.costo) : ''}</span></div>`).join('') : '<p class="muted">No ha llegado mercancía en este turno.</p>'}</div>`;
  };

  LC.A.movNuevo = (d) => {
    const g = d.tipo === 'gasto';
    LC.modal(`${LC.modalHead(g ? 'Registrar gasto' : 'Registrar ingreso')}
      <form class="form" data-submit="movGuardar">
        <input type="hidden" name="tipo" value="${d.tipo}">
        <label>Concepto<input name="concepto" required placeholder="${g ? 'Ej. pilas para el datáfono, gas' : 'Ej. base que trajo el dueño'}"></label>
        <label>Categoría<select name="categoria">${(g ? LC.CAT_GASTO : LC.CAT_INGRESO).map((c) => `<option>${c}</option>`).join('')}</select></label>
        <label>Valor<input type="number" name="monto" min="1" step="1" inputmode="numeric" required></label>
        <fieldset class="seg"><legend>${g ? '¿De dónde salió el dinero?' : '¿A qué cuenta entró?'}</legend>
          ${LC.CUENTAS.map((c, i) => `<label><input type="radio" name="cuenta" value="${c}" ${i === 0 ? 'checked' : ''}><span>${c}</span></label>`).join('')}</fieldset>
        ${g ? '<p class="muted">Si es compra de bebidas, utensilios o insumos, usa mejor "Llegó mercancía": así también sube el inventario.</p>' : ''}
        <button class="btn primary lg block">Guardar</button>
      </form>`);
  };
  // Envía una acción de caja al servidor desde un formulario del modal
  async function enviar(f, accion, body, msg) {
    const btn = f.querySelector('button.primary');
    btn.disabled = true;
    try { await LC.accionTurno(accion, body); }
    catch (e) { btn.disabled = false; return LC.toast(e.message, 'error'); }
    LC.cerrarModal(); LC.toast(msg); LC.render();
  }

  LC.A.movGuardar = (d, f) => {
    if (!LC.turno() && !LC.can('reportes.ver')) return LC.toast('La caja está cerrada', 'error');
    const monto = Math.round(LC.num(d.monto));
    if (monto <= 0) return LC.toast('Escribe un valor mayor a 0', 'error');
    return enviar(f, 'movimiento', { tipo: d.tipo, cuenta: d.cuenta, monto, concepto: d.concepto.trim(), categoria: d.categoria }, 'Guardado');
  };

  LC.A.trasladoNuevo = () => {
    const op = (sel) => LC.CUENTAS.map((c) => `<option ${c === sel ? 'selected' : ''}>${c}</option>`).join('');
    LC.modal(`${LC.modalHead('Pasar dinero entre cuentas')}
      <form class="form" data-submit="trasladoGuardar">
        <div class="grid2"><label>Sale de<select name="desde">${op('Efectivo')}</select></label><label>Entra a<select name="hacia">${op('Bancolombia')}</select></label></div>
        <label>Valor<input type="number" name="monto" min="1" step="1" inputmode="numeric" required></label>
        <label>Detalle<input name="concepto" placeholder="Ej. consignación en corresponsal"></label>
        <button class="btn primary lg block">Registrar traslado</button>
      </form>`);
  };
  LC.A.trasladoGuardar = (d, f) => {
    const monto = Math.round(LC.num(d.monto));
    if (d.desde === d.hacia) return LC.toast('Elige dos cuentas diferentes', 'error');
    if (monto <= 0) return LC.toast('Escribe un valor mayor a 0', 'error');
    return enviar(f, 'traslado', { desde: d.desde, hacia: d.hacia, monto, concepto: d.concepto.trim() }, 'Traslado registrado');
  };

  /* ---------- llegada de mercancía (bebidas, utensilios, insumos) ---------- */
  LC.A.entradaNueva = (d) => {
    if (!LC.turno()) return LC.toast('Abre la caja antes de registrar mercancía', 'error');
    const tipos = [];
    if (LC.can('inventario.entradas')) tipos.push('bebidas', 'utensilios');
    if (LC.can('cocina.inventario')) tipos.push('insumos');
    const orden = d.solo ? [d.solo].filter((x) => tipos.includes(x)) : tipos;
    LC.modal(`${LC.modalHead('Llegó mercancía')}
      <form class="form" data-submit="entradaGuardar">
        <label>¿Qué llegó?<select name="item" required><option value="">Elige un producto</option>
          ${orden.map((tp) => `<optgroup label="${LC.INV[tp]}">${LC.db[tp].map((it) => `<option value="${tp}|${it.id}">${esc(it.nombre)} (${esc(it.unidad)})</option>`).join('')}</optgroup>`).join('')}
        </select></label>
        <label>Cantidad o peso recibido<input type="number" name="cantidad" min="0.01" step="any" inputmode="decimal" required></label>
        <label>Valor total pagado (opcional)<input type="number" name="costo" min="0" step="1" inputmode="numeric"></label>
        <label>Se pagó desde<select name="cuenta"><option value="">No se pagó de la caja (crédito o lo pagó el dueño)</option>${LC.CUENTAS.map((c) => `<option>${c}</option>`).join('')}</select></label>
        <label>Proveedor o nota<input name="nota" placeholder="Ej. Postobón, factura 1234"></label>
        <button class="btn primary lg block">Registrar llegada</button>
      </form>`);
  };
  LC.A.entradaGuardar = (d, f) => {
    if (!LC.turno()) return;
    const [tipo, id] = d.item.split('|');
    const it = (LC.db[tipo] || []).find((x) => x.id === id);
    if (!it) return LC.toast('Elige un producto', 'error');
    const cant = LC.num(d.cantidad), costo = Math.round(LC.num(d.costo));
    if (cant <= 0) return LC.toast('La cantidad debe ser mayor a 0', 'error');
    if (d.cuenta && !costo) return LC.toast('Si se pagó desde una cuenta, escribe el valor pagado', 'error');
    return enviar(f, 'llegada', { itemId: id, cantidad: cant, costo, cuenta: d.cuenta || null, nota: d.nota.trim() }, `${it.nombre}: +${LC.q(cant)} registrado`);
  };

  /* ================= INVENTARIO DE COCINA ================= */
  LC.cocinaInvHTML = () => {
    const t = LC.turnoCocina();
    if (!t) return '<div class="empty"><h2>La caja está cerrada</h2><p>El inventario de cocina se maneja dentro del turno.</p></div>';
    const ent = LC.entradasTurno(t.id, 'insumos');
    const lista = LC.db.entradas.filter((e) => e.turnoId === t.id && e.tipo === 'insumos').slice().reverse();
    const cierre = t.cocina.cierre;
    return `
    ${t.cajaCerrada ? '<div class="notice"><strong>La encargada ya cerró la caja.</strong> Falta tu inventario de cierre de cocina: con él se calcula el resultado del día.</div>' : ''}
    <div class="actions-grid">
      ${t.cajaCerrada ? '' : '<button class="btn primary" data-a="entradaNueva" data-solo="insumos">Registrar llegada de insumos</button>'}
      ${cierre ? '<button class="btn" data-a="go" data-v="cocinaCierre">Volver a contar</button>' : '<button class="btn dark" data-a="go" data-v="cocinaCierre">Inventario de cierre de cocina</button>'}
    </div>
    ${cierre ? `<div class="notice ok">Inventario de cierre hecho a las ${LC.hora(cierre.en)} por ${esc(cierre.por)}.</div>` : ''}
    <h3 class="sec">Insumos en este turno</h3>
    <p class="muted">"Al abrir" es lo que contó cocina en el cierre del turno anterior.</p>
    <table class="tbl"><thead><tr><th>Insumo</th><th>Al abrir</th><th>Llegó</th><th>Debería haber</th></tr></thead><tbody>
    ${LC.db.insumos.map((i) => { const ini = LC.num(t.apertura.insumos[i.id]), e = LC.num(ent[i.id]); return `<tr><td>${esc(i.nombre)} <small>${esc(i.unidad)}</small></td><td>${LC.q(ini)}</td><td>${e ? '+' + LC.q(e) : ''}</td><td><strong>${LC.q(ini + e)}</strong></td></tr>`; }).join('')}
    </tbody></table>
    <h3 class="sec">Llegadas registradas</h3>
    <div class="card">${lista.length ? lista.map((e) => `<div class="mov"><div><strong>${esc(e.nombre)}: +${LC.q(e.cantidad)} ${esc(e.unidad)}</strong><small>${LC.hora(e.fecha)}, ${esc(e.usuario)}${e.nota ? ', ' + esc(e.nota) : ''}</small></div></div>`).join('') : '<p class="muted">Todavía no llega nada en este turno.</p>'}</div>`;
  };

  LC.V.cocinaCierre = () => {
    if (!LC.can('cocina.inventario')) return LC.sinPermiso();
    const t = LC.turnoCocina();
    if (!t) return '<div class="empty"><h2>La caja está cerrada</h2></div>';
    if (!W || W.tipo !== 'cocina') W = { tipo: 'cocina', paso: 0, conteo: null };
    if (W.paso === 0) {
      return `<div class="page-head"><h1>Inventario de cierre de cocina</h1></div>${stepper(['Contar', 'Revisar'], 0)}
      <form class="card form" data-submit="coConteo">
        <p class="muted">Pesa o cuenta todo lo que queda. Con esto se calcula cuánto material se gastó y qué hay que comprar para mañana.</p>
        ${LC.db.insumos.map((i) => campoConteo(i, W.conteo ? W.conteo[i.id] : null)).join('')}
        <div class="wiz-nav"><button type="button" class="btn ghost" data-a="wizCancelar" data-v="cocina">Cancelar</button><button class="btn primary lg">Revisar</button></div>
      </form>`;
    }
    const tmp = Object.assign({}, t, { cocina: { cierre: { conteo: W.conteo } } });
    const r = LC.resumenTurno(tmp);
    return `<div class="page-head"><h1>Inventario de cierre de cocina</h1></div>${stepper(['Contar', 'Revisar'], 1)}
    <form class="card form" data-submit="coConfirmar">
      <table class="tbl"><thead><tr><th>Insumo</th><th>Abrió</th><th>Llegó</th><th>Queda</th><th>Gastado</th><th>Costo</th></tr></thead><tbody>
      ${r.insumos.map((x) => `<tr><td>${esc(x.nombre)} <small>${esc(x.unidad)}</small></td><td>${LC.q(x.ini)}</td><td>${x.ent ? '+' + LC.q(x.ent) : ''}</td><td>${LC.q(x.fin)}</td><td class="${x.consumo < 0 ? 'neg' : ''}">${LC.q(x.consumo)}</td><td>${LC.fmt(x.costo)}</td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="5">Costo de insumos consumidos</td><td><strong>${LC.fmt(r.costoInsumos)}</strong></td></tr></tfoot></table>
      ${r.insumos.some((x) => x.consumo < 0) ? '<div class="notice bad">Hay insumos con consumo negativo: queda más de lo que debería. Revisa si faltó registrar una llegada o si el conteo está mal.</div>' : ''}
      <h3 class="sec">Compras sugeridas para mañana</h3>
      ${listaCompras(r.insumos) || '<p class="muted">Todo está sobre el stock sugerido.</p>'}
      <label>Observaciones<textarea name="obs" rows="2" placeholder="Ej. el queso llegó en mal estado"></textarea></label>
      <div class="wiz-nav"><button type="button" class="btn" data-a="wizAtras">Corregir conteo</button><button class="btn primary lg">Guardar y enviar por WhatsApp</button></div>
    </form>`;
  };
  const listaCompras = (rows) => {
    const f = rows.filter((x) => x.comprar > 0);
    return f.length ? `<ul class="compras">${f.map((x) => `<li><strong>${LC.q(x.comprar)} ${esc(x.unidad)}</strong> ${esc(x.nombre)}</li>`).join('')}</ul>` : '';
  };
  LC.A.coConteo = (d) => { W.conteo = leerConteo(LC.db.insumos, d); W.paso = 1; LC.render(); };
  LC.A.coConfirmar = async (d, f) => {
    const t = LC.turnoCocina(); if (!t) return;
    const btn = f.querySelector('button.primary');
    btn.disabled = true;
    let res;
    try { res = await LC.accionTurno('cerrar-cocina', { conteo: W.conteo, obs: (d.obs || '').trim() }); }
    catch (e) { btn.disabled = false; return LC.toast(e.message, 'error'); }
    // Mensaje de cocina: consumo y compras (sin dinero de la caja)
    const tmp = Object.assign({}, t, { cocina: { cierre: { conteo: W.conteo } } });
    const r = LC.resumenTurno(tmp);
    LC.log('Inventario de cierre de cocina', `Costo consumido ${LC.fmt(r.costoInsumos)}`);
    LC.save();
    const L = [`*INVENTARIO DE COCINA, ${LC.db.config.negocio.toUpperCase()}*`, `📅 ${LC.fechaLarga(t.abiertoEn)}`, `👨‍🍳 ${LC.user.nombre}`, '', '*📦 Consumo del turno*'];
    r.insumos.forEach((x) => L.push(`• ${x.nombre}: gastó ${LC.q(x.consumo)} ${x.unidad}, quedan ${LC.q(x.fin)}${x.consumo < 0 ? ' ⚠️' : ''}`));
    L.push('', `*Costo consumido: ${LC.fmt(r.costoInsumos)}*`, '', '*🛒 Comprar para mañana*');
    const c = r.insumos.filter((x) => x.comprar > 0);
    if (c.length) c.forEach((x) => L.push(`• ${LC.q(x.comprar)} ${x.unidad} de ${x.nombre}`)); else L.push('✅ Stock completo');
    if (d.obs && d.obs.trim()) L.push('', `📝 ${d.obs.trim()}`);
    if (res.termino) L.push('', '✅ Turno terminado. El resultado del día quedó en Reportes → Turnos.');
    LC.whatsapp(L.join('\n'));
    W = null;
    LC.toast(res.termino ? 'Inventario guardado. Turno terminado: el resultado del día quedó en Reportes.' : 'Inventario de cocina guardado');
    LC.go(res.termino ? 'inicio' : 'cocina', { tab: 'inventario' });
  };

  /* Turno esperando a cocina: aviso y opción de terminarlo sin inventario de cocina */
  function esperandoCocinaHTML() {
    const t = LC.turnoCocina();
    return `<div class="empty big"><h2>La caja ya se cerró</h2>
      <p>Falta el <strong>inventario de cierre de cocina</strong> del turno de ${LC.fecha(t.abiertoEn)}. Con ese último paso se calcula el resultado del día y se puede abrir el siguiente turno.</p>
      ${LC.can('cocina.inventario') ? '<button class="btn primary lg" data-a="go" data-v="cocinaCierre">Hacer inventario de cocina</button>' : ''}
      ${LC.can('turno.operar') ? '<button class="btn ghost" data-a="terminarSinCocina">Cocina no lo hizo: terminar el turno sin inventario de cocina</button>' : ''}</div>`;
  }
  LC.A.terminarSinCocina = async (d, el) => {
    const motivo = (prompt('¿Por qué se termina el turno sin inventario de cocina? Queda registrado.') || '').trim();
    if (!motivo) return;
    el.disabled = true;
    try { await LC.accionTurno('terminar-sin-cocina', { motivo }); }
    catch (e) { el.disabled = false; return LC.toast(e.message, 'error'); }
    LC.toast('Turno terminado sin inventario de cocina');
    LC.go('inicio');
  };

  /* ================= CIERRE DE CAJA ================= */
  const PASOS_CI = ['Bebidas', 'Utensilios', 'Cuentas', 'Revisar'];

  LC.V.cierre = () => {
    if (!LC.can('turno.operar')) return LC.sinPermiso();
    const t = LC.turno();
    if (!t && LC.esperandoCocina()) return esperandoCocinaHTML();
    if (!t) return '<div class="empty"><h2>No hay caja abierta</h2></div>';
    const abiertas = LC.db.ordenes.filter((o) => o.turnoId === t.id && o.estado === 'abierta' && !o.local);
    if (abiertas.length) {
      return `<div class="page-head"><h1>Cerrar caja</h1></div>
      <div class="card"><h2>Hay cuentas sin cerrar</h2><p class="muted">Cobra o anula estas cuentas antes de cerrar la caja.</p>
      <div class="list">${abiertas.map((o) => `<button class="list-item" data-a="ordenVer" data-id="${o.id}"><div><strong>${esc(LC.tituloOrden(o))}</strong></div><div class="right"><strong>${LC.fmt(LC.totalOrden(o))}</strong></div></button>`).join('')}</div></div>`;
    }
    if (!W || W.tipo !== 'cierre') W = { tipo: 'cierre', paso: 0, bebidas: null, utensilios: null, saldos: null };
    const nav = (txt) => `<div class="wiz-nav">${W.paso > 0 ? '<button type="button" class="btn" data-a="wizAtras">Atrás</button>' : '<button type="button" class="btn ghost" data-a="wizCancelar" data-v="caja">Cancelar</button>'}<button class="btn primary lg">${txt}</button></div>`;
    let body;

    if (W.paso <= 1) {
      const tipo = W.paso === 0 ? 'bebidas' : 'utensilios';
      body = `<form class="card form" data-submit="ciConteo"><input type="hidden" name="_tipo" value="${tipo}">
        <h2>Conteo final de ${tipo === 'bebidas' ? 'bebidas' : 'utensilios y desechables'}</h2>
        <p class="muted">Cuenta lo que queda físicamente. El sistema calcula lo que se vendió o gastó.</p>
        ${LC.db[tipo].map((it) => campoConteo(it, W[tipo] ? W[tipo][it.id] : null)).join('')}
        ${nav('Siguiente')}</form>`;
    } else if (W.paso === 2) {
      body = `<form class="card form" data-submit="ciSaldos">
        <h2>Arqueo final</h2>
        <p class="muted">Cuenta el efectivo de la caja y revisa el saldo de cada cuenta. El datáfono es lo que muestra el cierre del datáfono.</p>
        ${LC.CUENTAS.map((c) => `<label class="row-count"><span>${c}</span><input type="number" name="s_${c}" min="0" step="1" inputmode="numeric" required value="${W.saldos ? W.saldos[c] : ''}"></label>`).join('')}
        ${nav('Revisar cierre')}</form>`;
    } else {
      const tmp = Object.assign({}, t, { cierre: { bebidas: W.bebidas, utensilios: W.utensilios } });
      const r = LC.resumenTurno(tmp);
      const desc = LC.CUENTAS.map((c) => [c, Math.round(LC.db.saldos[c] || 0), W.saldos[c]]);
      const hayDesc = desc.some(([, e, k]) => e !== k);
      const hayDifB = r.bebidas.some((b) => b.dif);
      body = `<form class="card form" data-submit="ciConfirmar">
        <h2>Resumen del turno</h2>
        <div class="stat-row">
          <div class="stat"><span>Ventas</span><strong class="num">${LC.fmt(r.ventas)}</strong></div>
          <div class="stat"><span>Gastos</span><strong class="num neg">${LC.fmt(r.gastos)}</strong></div>
          <div class="stat"><span>Utilidad estimada</span><strong class="num ${r.utilidad < 0 ? 'neg' : 'pos'}">${LC.fmt(r.utilidad)}</strong></div>
        </div>
        <h3 class="sec">Arqueo de cuentas</h3>
        <table class="tbl"><thead><tr><th>Cuenta</th><th>Debería haber</th><th>Contado</th><th>Diferencia</th></tr></thead><tbody>
        ${desc.map(([c, e, k]) => `<tr><td>${c}</td><td>${LC.fmt(e)}</td><td>${LC.fmt(k)}</td><td class="${difClase(k - e)}">${k - e ? (k - e > 0 ? 'Sobran ' : 'Faltan ') + LC.fmt(Math.abs(k - e)) : 'Cuadra'}</td></tr>`).join('')}
        </tbody></table>
        <h3 class="sec">Bebidas</h3>
        <table class="tbl"><thead><tr><th>Bebida</th><th>Abrió</th><th>Llegó</th><th>Queda</th><th>Vendidas</th><th>En POS</th><th>Valor</th></tr></thead><tbody>
        ${r.bebidas.map((b) => `<tr><td>${esc(b.nombre)}</td><td>${LC.q(b.ini)}</td><td>${b.ent ? '+' + LC.q(b.ent) : ''}</td><td>${LC.q(b.fin)}</td><td>${LC.q(b.consumo)}</td><td class="${b.dif ? 'neg' : ''}">${LC.q(b.pos)}</td><td>${LC.fmt(b.valor)}</td></tr>`).join('')}
        </tbody><tfoot><tr><td colspan="6">Venta de bebidas según conteo</td><td><strong>${LC.fmt(r.ventaBebidasConteo)}</strong></td></tr></tfoot></table>
        ${hayDifB ? '<div class="notice bad">Hay bebidas que salieron del inventario y no se registraron en el POS (o al revés). Revisa antes de cerrar.</div>' : ''}
        ${r.cocinaCerrada ? '' : '<div class="notice">Cocina aún no hace su inventario de cierre. El costo de insumos no entra en la utilidad de hoy.</div>'}
        <h3 class="sec">Compras sugeridas para mañana</h3>
        ${listaCompras(r.bebidas.concat(r.utensilios, r.cocinaCerrada ? r.insumos : [])) || '<p class="muted">Todo está sobre el stock sugerido.</p>'}
        <label>${hayDesc || hayDifB ? 'Explica las diferencias' : 'Observaciones (opcional)'}<textarea name="obs" rows="3" ${hayDesc || hayDifB ? 'required' : ''}></textarea></label>
        ${nav('Cerrar caja y enviar reporte')}</form>`;
    }
    return `<div class="page-head"><h1>Cerrar caja</h1></div>${stepper(PASOS_CI, W.paso)}${body}`;
  };
  LC.A.ciConteo = (d) => { W[d._tipo] = leerConteo(LC.db[d._tipo], d); W.paso++; LC.render(); };
  LC.A.ciSaldos = (d) => { W.saldos = Object.fromEntries(LC.CUENTAS.map((c) => [c, Math.round(LC.num(d['s_' + c]))])); W.paso = 3; LC.render(); };

  LC.A.ciConfirmar = async (d, f) => {
    const t = LC.turno(); if (!t || !W) return;
    const r = LC.resumenTurno(Object.assign({}, t, { cierre: { bebidas: W.bebidas, utensilios: W.utensilios } }));
    const btn = f.querySelector('button.primary');
    btn.disabled = true;
    let res;
    try {
      res = await LC.accionTurno('cerrar-caja', { bebidas: W.bebidas, utensilios: W.utensilios, saldos: W.saldos, obs: (d.obs || '').trim() });
    } catch (e) {
      btn.disabled = false;
      return LC.toast(e.message, 'error');
    }
    const cerrado = LC.db.turnos.find((x) => x.id === res.turnoId);
    LC.log('Cierre de caja', `Ventas ${LC.fmt(r.ventas)}`);
    LC.save();
    if (cerrado) LC.whatsapp(LC.msgCierre(cerrado));
    W = null;
    LC.toast(res.termino ? 'Caja cerrada. Turno terminado.' : 'Caja cerrada. Falta el inventario de cocina.');
    LC.go('inicio');
  };

  LC.msgCierre = (t) => {
    const r = t.resumen || LC.resumenTurno(t);
    const ci = t.cierre || {};
    const L = [];
    L.push(`*CIERRE DE CAJA, ${LC.db.config.negocio.toUpperCase()}*`);
    L.push(`📅 ${LC.fechaLarga(t.abiertoEn)}, ${LC.hora(t.abiertoEn)} a ${LC.hora(t.cerradoEn || new Date().toISOString())}`);
    L.push(`👤 Abrió ${t.abiertoPor}, cerró la caja ${ci.por || ''}`);
    L.push('', `*💰 VENTAS: ${LC.fmt(r.ventas)}*`, `${r.ordenesPagadas} cuentas, ticket promedio ${LC.fmt(r.ticketProm)}`);
    LC.CUENTAS.forEach((c) => L.push(`• ${c}: ${LC.fmt(r.ventasCuenta[c] || 0)}`));
    const cats = Object.entries(r.porCategoria).sort((a, b) => b[1] - a[1]);
    if (cats.length) { L.push('', '*🍕 Por categoría*'); cats.forEach(([c, v]) => L.push(`• ${c}: ${LC.fmt(v)}`)); }
    L.push('', `*🥤 BEBIDAS SEGÚN CONTEO: ${LC.fmt(r.ventaBebidasConteo)}*`);
    r.bebidas.filter((b) => b.consumo).forEach((b) => L.push(`• ${b.nombre}: ${LC.q(b.consumo)} (${LC.fmt(b.valor)})${b.dif ? ` ⚠️ POS registró ${LC.q(b.pos)}` : ''}`));
    L.push('', `*🧾 GASTOS: ${LC.fmt(r.gastos)}*`);
    r.gastosLista.forEach((g) => L.push(`• ${g.concepto}: ${LC.fmt(g.valor)} (${g.cuenta})`));
    if (ci.saldosContados) {
      L.push('', '*🏦 ARQUEO*');
      LC.CUENTAS.forEach((c) => {
        const dif = (ci.descuadre || {})[c] || 0;
        L.push(`• ${c}: ${LC.fmt(ci.saldosContados[c])} ${dif ? `⚠️ ${dif > 0 ? 'sobran' : 'faltan'} ${LC.fmt(Math.abs(dif))}` : '✅'}`);
      });
    }
    const sinCocina = t.cocina && t.cocina.cierre && t.cocina.cierre.sinInventario;
    L.push('', '*📊 RESULTADO DEL DÍA*');
    if (!r.cocinaCerrada && t.estado !== 'cerrado') {
      L.push('⏳ Se calcula cuando cocina haga su inventario de cierre (último paso de la noche).');
    } else {
      L.push(`Costo de lo consumido: ${LC.fmt(r.costoConsumo)}${r.cocinaCerrada ? '' : ' (sin inventario de cocina)'}`);
      L.push(`Gastos operativos: ${LC.fmt(r.gastosOp)}`, `*Utilidad estimada: ${LC.fmt(r.utilidad)}*`);
      if (sinCocina) L.push(`⚠️ Terminado sin inventario de cocina: ${t.cocina.cierre.motivo}`);
    }
    if (r.anulaciones) L.push(`⚠️ Anulaciones en el turno: ${r.anulaciones}`);
    const comp = r.bebidas.concat(r.utensilios, r.cocinaCerrada ? r.insumos : []).filter((x) => x.comprar > 0);
    L.push('', '*🛒 COMPRAR PARA MAÑANA*');
    if (comp.length) comp.forEach((x) => L.push(`• ${LC.q(x.comprar)} ${x.unidad} de ${x.nombre}`)); else L.push('✅ Todo sobre el stock sugerido');
    L.push('', `👥 ${r.personal.map((p) => `${p.nombre} (${p.area})`).join(', ')}`);
    if (ci.obs) L.push('', `📝 ${ci.obs}`);
    return L.join('\n');
  };
})();
