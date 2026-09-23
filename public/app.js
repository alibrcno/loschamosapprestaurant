/* =====================================================================
   Los Chamos POS v2 — Núcleo: navegación, login, inicio, ajustes y usuarios
   ===================================================================== */
'use strict';
(function () {
  const LC = window.LC;
  const $ = (s) => document.querySelector(s);
  const esc = LC.esc;
  LC.$ = $;
  LC.V = {}; // vistas
  LC.A = {}; // acciones
  LC.state = { view: 'inicio', params: {} };

  /* ---------------- UI base ---------------- */
  let toastTimer;
  LC.toast = (msg, tipo = 'ok') => {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast show ' + tipo;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.className = 'toast'), 3500);
  };

  LC.modal = (html, wide = false) => {
    $('#modal-root').innerHTML = `<div class="modal-back" data-a="modalFondo"><div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
  };
  LC.cerrarModal = () => ($('#modal-root').innerHTML = '');
  LC.modalHead = (t) => `<div class="modal-head"><h2>${esc(t)}</h2><button type="button" class="icon-btn" data-a="cerrarModal" aria-label="Cerrar">✕</button></div>`;
  LC.A.modalFondo = (d, el, ev) => { if (ev.target === el) LC.cerrarModal(); };
  LC.A.cerrarModal = () => LC.cerrarModal();

  LC.go = (view, params = {}) => {
    LC.state = { view, params }; LC.cerrarModal(); LC.render(); window.scrollTo(0, 0);
    // Trae lo que cambiaron otros equipos: menú y precios, y el estado de la caja
    if (!LC.user) return;
    const tareas = [];
    if (view === 'pos' || view === 'ajustes' || view === 'almacen') tareas.push(LC.cargarCatalogo());
    if (view === 'almacen' && LC.almacenOlvidar) LC.almacenOlvidar();
    if (['inicio', 'pos', 'caja', 'cocina', 'reportes', 'apertura', 'cierre'].includes(view)) tareas.push(LC.cargarTurno());
    if (['inicio', 'pos', 'orden', 'caja', 'cocina', 'reportes', 'cierre'].includes(view)) tareas.push(LC.cargarPedidos());
    if (tareas.length) Promise.all(tareas).then(() => refrescarSiSePuede(view)).catch(() => {});
  };
  // Vuelve a dibujar con datos nuevos solo si nadie está escribiendo ni en un asistente
  const ASISTENTES = ['apertura', 'cierre', 'cocinaCierre'];
  function refrescarSiSePuede(view) {
    const el = document.activeElement, escribiendo = el && el.closest('#main') && el.matches('input, select, textarea');
    if (LC.state.view === view && !ASISTENTES.includes(view) && !$('#modal-root').innerHTML && !escribiendo) LC.render();
  }
  LC.A.go = (d) => LC.go(d.v, Object.assign({}, d));

  LC.guard = (...perms) => perms.some(LC.can);
  LC.sinPermiso = () => `<div class="empty"><h2>Sin acceso</h2><p>Tu usuario no tiene permiso para esta sección. Pídele al administrador que te lo asigne.</p></div>`;
  LC.tabs = (items, activo, v) =>
    `<div class="tabs" role="tablist">${items.map(([k, t]) => `<button class="tab${k === activo ? ' on' : ''}" data-a="go" data-v="${v}" data-tab="${k}">${t}</button>`).join('')}</div>`;

  LC.render = () => {
    if (!LC.user) return renderLogin();
    document.body.classList.remove('is-login');
    const v = LC.V[LC.state.view] || LC.V.inicio;
    $('#main').innerHTML = v(LC.state.params || {});
    renderTop();
    renderNav();
  };

  /* ---------------- impresión de tickets ---------------- */
  LC.imprimir = (html) => {
    const w = LC.num(LC.db.config.ticket) === 80 ? 80 : 58;
    const fr = $('#print-frame');
    const doc = fr.contentDocument;
    doc.open();
    doc.write(`<!doctype html><html><head><meta charset="utf-8"><style>
      @page { margin: 0; size: ${w}mm auto; }
      body { font-family: 'Courier New', monospace; font-size: 12px; width: ${w - 6}mm; margin: 0 auto; padding: 3mm 0; color: #000; }
      .c { text-align: center; } .b { font-weight: bold; } .big { font-size: 17px; } .s { font-size: 10px; }
      .hr { border-top: 1px dashed #000; margin: 5px 0; } .r { display: flex; justify-content: space-between; gap: 6px; }
      .ind { padding-left: 10px; }
    </style></head><body>${html}</body></html>`);
    doc.close();
    // Devuelve una promesa: el PC de caja espera a que salga un ticket antes de mandar el siguiente
    return new Promise((ok) => setTimeout(() => { fr.contentWindow.focus(); fr.contentWindow.print(); setTimeout(ok, 800); }, 250));
  };

  /* ---------------- estación de impresión (el PC de caja, que tiene la impresora) ---------------- */
  // Las comandas, pre-cuentas y recibos que piden las meseras desde su celular quedan en una cola
  // en el servidor. El equipo marcado como estación revisa la cola cada pocos segundos y los imprime.
  const EST = 'lc2_estacion';
  LC.estacionActiva = () => { try { return localStorage.getItem(EST) === '1' && LC.can('pos.cobrar'); } catch (e) { return false; } };
  LC.A.estacionCambiar = (d, el) => {
    try { localStorage.setItem(EST, el.checked ? '1' : '0'); } catch (e) { return LC.toast('Este navegador no deja guardar la opción', 'error'); }
    LC.toast(el.checked ? 'Este equipo imprime lo que manden las meseras' : 'Este equipo ya no imprime automáticamente');
    if (el.checked) LC.revisarImpresion();
  };
  let imprimiendo = false;
  LC.revisarImpresion = async () => {
    if (imprimiendo || !LC.user || !LC.estacionActiva() || !LC.ticketDe) return;
    imprimiendo = true;
    try {
      const r = await LC.api('impresion', { method: 'POST', body: { accion: 'tomar' } });
      for (const j of r.trabajos) await LC.imprimir(LC.ticketDe(j));
    } catch (e) { console.warn('No se pudo revisar la cola de impresión', e); }
    finally { imprimiendo = false; }
  };
  LC.A.impresionesVer = async () => {
    let r;
    try { r = await LC.api('impresion'); } catch (e) { return LC.toast(e.message, 'error'); }
    LC.modal(`${LC.modalHead('Impresiones del turno')}
      <p class="muted">Lo último que se mandó a imprimir. Si un papel no salió o se dañó, sácalo otra vez.</p>
      <div class="list">${r.trabajos.map((j) => `<div class="list-item"><div><strong>${esc(j.titulo)}</strong><small>${LC.hora(j.creadoEn)}, pidió ${esc(j.pidio || '')}${j.impresoEn ? '' : ', en espera'}</small></div>
        <button class="btn sm" data-a="reimprimir" data-id="${j.id}">Imprimir</button></div>`).join('') || '<p class="empty">Todavía no se ha impreso nada en este turno.</p>'}</div>`);
  };
  LC.A.reimprimir = async (d, el) => {
    el.disabled = true;
    try {
      const r = await LC.api('impresion', { method: 'POST', body: { accion: 'reimprimir', id: d.id } });
      await LC.imprimir(LC.ticketDe(r.trabajos[0]));
    } catch (e) { LC.toast(e.message, 'error'); }
    el.disabled = false;
  };

  LC.whatsapp = (msg) => {
    const n = String(LC.db.config.whatsapp || '').replace(/\D/g, '');
    window.open(`https://wa.me/${n}?text=${encodeURIComponent(msg)}`, '_blank');
  };

  /* ---------------- despachador de eventos ---------------- */
  const correr = (fn, ...args) => {
    try {
      const r = fn(...args);
      if (r && r.catch) r.catch((e) => { console.error(e); LC.toast('Error: ' + e.message, 'error'); });
    } catch (e) { console.error(e); LC.toast('Error: ' + e.message, 'error'); }
  };
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-a]');
    if (!el) return;
    const fn = LC.A[el.dataset.a];
    if (fn) correr(fn, el.dataset, el, ev);
  });
  document.addEventListener('submit', (ev) => {
    const f = ev.target.closest('form[data-submit]');
    if (!f) return;
    ev.preventDefault();
    const fn = LC.A[f.dataset.submit];
    if (fn) correr(fn, Object.fromEntries(new FormData(f)), f, ev);
  });
  document.addEventListener('change', (ev) => {
    const el = ev.target.closest('[data-ch]');
    if (el && LC.A[el.dataset.ch]) correr(LC.A[el.dataset.ch], el.dataset, el, ev);
  });
  document.addEventListener('input', (ev) => {
    const el = ev.target.closest('[data-in]');
    if (el && LC.A[el.dataset.in]) correr(LC.A[el.dataset.in], el.dataset, el, ev);
  });

  /* ---------------- encabezado y navegación ---------------- */
  function renderTop() {
    const t = LC.turno();
    const rol = (LC.ROLES[LC.user.rol] || {}).nombre || LC.user.rol;
    $('#top').innerHTML = `
      <div class="brand">${esc(LC.db.config.negocio)}</div>
      <div class="turno-pill ${t ? 'on' : 'off'}">${t ? 'Caja abierta ' + LC.hora(t.cajaAbiertaEn || t.abiertoEn) : LC.esperandoCocina() ? 'Esperando cocina' : LC.soloCocina() ? 'Cocina abierta' : 'Caja cerrada'}</div>
      <div class="who"><span>${esc(LC.user.nombre)}<small>${esc(rol)}</small></span><button class="link" data-a="salir">Salir</button></div>`;
  }
  const NAV = [
    { v: 'inicio', ico: '⌂', t: 'Inicio', ok: () => true },
    { v: 'pos', ico: '🍽', t: 'Pedidos', also: ['orden'], ok: () => LC.guard('pos.tomar', 'pos.cobrar', 'pos.precuenta') },
    { v: 'cocina', ico: '🔥', t: 'Cocina', also: ['cocinaCierre'], ok: () => LC.guard('cocina.comandas', 'cocina.inventario') },
    { v: 'caja', ico: '💵', t: 'Caja', also: ['apertura', 'cierre'], ok: () => LC.guard('turno.operar', 'caja.movimientos', 'inventario.entradas') },
    { v: 'reportes', ico: '📊', t: 'Reportes', ok: () => LC.can('reportes.ver') },
    { v: 'almacen', ico: '📦', t: 'Almacén', ok: () => LC.can('almacen.gestionar') },
    { v: 'ajustes', ico: '⚙', t: 'Ajustes', ok: () => LC.guard('catalogo.editar', 'usuarios.gestionar') }
  ];
  function renderNav() {
    const v = LC.state.view;
    $('#nav').innerHTML = NAV.filter((n) => n.ok()).map((n) =>
      `<button class="nav-i${v === n.v || (n.also || []).includes(v) ? ' on' : ''}" data-a="go" data-v="${n.v}"><span aria-hidden="true">${n.ico}</span>${n.t}</button>`
    ).join('');
  }
  const inicioPorRol = (u) => (u.rol === 'cocina' ? 'cocina' : u.rol === 'mesera' ? 'pos' : 'inicio');

  /* ---------------- ingreso (validado en el servidor) ---------------- */
  // El código del negocio se recuerda en este equipo para no escribirlo cada vez
  const COD = 'lc2_codigo';
  const codigoGuardado = () => { try { return localStorage.getItem(COD) || ''; } catch (e) { return ''; } };

  function renderLogin() {
    document.body.classList.add('is-login');
    $('#top').innerHTML = '';
    $('#nav').innerHTML = '';
    $('#main').innerHTML = `
    <div class="login">
      <div class="login-brand"><div class="logo-mark">LC</div><h1>${esc(LC.db.config.negocio)}</h1><p>Punto de venta y control de turno</p></div>
      <form class="card form" data-submit="login">
        <h2>Ingresar</h2>
        <label>Código del negocio<input name="codigo" required autocapitalize="none" autocomplete="organization" value="${esc(codigoGuardado())}"></label>
        <label>Usuario<input name="usuario" required autocapitalize="none" autocomplete="username"></label>
        <label>Contraseña<input type="password" name="clave" required autocomplete="current-password"></label>
        <button class="btn primary lg block">Ingresar</button>
      </form>
      <p class="version">v${LC.VERSION}</p>
    </div>`;
  }

  // Trae del servidor quién está conectado (y el personal, si le toca abrir caja)
  async function cargarSesion() {
    const r = await LC.api('auth/yo');
    LC.user = Object.assign({ activo: true }, r.usuario);
    LC.negocio = r.negocio;
    await LC.cargarEquipo();
    try { await LC.cargarCatalogo(); } catch (e) { console.warn('No se pudo cargar el menú del servidor', e); }
    try { await LC.cargarTurno(); } catch (e) { console.warn('No se pudo cargar el turno del servidor', e); }
    try { await LC.cargarPedidos(true); } catch (e) { LC.armarPedidos(); console.warn('No se pudieron cargar los pedidos', e); }
  }
  LC.cargarEquipo = async () => {
    if (!LC.can('turno.operar')) return;
    try { LC.equipo = (await LC.api('equipo')).equipo; } catch (e) { console.warn('No se pudo cargar el personal', e); }
  };

  LC.A.login = async (d, f) => {
    const btn = f.querySelector('button');
    btn.disabled = true;
    try {
      await LC.api('auth/login', { method: 'POST', body: { codigo: d.codigo, usuario: d.usuario, clave: d.clave } });
      try { localStorage.setItem(COD, d.codigo.trim().toLowerCase()); } catch (e) { /* sin almacenamiento */ }
      await cargarSesion();
    } catch (e) {
      btn.disabled = false;
      return LC.toast(e.message, 'error');
    }
    LC.log('Inicio de sesión');
    LC.save();
    LC.go(inicioPorRol(LC.user));
  };

  LC.A.salir = async () => {
    LC.log('Cierre de sesión');
    LC.save();
    LC.user = null;
    LC.equipo = [];
    usuariosSrv = null;
    if (LC.wizReset) LC.wizReset();
    LC.cerrarModal();
    LC.render();
    try { await LC.api('auth/logout', { method: 'POST' }); } catch (e) { /* la cookie vence sola */ }
  };

  /* ---------------- inicio ---------------- */
  LC.V.inicio = () => {
    const t = LC.turno();
    const r = t ? LC.resumenTurno(t) : null;
    const can = LC.can;
    const abiertas = t ? LC.db.ordenes.filter((o) => o.turnoId === t.id && o.estado === 'abierta' && o.lineas.length) : [];
    const comandas = t ? LC.db.ordenes.filter((o) => o.turnoId === t.id).reduce((a, o) => a + o.comandas.filter((c) => c.estado === 'pendiente').length, 0) : 0;
    const acc = [];
    if (t && can('pos.tomar')) acc.push(['pos', 'Tomar pedido', 'Mesas y domicilios']);
    if (t && can('cocina.comandas')) acc.push(['cocina', 'Comandas', `${comandas} en preparación`]);
    if (t && can('caja.movimientos')) acc.push(['caja', 'Gastos y caja', 'Registrar de qué cuenta salió']);
    if (t && can('turno.operar')) acc.push(['cierre', 'Cerrar caja', 'Conteo final y reporte']);
    if (can('reportes.ver')) acc.push(['reportes', 'Finanzas', 'Saldos, turnos y mes']);
    if (can('catalogo.editar')) acc.push(['ajustes', 'Menú y precios', 'Productos, pizzas e insumos']);

    return `
    <section class="hero-turno ${t ? 'abierto' : 'cerrado'}">
      <p class="ht-estado">${t ? 'Caja abierta desde las ' + LC.hora(t.cajaAbiertaEn || t.abiertoEn) : LC.esperandoCocina() ? 'Caja cerrada · esperando el inventario de cocina' : LC.soloCocina() ? `Cocina abierta desde las ${LC.hora(LC.turnoCocina().abiertoEn)} · falta abrir la caja` : 'Caja cerrada'}</p>
      ${t ? `<h1 class="num">${LC.fmt(r.ventas)}</h1>
        <p>Vendido en este turno: ${r.ordenesPagadas} cuentas cerradas, ${abiertas.length} abiertas, ${comandas} comandas en cocina.</p>`
        : `<h1>Hola, ${esc(LC.user.nombre.split(' ')[0])}</h1>
        <p>Para vender primero se abre la caja: personal del día, conteo de bebidas y utensilios, y arqueo de las cuentas.</p>
        ${LC.esperandoCocina()
          ? `<p>Falta el inventario de cierre de cocina. Con ese último paso se calcula el resultado del día.</p>
             ${can('cocina.inventario') ? '<button class="btn primary lg" data-a="go" data-v="cocinaCierre">Hacer inventario de cocina</button>' : ''}
             ${can('turno.operar') ? '<button class="btn ghost" data-a="go" data-v="apertura">Opciones</button>' : ''}`
          : can('turno.operar') ? '<button class="btn primary lg" data-a="go" data-v="apertura">Abrir caja</button>'
          : can('cocina.inventario') ? `<button class="btn primary lg" data-a="go" data-v="cocina" data-tab="inventario">${LC.soloCocina() ? 'Ir a cocina' : 'Abrir cocina'}</button>` : '<p class="muted-inv">La encargada debe abrir la caja.</p>'}`}
    </section>
    ${t && can('reportes.ver') ? `<div class="saldo-grid">${LC.CUENTAS.map((c) => `<div class="saldo"><span>${c}</span><strong class="num">${LC.fmt(LC.db.saldos[c])}</strong></div>`).join('')}</div>` : ''}
    <div class="quick">${acc.map(([v, t1, t2]) => `<button class="quick-i" data-a="go" data-v="${v}"><strong>${t1}</strong><span>${t2}</span></button>`).join('')}</div>`;
  };

  /* ---------------- ajustes ---------------- */
  LC.V.ajustes = (p) => {
    if (!LC.guard('catalogo.editar', 'usuarios.gestionar')) return LC.sinPermiso();
    const tabs = [];
    if (LC.can('catalogo.editar')) tabs.push(['menu', 'Menú'], ['pizzas', 'Pizzas'], ['bebidas', 'Bebidas'], ['utensilios', 'Utensilios'], ['insumos', 'Insumos'], ['preparaciones', 'Preparaciones'], ['negocio', 'Negocio']);
    if (LC.can('usuarios.gestionar')) tabs.push(['usuarios', 'Usuarios']);
    if (LC.user.rol === 'admin') tabs.push(['datos', 'Datos']);
    const tab = tabs.some((x) => x[0] === p.tab) ? p.tab : tabs[0][0];
    const body = { menu: tabMenu, pizzas: tabPizzas, preparaciones: tabPreparaciones, negocio: tabNegocio, usuarios: tabUsuarios, datos: tabDatos }[tab];
    const aviso = LC.catalogoVacio && LC.can('catalogo.editar') && tab !== 'usuarios' ? `<div class="notice">
      <strong>El menú todavía no está en el servidor.</strong> Súbelo una vez desde este equipo: productos, pizzas, bebidas, utensilios, insumos y datos del negocio. Después todos los equipos verán lo mismo.
      <button class="btn primary block" data-a="subirCatalogo">Subir el menú de este equipo al servidor</button></div>` : '';
    return `<div class="page-head"><h1>Ajustes</h1></div>${LC.tabs(tabs, tab, 'ajustes')}${aviso}${body ? body() : tabInventario(tab)}`;
  };

  /* Guarda un cambio del catálogo en el servidor y recarga lo que ven todos los equipos */
  async function enServidor(el, fn, msg) {
    if (LC.catalogoVacio) return LC.toast('Primero sube el menú de este equipo al servidor (botón de arriba)', 'error');
    const btn = el && (el.tagName === 'FORM' ? el.querySelector('button:not([type=button])') : el);
    if (btn) btn.disabled = true;
    try {
      await fn();
      await LC.cargarCatalogo();
    } catch (e) {
      if (btn) btn.disabled = false;
      LC.toast(e.message, 'error');
      return false;
    }
    if (msg) LC.toast(msg);
    LC.render();
    return true;
  }
  LC.A.subirCatalogo = async (d, el) => {
    if (!confirm('¿Subir el menú, las pizzas, el inventario y los datos del negocio de este equipo al servidor?')) return;
    el.disabled = true;
    try {
      const n = await LC.subirCatalogo();
      LC.log('Menú subido al servidor', `${n} productos, pizzas e ítems`);
      LC.toast(`Listo: ${n} productos, pizzas e ítems quedaron en el servidor`);
    } catch (e) {
      el.disabled = false;
      return LC.toast(e.message, 'error');
    }
    LC.render();
  };

  function tabMenu() {
    const cats = LC.categoriasMenu();
    const dl = `<datalist id="dl-cats">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>`;
    return `${dl}
    <form class="card form inline" data-submit="prodNuevo">
      <h3>Agregar producto</h3>
      <div class="grid3">
        <label>Nombre<input name="nombre" required></label>
        <label>Categoría<input name="categoria" list="dl-cats" required></label>
        <label>Precio<input type="number" name="precio" min="0" step="100" required></label>
      </div>
      <button class="btn primary">Agregar</button>
    </form>
    <p class="muted">Las pizzas y las bebidas tienen su propia pestaña.</p>
    ${cats.map((c) => {
      const ps = LC.db.productos.filter((x) => x.categoria === c);
      if (!ps.length) return '';
      const ex = (LC.db.extras || {})[c] || [];
      return `<h3 class="sec">${esc(c)}</h3>
      <form class="card form" data-submit="extrasGuardar"><input type="hidden" name="categoria" value="${esc(c)}">
        <label>Extras de ${esc(c)} (uno por línea: nombre y precio)<textarea name="extras" rows="${Math.max(2, ex.length + 1)}" placeholder="Queso extra: 3000&#10;Tocineta: 4000">${esc(ex.map((e) => `${e.nombre}: ${e.precio}`).join('\n'))}</textarea></label>
        <button class="btn sm">Guardar extras</button></form>
      <div class="card list-edit">${ps.map((x) => `
        <form class="row-edit" data-submit="prodGuardar">
          <input type="hidden" name="id" value="${x.id}">
          <input name="nombre" value="${esc(x.nombre)}" required aria-label="Nombre">
          <input name="categoria" value="${esc(x.categoria)}" list="dl-cats" required aria-label="Categoría">
          <input type="number" name="precio" value="${x.precio}" min="0" step="100" required aria-label="Precio">
          <label class="check sm"><input type="checkbox" name="activo" ${x.activo ? 'checked' : ''}><span>Activo</span></label>
          <button class="btn sm">Guardar</button>
          <button type="button" class="btn sm ghost danger" data-a="prodBorrar" data-id="${x.id}">Eliminar</button>
        </form>`).join('')}</div>`;
    }).join('')}`;
  }
  LC.A.extrasGuardar = (d, f) => {
    const extras = [];
    for (const lin of d.extras.split('\n').map((x) => x.trim()).filter(Boolean)) {
      const m = lin.match(/^(.+?)[:=\s]\s*\$?\s*([\d.]+)$/);
      if (!m) return LC.toast(`Escribe cada extra así: "Queso extra: 3000" (revisa "${lin}")`, 'error');
      extras.push({ nombre: m[1].trim(), precio: parseInt(m[2].replace(/\./g, ''), 10) });
    }
    return enServidor(f, () => LC.api('catalogo/categorias', { method: 'PATCH', body: { nombre: d.categoria, extras } }), 'Extras guardados');
  };
  const datosProducto = (d) => ({ nombre: d.nombre.trim(), categoria: d.categoria.trim(), precio: Math.round(LC.num(d.precio)) });
  LC.A.prodNuevo = (d, f) => enServidor(f, async () => {
    await LC.api('catalogo/productos', { method: 'POST', body: datosProducto(d) });
    LC.log('Producto creado', d.nombre);
  }, 'Producto agregado');
  LC.A.prodGuardar = (d, f) => {
    const x = LC.db.productos.find((p) => p.id === d.id); if (!x) return;
    const antes = x.precio, datos = datosProducto(d);
    return enServidor(f, async () => {
      await LC.api('catalogo/productos', { method: 'PATCH', body: Object.assign({ id: d.id, activo: !!d.activo }, datos) });
      LC.log('Producto editado', `${datos.nombre}${antes !== datos.precio ? `: precio ${LC.fmt(antes)} a ${LC.fmt(datos.precio)}` : ''}`);
    }, 'Guardado');
  };
  LC.A.prodBorrar = (d, el) => {
    const x = LC.db.productos.find((p) => p.id === d.id);
    if (!x || !confirm(`¿Eliminar "${x.nombre}" del menú?`)) return;
    return enServidor(el, async () => {
      await LC.api('catalogo/productos', { method: 'DELETE', body: { id: d.id } });
      LC.log('Producto eliminado', x.nombre);
    }, 'Producto eliminado');
  };

  /* ---------- preparaciones de cocina (salsa de pizza, guiso, piña…) y sus materiales ---------- */
  const todosLosItems = () => ['insumos', 'utensilios', 'bebidas'].flatMap((g) => LC.db[g].map((it) => Object.assign({ grupo: g }, it)));
  const filaMaterial = (m) => `<div class="fila-material grid2">
      <label>Material<select name="item"><option value="">Elige</option>${['insumos', 'utensilios', 'bebidas'].map((g) => `<optgroup label="${LC.INV[g]}">${LC.db[g].map((it) => `<option value="${it.id}" ${m && m.itemId === it.id ? 'selected' : ''}>${esc(it.nombre)} (${esc(it.unidad)})</option>`).join('')}</optgroup>`).join('')}</select></label>
      <label>Cantidad por tanda<input type="number" name="cantidad" min="0" step="any" inputmode="decimal" value="${m ? m.cantidad : ''}"></label></div>`;
  function tabPreparaciones() {
    const preps = LC.db.config.preparaciones || [];
    const nombreDe = (id) => (todosLosItems().find((x) => x.id === id) || {}).nombre || 'Material borrado';
    return `<p class="muted">Lo que cocina prepara por tandas. Al cerrar, cocina marca qué hay que preparar mañana y los materiales de cada tanda entran solos a la lista de compras.</p>
    ${preps.map((p, i) => `<div class="card"><h3>${esc(p.nombre)}</h3>
      <ul>${p.materiales.map((m) => `<li>${esc(nombreDe(m.itemId))}: ${LC.q(m.cantidad)}</li>`).join('')}</ul>
      <button class="btn sm" data-a="prepEditar" data-i="${i}">Editar</button> <button class="btn sm ghost danger" data-a="prepBorrar" data-i="${i}">Eliminar</button></div>`).join('') || '<p class="empty">Todavía no hay preparaciones.</p>'}
    <button class="btn primary" data-a="prepEditar" data-i="-1">Nueva preparación</button>`;
  }
  LC.A.prepEditar = (d) => {
    const p = (LC.db.config.preparaciones || [])[+d.i] || { nombre: '', materiales: [null] };
    LC.modal(`${LC.modalHead(p.nombre || 'Nueva preparación')}
      <form class="form" data-submit="prepGuardar"><input type="hidden" name="i" value="${d.i}">
        <label>Nombre<input name="nombre" value="${esc(p.nombre)}" required placeholder="Ej. Salsa de pizza"></label>
        <div id="filas-material">${p.materiales.map(filaMaterial).join('')}</div>
        <button type="button" class="btn sm" data-a="prepFila">+ Otro material</button>
        <button class="btn primary lg block">Guardar</button></form>`, true);
  };
  LC.A.prepFila = () => {
    const cont = document.getElementById('filas-material');
    cont.insertAdjacentHTML('beforeend', filaMaterial(null));
  };
  const guardarPreps = (el, lista, msg) => enServidor(el, () => LC.api('catalogo/preparaciones', { method: 'PATCH', body: { preparaciones: lista } }), msg);
  LC.A.prepGuardar = (d, f) => {
    const materiales = [];
    for (const fila of f.querySelectorAll('.fila-material')) {
      const itemId = fila.querySelector('[name=item]').value, cantidad = LC.num(fila.querySelector('[name=cantidad]').value);
      if (!itemId) continue;
      if (cantidad <= 0) return LC.toast('Escribe la cantidad de cada material', 'error');
      materiales.push({ itemId, cantidad });
    }
    if (!materiales.length) return LC.toast('Agrega al menos un material', 'error');
    const lista = (LC.db.config.preparaciones || []).slice();
    const nueva = { nombre: d.nombre.trim(), materiales };
    if (+d.i >= 0) lista[+d.i] = nueva; else lista.push(nueva);
    return guardarPreps(f, lista, 'Preparación guardada').then((ok) => ok && LC.cerrarModal());
  };
  LC.A.prepBorrar = (d, el) => {
    const lista = (LC.db.config.preparaciones || []).slice();
    const p = lista[+d.i]; if (!p || !confirm(`¿Eliminar "${p.nombre}"?`)) return;
    lista.splice(+d.i, 1);
    return guardarPreps(el, lista, 'Preparación eliminada');
  };

  function tabPizzas() {
    return LC.db.pizza.tipos.map((tp) => `
    <form class="card form" data-submit="pizzaGuardar">
      <input type="hidden" name="id" value="${tp.id}">
      <label>Nombre<input name="nombre" value="${esc(tp.nombre)}" required></label>
      <div class="grid3">${LC.TAMANOS.map((s) => `<label>Precio ${s}<input type="number" name="P_${s}" value="${LC.num(tp.precios[s])}" min="0" step="100"></label>`).join('')}</div>
      <div class="grid3">${LC.TAMANOS.map((s) => `<label>Sabor adicional ${s}<input type="number" name="X_${s}" value="${LC.num(tp.extra[s])}" min="0" step="100"></label>`).join('')}</div>
      <label>Sabores incluidos sin costo<input type="number" name="gratis" value="${tp.gratis}" min="0" step="1"></label>
      <label>Sabores disponibles (separados por coma)<textarea name="sabores" rows="3">${esc(tp.sabores.join(', '))}</textarea></label>
      <p class="muted">Pon precio 0 en un tamaño para ocultarlo en esta pizza.</p>
      <button class="btn primary">Guardar ${esc(tp.nombre)}</button>
    </form>`).join('');
  }
  LC.A.pizzaGuardar = (d, f) => enServidor(f, async () => {
    const porTamano = (pre) => Object.fromEntries(LC.TAMANOS.map((s) => [s, Math.round(LC.num(d[pre + s]))]));
    await LC.api('catalogo/pizzas', { method: 'PATCH', body: {
      id: d.id, nombre: d.nombre.trim(), precios: porTamano('P_'), extra: porTamano('X_'),
      gratis: Math.max(0, parseInt(d.gratis, 10) || 0), sabores: d.sabores.split(',').map((s) => s.trim()).filter(Boolean)
    } });
    LC.log('Pizza editada', d.nombre.trim());
  }, 'Guardado');

  // Unidad: se elige de una lista (unidad, gramo, kilo…). Si un ítem viejo tiene otra, se conserva.
  const selUnidad = (val, attrs = '') => `<select name="unidad" required ${attrs}>${Object.entries(LC.UNIDADES).map(([k, n]) => `<option value="${k}" ${k === val ? 'selected' : ''}>${n} (${k})</option>`).join('')}${val && !LC.UNIDADES[val] ? `<option value="${esc(val)}" selected>${esc(val)}</option>` : ''}</select>`;
  function tabInventario(tipo) {
    const esB = tipo === 'bebidas';
    const items = LC.db[tipo];
    return `
    <form class="card form" data-submit="invNuevo">
      <h3>Agregar a ${LC.INV[tipo].toLowerCase()}</h3>
      <input type="hidden" name="tipo" value="${tipo}">
      <div class="grid3">
        <label>Nombre<input name="nombre" required></label>
        <label>Se cuenta por${selUnidad(esB ? 'und' : tipo === 'insumos' ? 'kg' : 'und')}</label>
        ${esB ? '<label>Precio de venta<input type="number" name="precio" min="1" step="100" required></label>' : ''}
        <label>Costo de 1 unidad de conteo<input type="number" name="costo" min="0" step="any" value="0"></label>
        <label>Stock sugerido (solo lo ves tú)<input type="number" name="sugerido" min="0" step="any" required></label>
      </div>
      <button class="btn primary">Agregar</button>
    </form>
    <p class="muted">Ejemplo: el queso se cuenta por kilo y cuesta $24.000 el kilo; las servilletas por paquete. El stock sugerido es lo que quieres tener para empezar el día: con él la app calcula las compras. El stock solo cambia con conteos, llegadas de mercancía o un ajuste con motivo, así cada diferencia queda registrada.</p>
    <div class="card list-edit">${items.map((it) => `
      <form class="row-edit" data-submit="invGuardar">
        <input type="hidden" name="tipo" value="${tipo}"><input type="hidden" name="id" value="${it.id}">
        <input name="nombre" value="${esc(it.nombre)}" required aria-label="Nombre">
        ${selUnidad(it.unidad, 'aria-label="Unidad" class="w-s"')}
        ${esB ? `<label class="mini">Precio<input type="number" name="precio" value="${LC.num(it.precio)}" min="0" step="100"></label>` : ''}
        <label class="mini">Costo<input type="number" name="costo" value="${LC.num(it.costo)}" min="0" step="any"></label>
        <label class="mini">Sugerido<input type="number" name="sugerido" value="${LC.num(it.sugerido)}" min="0" step="any"></label>
        <span class="stock ${LC.num(it.stock) < LC.num(it.sugerido) ? 'bajo' : ''}">Stock ${LC.q(it.stock)}</span>
        <button class="btn sm">Guardar</button>
        <button type="button" class="btn sm ghost" data-a="invAjuste" data-tipo="${tipo}" data-id="${it.id}">Ajustar stock</button>
        <button type="button" class="btn sm ghost danger" data-a="invBorrar" data-tipo="${tipo}" data-id="${it.id}">Eliminar</button>
      </form>`).join('')}</div>`;
  }
  const datosItem = (d) => {
    const it = { nombre: d.nombre.trim(), unidad: d.unidad.trim(), costo: LC.num(d.costo), sugerido: LC.num(d.sugerido) };
    if (d.tipo === 'bebidas') it.precio = Math.round(LC.num(d.precio));
    return it;
  };
  LC.A.invNuevo = (d, f) => enServidor(f, async () => {
    await LC.api('catalogo/inventario', { method: 'POST', body: Object.assign({ tipo: d.tipo }, datosItem(d)) });
    LC.log('Ítem de inventario creado', `${LC.INV[d.tipo]}: ${d.nombre.trim()}`);
  }, 'Agregado. Su stock inicia en 0: regístralo con una llegada o en el conteo.');
  LC.A.invGuardar = (d, f) => enServidor(f, async () => {
    await LC.api('catalogo/inventario', { method: 'PATCH', body: Object.assign({ id: d.id }, datosItem(d)) });
    LC.log('Ítem de inventario editado', d.nombre.trim());
  }, 'Guardado');
  LC.A.invBorrar = (d, el) => {
    const it = LC.db[d.tipo].find((x) => x.id === d.id);
    if (!it || !confirm(`¿Eliminar "${it.nombre}"? El historial se conserva.`)) return;
    return enServidor(el, async () => {
      await LC.api('catalogo/inventario', { method: 'DELETE', body: { id: d.id } });
      LC.log('Ítem de inventario eliminado', it.nombre);
    }, 'Eliminado');
  };
  LC.A.invAjuste = (d) => {
    const it = LC.db[d.tipo].find((x) => x.id === d.id); if (!it) return;
    LC.modal(`${LC.modalHead('Ajustar stock: ' + it.nombre)}
      <form class="form" data-submit="invAjusteGuardar">
        <input type="hidden" name="tipo" value="${d.tipo}"><input type="hidden" name="id" value="${it.id}">
        <p class="muted">Stock actual en sistema: <strong>${LC.q(it.stock)} ${esc(it.unidad)}</strong></p>
        <label>Nuevo stock<input type="number" name="stock" min="0" step="any" required></label>
        <label>Motivo<input name="motivo" required placeholder="Ej. se dañaron 2, error de conteo"></label>
        <button class="btn primary block">Guardar ajuste</button>
      </form>`);
  };
  LC.A.invAjusteGuardar = async (d, f) => {
    const btn = f.querySelector('button.primary');
    btn.disabled = true;
    try { await LC.accionTurno('ajuste', { itemId: d.id, stock: LC.num(d.stock), motivo: d.motivo.trim() }); }
    catch (e) { btn.disabled = false; return LC.toast(e.message, 'error'); }
    LC.cerrarModal(); LC.toast('Ajuste registrado'); LC.render();
  };

  function tabNegocio() {
    const c = LC.db.config;
    return `<form class="card form" data-submit="negocioGuardar">
      <label>Nombre del negocio<input name="negocio" value="${esc(c.negocio)}" required></label>
      <label>WhatsApp para reportes (con 57)<input name="whatsapp" value="${esc(c.whatsapp)}" inputmode="tel" required></label>
      <div class="grid3">
        <label>Número de mesas<input type="number" name="mesas" value="${c.mesas}" min="1" max="60" required></label>
        <label>Ancho de impresora<select name="ticket"><option value="58" ${c.ticket == 58 ? 'selected' : ''}>58 mm</option><option value="80" ${c.ticket == 80 ? 'selected' : ''}>80 mm</option></select></label>
        <label>Valor del domicilio<input type="number" name="valorDomicilio" value="${LC.valorDomicilio()}" min="0" step="500"></label>
      </div>
      <div class="grid3">
        <label>NIT<input name="nit" value="${esc(c.nit)}"></label>
        <label>Dirección<input name="direccion" value="${esc(c.direccion)}"></label>
        <label>Teléfono<input name="telefono" value="${esc(c.telefono)}"></label>
      </div>
      <label class="check"><input type="checkbox" name="imprimirComandas" ${c.imprimirComandas ? 'checked' : ''}><span>Imprimir comanda al enviarla a cocina</span></label>
      <button class="btn primary">Guardar</button>
    </form>
    ${LC.can('reportes.ver') ? avisosHTML() : ''}`;
  }

  /* ---------- avisos del cierre (Telegram y correo, los envía el servidor) ---------- */
  let avisosSrv = null, enlaceTelegram = '';
  function cargarAvisos() {
    LC.api('avisos').then((r) => { avisosSrv = r; if (LC.state.view === 'ajustes' && !$('#modal-root').innerHTML) LC.render(); })
      .catch((e) => LC.toast(e.message, 'error'));
  }
  function avisosHTML() {
    if (!avisosSrv) { cargarAvisos(); return '<div class="card"><p class="muted">Cargando avisos…</p></div>'; }
    const a = avisosSrv, tg = a.telegram, co = a.correo;
    const telegram = !tg.disponible
      ? '<p class="notice">Falta crear el bot de Telegram del servidor (variable TELEGRAM_BOT_TOKEN en Vercel).</p>'
      : !tg.bot
        ? `<p class="notice bad">${esc(tg.problema || 'Telegram no responde')}</p>`
      : tg.conectado
        ? '<p><span class="tag ok">Telegram conectado</span> <button type="button" class="btn sm ghost" data-a="avisoTelegramQuitar">Desconectar</button></p>'
        : enlaceTelegram
          ? (() => {
            // Además del enlace web (t.me), se ofrece abrir la app de Telegram directo (tg://) y el mensaje
            // para escribirlo a mano: algunas redes o proveedores de internet bloquean t.me.
            const codigo = enlaceTelegram.split('start=')[1] || '', bot = tg.bot || '';
            return `<p class="muted">1. Abre el bot con uno de estos botones y toca <strong>Iniciar</strong> (Start). 2. Vuelve aquí y toca "Ya toqué Iniciar".</p>
             <a class="btn primary" href="tg://resolve?domain=${esc(bot)}&start=${esc(codigo)}">Abrir en la app de Telegram</a>
             <a class="btn" href="${esc(enlaceTelegram)}" target="_blank" rel="noopener">Abrir en el navegador</a>
             <p class="muted">¿No abre ninguno? En Telegram busca <strong>@${esc(bot)}</strong> y envíale este mensaje exacto: <strong>/start ${esc(codigo)}</strong></p>
             <button type="button" class="btn" data-a="avisoTelegramConfirmar">Ya toqué Iniciar</button>`;
          })()
          : '<button type="button" class="btn primary" data-a="avisoTelegramConectar">Conectar mi Telegram</button>';
    const correo = !co.disponible
      ? '<p class="notice">Falta la clave del servicio de correo (variable RESEND_API_KEY en Vercel).</p>'
      : `<form class="row-edit" data-submit="avisoCorreo"><input type="email" name="correo" value="${esc(co.correo)}" placeholder="tu@correo.com" aria-label="Correo"><button class="btn sm">Guardar correo</button></form>`;
    return `<div class="card form">
      <h3>Avisos del cierre</h3>
      <p class="muted">Cuando la encargada cierre la caja y cuando cocina haga el último cierre, el servidor te envía el reporte con el resultado del día. Nadie del personal lo ve.</p>
      <h3 class="sec">Telegram</h3>${telegram}
      <h3 class="sec">Correo</h3>${correo}
      ${tg.conectado || co.correo ? '<button type="button" class="btn" data-a="avisoProbar">Enviar mensaje de prueba</button>' : ''}
    </div>`;
  }
  async function avisoAccion(el, body, msg) {
    if (el) el.disabled = true;
    try { const r = await LC.api('avisos', { method: 'POST', body }); if (r.telegram) avisosSrv = r; if (msg) LC.toast(typeof msg === 'function' ? msg(r) : msg); LC.render(); return r; }
    catch (e) { if (el) el.disabled = false; LC.toast(e.message, 'error'); }
  }
  LC.A.avisoTelegramConectar = async (d, el) => {
    const r = await avisoAccion(el, { accion: 'telegram-codigo' });
    if (r && r.enlace) { enlaceTelegram = r.enlace; LC.render(); }
  };
  LC.A.avisoTelegramConfirmar = async (d, el) => {
    const r = await avisoAccion(el, { accion: 'telegram-confirmar' }, 'Telegram conectado: te llegó un mensaje de bienvenida');
    if (r) { enlaceTelegram = ''; LC.render(); }
  };
  LC.A.avisoTelegramQuitar = (d, el) => { if (confirm('¿Dejar de recibir los cierres por Telegram?')) avisoAccion(el, { accion: 'telegram-quitar' }, 'Telegram desconectado'); };
  LC.A.avisoCorreo = (d, f) => avisoAccion(f.querySelector('button'), { accion: 'correo', correo: d.correo }, 'Correo guardado');
  LC.A.avisoProbar = (d, el) => avisoAccion(el, { accion: 'probar' }, (r) => {
    const p = r.prueba, t = { enviado: 'enviado ✅', error: 'falló ❌', 'no configurado': 'no configurado' };
    return `Prueba: Telegram ${t[p.telegram] || p.telegram}, correo ${t[p.correo] || p.correo}`;
  });

  LC.A.negocioGuardar = (d, f) => enServidor(f, async () => {
    await LC.api('catalogo/negocio', { method: 'PATCH', body: {
      nombre: d.negocio.trim(), whatsapp: d.whatsapp.replace(/\D/g, ''), mesas: parseInt(d.mesas, 10) || 0,
      ticket: +d.ticket, valorDomicilio: Math.round(LC.num(d.valorDomicilio)), nit: d.nit.trim(), direccion: d.direccion.trim(),
      telefono: d.telefono.trim(), imprimirComandas: !!d.imprimirComandas
    } });
    LC.log('Configuración editada');
  }, 'Guardado');

  /* ---------------- usuarios y permisos (guardados en el servidor) ---------------- */
  let usuariosSrv = null, cargandoUsuarios = false;
  async function cargarUsuarios() {
    if (cargandoUsuarios) return;
    cargandoUsuarios = true;
    try { usuariosSrv = (await LC.api('usuarios')).usuarios; }
    catch (e) { return LC.toast(e.message, 'error'); }
    finally { cargandoUsuarios = false; }
    if (LC.state.view === 'ajustes' && !$('#modal-root').innerHTML) LC.render();
  }
  function tabUsuarios() {
    if (!usuariosSrv) { cargarUsuarios(); return '<p class="muted">Cargando usuarios…</p>'; }
    return `<button class="btn primary" data-a="userForm">+ Nuevo usuario</button>
    <p class="muted">Tú creas la contraseña de cada persona. Si alguien la olvida o se bloquea por intentos fallidos, ponle una nueva aquí.</p>
    <div class="list">${usuariosSrv.map((u) => `
      <button class="list-item" data-a="userForm" data-id="${u.id}">
        <div><strong>${esc(u.nombre)}</strong><small>@${esc(u.usuario)}, ${esc((LC.ROLES[u.rol] || {}).nombre || u.rol)}</small></div>
        <div class="right">${u.bloqueado ? '<span class="tag bad">Bloqueado</span>' : u.activo ? '<span class="tag ok">Activo</span>' : '<span class="tag">Inactivo</span>'}<small>${u.rol === 'admin' ? 'Acceso total' : (u.permisos || []).length + ' permisos'}</small></div>
      </button>`).join('')}</div>`;
  }
  LC.A.userForm = (d) => {
    const u = d.id ? (usuariosSrv || []).find((x) => x.id === d.id) : null;
    const rol = u ? u.rol : 'mesera';
    const perms = u ? u.permisos : LC.ROLES[rol].permisos;
    LC.modal(`${LC.modalHead(u ? 'Editar ' + u.nombre : 'Nuevo usuario')}
      <form class="form" data-submit="userGuardar" autocomplete="off">
        <input type="hidden" name="id" value="${u ? u.id : ''}">
        <label>Nombre completo<input name="nombre" value="${u ? esc(u.nombre) : ''}" required></label>
        <label>Usuario para ingresar<input name="usuario" value="${u ? esc(u.usuario) : ''}" required autocapitalize="none" pattern="[a-zA-Z0-9._\\-]{3,30}" title="De 3 a 30 letras o números, sin espacios"></label>
        <label>${u ? 'Nueva contraseña (déjala vacía para no cambiarla)' : 'Contraseña'}<input type="password" name="clave" minlength="4" ${u ? '' : 'required'} autocomplete="new-password"></label>
        <p class="muted">Mínimo 4 caracteres; para un administrador, mínimo 8.${u && u.bloqueado ? ' <strong>Este usuario está bloqueado:</strong> ponle una contraseña nueva para desbloquearlo.' : ''}</p>
        <label>Rol<select name="rol" data-ch="rolCambio">${Object.entries(LC.ROLES).map(([k, r]) => `<option value="${k}" ${k === rol ? 'selected' : ''}>${r.nombre}</option>`).join('')}</select></label>
        <fieldset><legend>Permisos</legend><div class="checks col">
          ${Object.entries(LC.PERMISOS).map(([k, t]) => `<label class="check"><input type="checkbox" name="perm" value="${k}" ${perms.includes(k) ? 'checked' : ''} ${rol === 'admin' ? 'disabled' : ''}><span>${t}</span></label>`).join('')}
        </div></fieldset>
        <label class="check"><input type="checkbox" name="activo" ${!u || u.activo ? 'checked' : ''}><span>Usuario activo</span></label>
        <button class="btn primary lg block">${u ? 'Guardar cambios' : 'Crear usuario'}</button>
      </form>`, true);
  };
  LC.A.rolCambio = (d, el) => {
    const def = LC.ROLES[el.value].permisos;
    el.form.querySelectorAll('input[name=perm]').forEach((c) => { c.checked = def.includes(c.value); c.disabled = el.value === 'admin'; });
  };
  LC.A.userGuardar = async (d, f) => {
    const datos = { nombre: d.nombre, usuario: d.usuario, rol: d.rol, activo: !!d.activo };
    if (d.rol !== 'admin') datos.permisos = new FormData(f).getAll('perm');
    if (d.clave) datos.clave = d.clave;
    const btn = f.querySelector('button.primary');
    btn.disabled = true;
    try {
      if (d.id) await LC.api('usuarios', { method: 'PATCH', body: Object.assign({ id: d.id }, datos) });
      else await LC.api('usuarios', { method: 'POST', body: datos });
      if (d.id === LC.user.id) await cargarSesion(); // mis propios permisos pudieron cambiar
      else await LC.cargarEquipo();
    } catch (e) {
      btn.disabled = false;
      return LC.toast(e.message, 'error');
    }
    usuariosSrv = null;
    LC.cerrarModal(); LC.toast('Usuario guardado'); LC.render();
  };

  /* ---------------- respaldo de datos ---------------- */
  function tabDatos() {
    return `<div class="card form">
      <h3>Respaldo</h3>
      <p class="muted">Mientras la app funcione sin servidor, los datos viven solo en este dispositivo. Descarga un respaldo cada semana.</p>
      <button class="btn primary" data-a="exportar">Descargar respaldo</button>
      <label>Restaurar desde un respaldo<input type="file" accept="application/json" data-ch="importar"></label>
    </div>
    <div class="card form danger-zone">
      <h3>Borrar todo</h3>
      <p class="muted">Elimina usuarios, ventas, turnos e inventarios de este dispositivo.</p>
      <button class="btn danger" data-a="reiniciar">Borrar todos los datos</button>
    </div>`;
  }
  LC.A.exportar = () => {
    const blob = new Blob([JSON.stringify(LC.db, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `loschamos-respaldo-${LC.diaLocal()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    LC.log('Respaldo descargado'); LC.save();
  };
  LC.A.importar = (d, el) => {
    const file = el.files[0]; if (!file) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const data = JSON.parse(rd.result);
        if (!Array.isArray(data.usuarios) || !data.config) throw new Error('El archivo no es un respaldo válido');
        if (!confirm('Esto reemplaza todos los datos actuales por los del respaldo. ¿Continuar?')) return;
        LC.db = LC.normalizar(data); LC.save(); LC.A.salir();
        LC.toast('Respaldo restaurado. Ingresa de nuevo.');
      } catch (e) { LC.toast(e.message, 'error'); }
    };
    rd.readAsText(file);
  };
  LC.A.reiniciar = () => {
    if (prompt('Escribe BORRAR para eliminar todos los datos') !== 'BORRAR') return;
    localStorage.removeItem(LC.KEY); location.reload();
  };

  /* ---------------- arranque ---------------- */
  LC.boot = async () => {
    // Si el servidor dice que la sesión venció (clave cambiada, usuario desactivado…), vuelve al ingreso
    LC.onSesionVencida = () => {
      if (!LC.user) return;
      LC.user = null; LC.equipo = []; usuariosSrv = null;
      if (LC.wizReset) LC.wizReset();
      LC.cerrarModal(); LC.render();
      LC.toast('Tu sesión terminó. Ingresa de nuevo.', 'error');
    };
    $('#main').innerHTML = '<div class="login"><p class="muted">Cargando…</p></div>';
    try {
      await cargarSesion();
      LC.state.view = inicioPorRol(LC.user);
    } catch (e) {
      LC.user = null;
      if (e.status !== 401) setTimeout(() => LC.toast(e.message, 'error'), 0);
    }
    LC.render();
    // Si la app está abierta en otra pestaña del mismo equipo (ej. pantalla de cocina), se sincroniza.
    // No se redibuja mientras alguien escribe en un formulario, para no borrarle lo que lleva.
    const escribiendo = () => {
      const el = document.activeElement;
      return ['apertura', 'cierre', 'cocinaCierre', 'ajustes'].includes(LC.state.view) || !!(el && el.closest('#main') && el.matches('input, select, textarea'));
    };
    window.addEventListener('storage', (e) => {
      if (e.key !== LC.KEY) return;
      LC.db = LC.load();
      LC.armarPedidos();
      if (!LC.user) return LC.render();
      if (!$('#modal-root').innerHTML && !escribiendo()) LC.render();
    });
    // Actualización automática, solo con la app a la vista (cuida el límite de llamadas del plan gratis):
    //  - pantalla de cocina y cola de impresión del PC de caja: cada 4 segundos
    //  - pedidos en las demás pantallas: cada 16 segundos (y al instante en el equipo que hace un cambio)
    //  - estado de la caja: cada minuto (así la mesera ve cuando se abre o se cierra)
    let tick = 0;
    setInterval(() => {
      if (!LC.user || document.hidden) return;
      tick++;
      const view = LC.state.view;
      if (LC.estacionActiva()) LC.revisarImpresion();
      const cocina = view === 'cocina' && LC.can('cocina.comandas') && LC.state.params.tab !== 'inventario';
      if (cocina || (tick % 4 === 0 && ['inicio', 'pos', 'orden', 'caja'].includes(view))) {
        LC.cargarPedidos().then(() => refrescarSiSePuede(view)).catch(() => {});
      }
      if (tick % 15 === 0) {
        LC.cargarTurno().then(() => { if (['inicio', 'cocina', 'pos', 'caja'].includes(view)) refrescarSiSePuede(view); }).catch(() => {});
      }
    }, 4000);
  };
})();
