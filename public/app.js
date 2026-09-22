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
  const SES = 'lc2_sesion_' + LC.TENANT;

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

  LC.go = (view, params = {}) => { LC.state = { view, params }; LC.cerrarModal(); LC.render(); window.scrollTo(0, 0); };
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
    setTimeout(() => { fr.contentWindow.focus(); fr.contentWindow.print(); }, 250);
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
      <div class="turno-pill ${t ? 'on' : 'off'}">${t ? 'Caja abierta ' + LC.hora(t.abiertoEn) : 'Caja cerrada'}</div>
      <div class="who"><span>${esc(LC.user.nombre)}<small>${esc(rol)}</small></span><button class="link" data-a="salir">Salir</button></div>`;
  }
  const NAV = [
    { v: 'inicio', ico: '⌂', t: 'Inicio', ok: () => true },
    { v: 'pos', ico: '🍽', t: 'Pedidos', also: ['orden'], ok: () => LC.guard('pos.tomar', 'pos.cobrar', 'pos.precuenta') },
    { v: 'cocina', ico: '🔥', t: 'Cocina', also: ['cocinaCierre'], ok: () => LC.guard('cocina.comandas', 'cocina.inventario') },
    { v: 'caja', ico: '💵', t: 'Caja', also: ['apertura', 'cierre'], ok: () => LC.guard('turno.operar', 'caja.movimientos', 'inventario.entradas') },
    { v: 'reportes', ico: '📊', t: 'Reportes', ok: () => LC.can('reportes.ver') },
    { v: 'ajustes', ico: '⚙', t: 'Ajustes', ok: () => LC.guard('catalogo.editar', 'usuarios.gestionar') }
  ];
  function renderNav() {
    const v = LC.state.view;
    $('#nav').innerHTML = NAV.filter((n) => n.ok()).map((n) =>
      `<button class="nav-i${v === n.v || (n.also || []).includes(v) ? ' on' : ''}" data-a="go" data-v="${n.v}"><span aria-hidden="true">${n.ico}</span>${n.t}</button>`
    ).join('');
  }
  const inicioPorRol = (u) => (u.rol === 'cocina' ? 'cocina' : u.rol === 'mesera' ? 'pos' : 'inicio');

  /* ---------------- login y primer uso ---------------- */
  function renderLogin() {
    document.body.classList.add('is-login');
    $('#top').innerHTML = '';
    $('#nav').innerHTML = '';
    const setup = LC.db.usuarios.length === 0;
    $('#main').innerHTML = `
    <div class="login">
      <div class="login-brand"><div class="logo-mark">LC</div><h1>${esc(LC.db.config.negocio)}</h1><p>Punto de venta y control de turno</p></div>
      ${setup ? `
      <form class="card form" data-submit="setup" autocomplete="off">
        <h2>Configura tu negocio</h2>
        <p class="muted">Crea la cuenta del administrador. Con ella crearás a la encargada, meseras y cocina, y les darás permisos.</p>
        <label>Nombre del negocio<input name="negocio" value="${esc(LC.db.config.negocio)}" required></label>
        <label>Tu nombre<input name="nombre" required></label>
        <label>Usuario<input name="usuario" required autocapitalize="none" pattern="[a-zA-Z0-9._\\-]{3,}" title="Mínimo 3 caracteres, sin espacios"></label>
        <label>Contraseña<input type="password" name="clave" required minlength="6"></label>
        <label>Repite la contraseña<input type="password" name="clave2" required minlength="6"></label>
        <button class="btn primary lg block">Crear administrador</button>
      </form>` : `
      <form class="card form" data-submit="login">
        <h2>Ingresar</h2>
        <label>Usuario<input name="usuario" required autocapitalize="none" autocomplete="username"></label>
        <label>Contraseña<input type="password" name="clave" required autocomplete="current-password"></label>
        <button class="btn primary lg block">Ingresar</button>
      </form>`}
      <p class="version">v${LC.VERSION}</p>
    </div>`;
  }

  LC.crearCredencial = async (clave) => { const salt = LC.uid() + LC.uid(); return { salt, hash: await LC.hash(clave, salt) }; };

  LC.A.setup = async (d) => {
    if (d.clave !== d.clave2) return LC.toast('Las contraseñas no coinciden', 'error');
    const cred = await LC.crearCredencial(d.clave);
    const u = {
      id: LC.uid(), nombre: d.nombre.trim(), usuario: d.usuario.trim().toLowerCase(),
      salt: cred.salt, hash: cred.hash, rol: 'admin', permisos: Object.keys(LC.PERMISOS), activo: true, creadoEn: new Date().toISOString()
    };
    LC.db.config.negocio = d.negocio.trim() || 'Los Chamos';
    LC.db.usuarios.push(u);
    iniciar(u);
  };

  let fallos = 0, bloqueoHasta = 0;
  LC.A.login = async (d) => {
    if (Date.now() < bloqueoHasta) return LC.toast('Demasiados intentos. Espera un minuto.', 'error');
    const u = LC.db.usuarios.find((x) => x.usuario === d.usuario.trim().toLowerCase() && x.activo);
    const ok = u && (await LC.hash(d.clave, u.salt)) === u.hash;
    if (!ok) {
      if (++fallos >= 5) { bloqueoHasta = Date.now() + 60000; fallos = 0; }
      return LC.toast('Usuario o contraseña incorrectos', 'error');
    }
    fallos = 0;
    iniciar(u);
  };

  function iniciar(u) {
    LC.user = u;
    sessionStorage.setItem(SES, u.id);
    LC.log('Inicio de sesión');
    LC.save();
    LC.go(inicioPorRol(u));
  }

  LC.A.salir = () => {
    LC.log('Cierre de sesión');
    LC.save();
    sessionStorage.removeItem(SES);
    LC.user = null;
    LC.cerrarModal();
    LC.render();
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
      <p class="ht-estado">${t ? 'Caja abierta desde las ' + LC.hora(t.abiertoEn) : 'Caja cerrada'}</p>
      ${t ? `<h1 class="num">${LC.fmt(r.ventas)}</h1>
        <p>Vendido en este turno: ${r.ordenesPagadas} cuentas cerradas, ${abiertas.length} abiertas, ${comandas} comandas en cocina.</p>`
        : `<h1>Hola, ${esc(LC.user.nombre.split(' ')[0])}</h1>
        <p>Para vender primero se abre la caja: personal del día, conteo de bebidas y utensilios, y arqueo de las cuentas.</p>
        ${can('turno.operar') ? '<button class="btn primary lg" data-a="go" data-v="apertura">Abrir caja</button>' : '<p class="muted-inv">La encargada debe abrir la caja.</p>'}`}
    </section>
    ${t && can('reportes.ver') ? `<div class="saldo-grid">${LC.CUENTAS.map((c) => `<div class="saldo"><span>${c}</span><strong class="num">${LC.fmt(LC.db.saldos[c])}</strong></div>`).join('')}</div>` : ''}
    <div class="quick">${acc.map(([v, t1, t2]) => `<button class="quick-i" data-a="go" data-v="${v}"><strong>${t1}</strong><span>${t2}</span></button>`).join('')}</div>`;
  };

  /* ---------------- ajustes ---------------- */
  LC.V.ajustes = (p) => {
    if (!LC.guard('catalogo.editar', 'usuarios.gestionar')) return LC.sinPermiso();
    const tabs = [];
    if (LC.can('catalogo.editar')) tabs.push(['menu', 'Menú'], ['pizzas', 'Pizzas'], ['bebidas', 'Bebidas'], ['utensilios', 'Utensilios'], ['insumos', 'Insumos'], ['negocio', 'Negocio']);
    if (LC.can('usuarios.gestionar')) tabs.push(['usuarios', 'Usuarios']);
    if (LC.user.rol === 'admin') tabs.push(['datos', 'Datos']);
    const tab = tabs.some((x) => x[0] === p.tab) ? p.tab : tabs[0][0];
    const body = { menu: tabMenu, pizzas: tabPizzas, negocio: tabNegocio, usuarios: tabUsuarios, datos: tabDatos }[tab];
    return `<div class="page-head"><h1>Ajustes</h1></div>${LC.tabs(tabs, tab, 'ajustes')}${body ? body() : tabInventario(tab)}`;
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
      return `<h3 class="sec">${esc(c)}</h3><div class="card list-edit">${ps.map((x) => `
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
  LC.A.prodNuevo = (d) => {
    LC.db.productos.push({ id: LC.uid(), nombre: d.nombre.trim(), categoria: d.categoria.trim(), precio: Math.round(LC.num(d.precio)), activo: true });
    if (!LC.db.categorias.includes(d.categoria.trim())) LC.db.categorias.splice(LC.db.categorias.length - 1, 0, d.categoria.trim());
    LC.log('Producto creado', d.nombre); LC.save(); LC.toast('Producto agregado'); LC.render();
  };
  LC.A.prodGuardar = (d) => {
    const x = LC.db.productos.find((p) => p.id === d.id); if (!x) return;
    const antes = x.precio;
    Object.assign(x, { nombre: d.nombre.trim(), categoria: d.categoria.trim(), precio: Math.round(LC.num(d.precio)), activo: !!d.activo });
    LC.log('Producto editado', `${x.nombre}${antes !== x.precio ? `: precio ${LC.fmt(antes)} a ${LC.fmt(x.precio)}` : ''}`);
    LC.save(); LC.toast('Guardado'); LC.render();
  };
  LC.A.prodBorrar = (d) => {
    const x = LC.db.productos.find((p) => p.id === d.id);
    if (!x || !confirm(`¿Eliminar "${x.nombre}" del menú?`)) return;
    LC.db.productos = LC.db.productos.filter((p) => p.id !== d.id);
    LC.log('Producto eliminado', x.nombre); LC.save(); LC.render();
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
  LC.A.pizzaGuardar = (d) => {
    const tp = LC.db.pizza.tipos.find((x) => x.id === d.id); if (!tp) return;
    tp.nombre = d.nombre.trim();
    LC.TAMANOS.forEach((s) => { tp.precios[s] = Math.round(LC.num(d['P_' + s])); tp.extra[s] = Math.round(LC.num(d['X_' + s])); });
    tp.gratis = Math.max(0, parseInt(d.gratis, 10) || 0);
    tp.sabores = d.sabores.split(',').map((s) => s.trim()).filter(Boolean);
    LC.log('Pizza editada', tp.nombre); LC.save(); LC.toast('Guardado'); LC.render();
  };

  function tabInventario(tipo) {
    const esB = tipo === 'bebidas';
    const items = LC.db[tipo];
    return `
    <form class="card form" data-submit="invNuevo">
      <h3>Agregar a ${LC.INV[tipo].toLowerCase()}</h3>
      <input type="hidden" name="tipo" value="${tipo}">
      <div class="grid3">
        <label>Nombre<input name="nombre" required></label>
        <label>Unidad<input name="unidad" value="${esB ? 'und' : ''}" placeholder="kg, und, paquete" required></label>
        ${esB ? '<label>Precio de venta<input type="number" name="precio" min="0" step="100" required></label>' : ''}
        <label>Costo por unidad<input type="number" name="costo" min="0" step="any" value="0"></label>
        <label>Stock sugerido<input type="number" name="sugerido" min="0" step="any" required></label>
      </div>
      <button class="btn primary">Agregar</button>
    </form>
    <p class="muted">El stock solo cambia con conteos, llegadas de mercancía o un ajuste con motivo, así cada diferencia queda registrada.</p>
    <div class="card list-edit">${items.map((it) => `
      <form class="row-edit" data-submit="invGuardar">
        <input type="hidden" name="tipo" value="${tipo}"><input type="hidden" name="id" value="${it.id}">
        <input name="nombre" value="${esc(it.nombre)}" required aria-label="Nombre">
        <input name="unidad" value="${esc(it.unidad)}" required aria-label="Unidad" class="w-s">
        ${esB ? `<label class="mini">Precio<input type="number" name="precio" value="${LC.num(it.precio)}" min="0" step="100"></label>` : ''}
        <label class="mini">Costo<input type="number" name="costo" value="${LC.num(it.costo)}" min="0" step="any"></label>
        <label class="mini">Sugerido<input type="number" name="sugerido" value="${LC.num(it.sugerido)}" min="0" step="any"></label>
        <span class="stock ${LC.num(it.stock) < LC.num(it.sugerido) ? 'bajo' : ''}">Stock ${LC.q(it.stock)}</span>
        <button class="btn sm">Guardar</button>
        <button type="button" class="btn sm ghost" data-a="invAjuste" data-tipo="${tipo}" data-id="${it.id}">Ajustar stock</button>
        <button type="button" class="btn sm ghost danger" data-a="invBorrar" data-tipo="${tipo}" data-id="${it.id}">Eliminar</button>
      </form>`).join('')}</div>`;
  }
  LC.A.invNuevo = (d) => {
    const it = { id: LC.uid(), nombre: d.nombre.trim(), unidad: d.unidad.trim(), costo: LC.num(d.costo), sugerido: LC.num(d.sugerido), stock: 0 };
    if (d.tipo === 'bebidas') it.precio = Math.round(LC.num(d.precio));
    LC.db[d.tipo].push(it);
    LC.log('Ítem de inventario creado', `${LC.INV[d.tipo]}: ${it.nombre}`); LC.save(); LC.toast('Agregado. Su stock inicia en 0: regístralo con una llegada o en el conteo.'); LC.render();
  };
  LC.A.invGuardar = (d) => {
    const it = LC.db[d.tipo].find((x) => x.id === d.id); if (!it) return;
    Object.assign(it, { nombre: d.nombre.trim(), unidad: d.unidad.trim(), costo: LC.num(d.costo), sugerido: LC.num(d.sugerido) });
    if (d.tipo === 'bebidas') it.precio = Math.round(LC.num(d.precio));
    LC.log('Ítem de inventario editado', it.nombre); LC.save(); LC.toast('Guardado'); LC.render();
  };
  LC.A.invBorrar = (d) => {
    const it = LC.db[d.tipo].find((x) => x.id === d.id);
    if (!it || !confirm(`¿Eliminar "${it.nombre}"? El historial se conserva.`)) return;
    LC.db[d.tipo] = LC.db[d.tipo].filter((x) => x.id !== d.id);
    LC.log('Ítem de inventario eliminado', it.nombre); LC.save(); LC.render();
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
  LC.A.invAjusteGuardar = (d) => {
    const it = LC.db[d.tipo].find((x) => x.id === d.id); if (!it) return;
    const antes = it.stock; it.stock = LC.num(d.stock);
    LC.log('Ajuste de stock', `${it.nombre}: ${LC.q(antes)} a ${LC.q(it.stock)}. Motivo: ${d.motivo}`);
    LC.save(); LC.cerrarModal(); LC.toast('Ajuste registrado'); LC.render();
  };

  function tabNegocio() {
    const c = LC.db.config;
    return `<form class="card form" data-submit="negocioGuardar">
      <label>Nombre del negocio<input name="negocio" value="${esc(c.negocio)}" required></label>
      <label>WhatsApp para reportes (con 57)<input name="whatsapp" value="${esc(c.whatsapp)}" inputmode="tel" required></label>
      <div class="grid3">
        <label>Número de mesas<input type="number" name="mesas" value="${c.mesas}" min="1" max="60" required></label>
        <label>Ancho de impresora<select name="ticket"><option value="58" ${c.ticket == 58 ? 'selected' : ''}>58 mm</option><option value="80" ${c.ticket == 80 ? 'selected' : ''}>80 mm</option></select></label>
        <label>Valor del domicilio<input type="number" name="valorDomicilio" value="${LC.num(c.valorDomicilio)}" min="0" step="500"></label>
      </div>
      <div class="grid3">
        <label>NIT<input name="nit" value="${esc(c.nit)}"></label>
        <label>Dirección<input name="direccion" value="${esc(c.direccion)}"></label>
        <label>Teléfono<input name="telefono" value="${esc(c.telefono)}"></label>
      </div>
      <label class="check"><input type="checkbox" name="imprimirComandas" ${c.imprimirComandas ? 'checked' : ''}><span>Imprimir comanda al enviarla a cocina</span></label>
      <button class="btn primary">Guardar</button>
    </form>`;
  }
  LC.A.negocioGuardar = (d) => {
    Object.assign(LC.db.config, {
      negocio: d.negocio.trim(), whatsapp: d.whatsapp.replace(/\D/g, ''), mesas: Math.max(1, parseInt(d.mesas, 10) || 8),
      ticket: +d.ticket, valorDomicilio: Math.round(LC.num(d.valorDomicilio)), nit: d.nit.trim(), direccion: d.direccion.trim(),
      telefono: d.telefono.trim(), imprimirComandas: !!d.imprimirComandas
    });
    LC.log('Configuración editada'); LC.save(); LC.toast('Guardado'); LC.render();
  };

  /* ---------------- usuarios y permisos ---------------- */
  function tabUsuarios() {
    return `<button class="btn primary" data-a="userForm">+ Nuevo usuario</button>
    <div class="list">${LC.db.usuarios.map((u) => `
      <button class="list-item" data-a="userForm" data-id="${u.id}">
        <div><strong>${esc(u.nombre)}</strong><small>@${esc(u.usuario)}, ${esc((LC.ROLES[u.rol] || {}).nombre || u.rol)}</small></div>
        <div class="right">${u.activo ? '<span class="tag ok">Activo</span>' : '<span class="tag">Inactivo</span>'}<small>${u.rol === 'admin' ? 'Acceso total' : (u.permisos || []).length + ' permisos'}</small></div>
      </button>`).join('')}</div>`;
  }
  LC.A.userForm = (d) => {
    const u = d.id ? LC.db.usuarios.find((x) => x.id === d.id) : null;
    const rol = u ? u.rol : 'mesera';
    const perms = u ? u.permisos : LC.ROLES[rol].permisos;
    LC.modal(`${LC.modalHead(u ? 'Editar ' + u.nombre : 'Nuevo usuario')}
      <form class="form" data-submit="userGuardar" autocomplete="off">
        <input type="hidden" name="id" value="${u ? u.id : ''}">
        <label>Nombre completo<input name="nombre" value="${u ? esc(u.nombre) : ''}" required></label>
        <label>Usuario para ingresar<input name="usuario" value="${u ? esc(u.usuario) : ''}" required autocapitalize="none" pattern="[a-zA-Z0-9._\\-]{3,}"></label>
        <label>${u ? 'Nueva contraseña (déjala vacía para no cambiarla)' : 'Contraseña'}<input type="password" name="clave" minlength="6" ${u ? '' : 'required'} autocomplete="new-password"></label>
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
    const usuario = d.usuario.trim().toLowerCase();
    if (LC.db.usuarios.some((x) => x.usuario === usuario && x.id !== d.id)) return LC.toast('Ese usuario ya existe', 'error');
    const permisos = d.rol === 'admin' ? Object.keys(LC.PERMISOS) : new FormData(f).getAll('perm');
    const activo = !!d.activo;
    let u = d.id ? LC.db.usuarios.find((x) => x.id === d.id) : null;
    const quedanAdmins = LC.db.usuarios.filter((x) => x.activo && x.rol === 'admin' && x.id !== d.id).length;
    if (u && u.rol === 'admin' && (d.rol !== 'admin' || !activo) && quedanAdmins === 0) return LC.toast('Debe quedar al menos un administrador activo', 'error');
    if (u && u.id === LC.user.id && !activo) return LC.toast('No puedes desactivar tu propio usuario', 'error');
    if (!u) {
      u = { id: LC.uid(), creadoEn: new Date().toISOString() };
      LC.db.usuarios.push(u);
    }
    Object.assign(u, { nombre: d.nombre.trim(), usuario, rol: d.rol, permisos, activo });
    if (d.clave) Object.assign(u, await LC.crearCredencial(d.clave));
    LC.log(d.id ? 'Usuario editado' : 'Usuario creado', `${u.nombre} (${d.rol})${d.clave && d.id ? ', contraseña cambiada' : ''}`);
    LC.save(); LC.cerrarModal(); LC.toast('Usuario guardado'); LC.render();
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
    localStorage.removeItem(LC.KEY); sessionStorage.removeItem(SES); location.reload();
  };

  /* ---------------- arranque ---------------- */
  LC.boot = () => {
    const id = sessionStorage.getItem(SES);
    const u = id && LC.db.usuarios.find((x) => x.id === id && x.activo);
    if (u) { LC.user = u; LC.state.view = inicioPorRol(u); }
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
      if (LC.user) LC.user = LC.db.usuarios.find((x) => x.id === LC.user.id && x.activo) || null;
      if (!LC.user) return LC.render();
      if (!$('#modal-root').innerHTML && !escribiendo()) LC.render();
    });
    setInterval(() => {
      if (LC.user && ['cocina', 'pos'].includes(LC.state.view) && !$('#modal-root').innerHTML) LC.render();
    }, 30000);
  };
})();
