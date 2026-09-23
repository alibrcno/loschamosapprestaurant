/* =====================================================================
   Los Chamos POS v2 — Punto de venta: mesas, domicilios, comandas,
   pre-cuenta, cobro con pago dividido y pantalla de cocina
   ===================================================================== */
'use strict';
(function () {
  const LC = window.LC;
  const esc = LC.esc;
  const P = { tab: 'salon', cat: null };
  const pad3 = (n) => String(n || 0).padStart(3, '0');
  const minutos = (iso) => Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));

  LC.tituloOrden = (o) => (o.tipo === 'mesa' ? `Mesa ${o.mesa}` : `Domicilio ${o.cliente}`);
  const abiertas = () => { const t = LC.turno(); return t ? LC.db.ordenes.filter((o) => o.turnoId === t.id && o.estado === 'abierta') : []; };
  // Lo que está "por enviar" vive solo en este equipo (borrador) y se corrige libremente
  const pendientes = (o) => o.lineas.filter((l) => l.borrador);
  const buscar = (id) => LC.db.ordenes.find((o) => o.id === id) || LC.db.ordenes.find((o) => o.id === LC.alias[id]);
  // Lo que ya salió en la pre-cuenta impresa o fue a cocina solo se quita anulando (con permiso y motivo).
  // Lo que no va a cocina (bebidas) y aún no sale en la pre-cuenta se puede quitar sin permiso.
  const trasPrecuenta = (o, l) => !!o.precuentaEn && (l.borrador || l.en > o.precuentaEn);
  const quitable = (o, l) => !o.local && !l.borrador && !l.anulada && !l.comanda && l.sinCocina && (!o.precuentaEn || l.en > o.precuentaEn);
  const aviso = (e) => LC.toast(e.message, 'error');

  // Cuentas nuevas que quedaron sin productos en este equipo: se descartan
  function limpiarVacias() {
    const b = LC.db.borradores;
    const vacias = Object.keys(b).filter((k) => !b[k].lineas.length && k !== LC.state.params.id);
    vacias.forEach((k) => delete b[k]);
    if (vacias.length) LC.armarPedidos();
  }

  /* ================= SALÓN Y DOMICILIOS ================= */
  LC.V.pos = (p) => {
    if (!LC.guard('pos.tomar', 'pos.cobrar', 'pos.precuenta')) return LC.sinPermiso();
    if (!LC.turno()) return `<div class="empty big"><h2>La caja está cerrada</h2><p>No se pueden tomar pedidos hasta que la encargada abra la caja.</p></div>`;
    limpiarVacias();
    const tab = p.tab === 'domicilios' || p.tab === 'salon' ? p.tab : P.tab;
    P.tab = tab;
    const ords = abiertas();
    const doms = ords.filter((o) => o.tipo === 'domicilio');
    let body;
    if (tab === 'salon') {
      const n = Math.max(1, parseInt(LC.db.config.mesas, 10) || 8);
      body = `<div class="mesas">${Array.from({ length: n }, (_, i) => i + 1).map((m) => {
        const o = ords.find((x) => x.tipo === 'mesa' && x.mesa === m);
        if (!o) return `<button class="mesa libre" data-a="mesaAbrir" data-m="${m}"><span class="mesa-n">${m}</span><span class="mesa-s">Libre</span></button>`;
        const pend = pendientes(o).length;
        const est = o.precuentaEn ? 'Pidió la cuenta' : pend ? `${pend} sin enviar` : `${minutos(o.creadaEn)} min`;
        return `<button class="mesa ocupada${pend ? ' pend' : ''}${o.precuentaEn ? ' cuenta' : ''}" data-a="ordenVer" data-id="${o.id}">
          <span class="mesa-n">${m}</span><span class="mesa-t">${LC.fmt(LC.totalOrden(o))}</span><span class="mesa-s">${est}</span></button>`;
      }).join('')}</div>
      <p class="leyenda"><span class="dot libre"></span>Libre <span class="dot ocupada"></span>Ocupada <span class="dot pend"></span>Sin enviar a cocina <span class="dot cuenta"></span>Pidió la cuenta</p>`;
    } else {
      body = `${LC.can('pos.tomar') ? '<button class="btn primary lg block" data-a="domNuevo">Nuevo domicilio</button>' : ''}
      <div class="list">${doms.length ? doms.map((o) => `
        <button class="list-item" data-a="ordenVer" data-id="${o.id}">
          <div><strong>${o.numero ? '#' + pad3(o.numero) + ' ' : ''}${esc(o.cliente)}</strong><small>${esc(o.direccion)}${o.telefono ? ', ' + esc(o.telefono) : ''}${o.pagoCliente ? ', paga con ' + esc(o.pagoCliente) : ''}</small></div>
          <div class="right"><strong>${LC.fmt(LC.totalOrden(o))}</strong><small>${LC.hora(o.creadaEn)}${pendientes(o).length ? ', sin enviar' : ''}</small></div>
        </button>`).join('') : '<p class="empty">No hay domicilios en curso.</p>'}</div>`;
    }
    const imp = LC.impresionPendiente ? `<div class="notice bad">Hay ${LC.impresionPendiente} ${LC.impresionPendiente === 1 ? 'impresión esperando' : 'impresiones esperando'} en caja. Revisa que el PC de caja tenga la app abierta con "Imprimir en este equipo" activado.</div>` : '';
    return `<div class="page-head"><h1>Pedidos</h1></div>${imp}${LC.tabs([['salon', 'Salón'], ['domicilios', `Domicilios (${doms.length})`]], tab, 'pos')}${body}`;
  };

  // Una cuenta nueva empieza en este equipo; llega al servidor cuando se envía el pedido
  const nuevaOrden = (nueva) => buscar(LC.nuevaCuenta(nueva));

  LC.A.mesaAbrir = (d) => {
    if (!LC.can('pos.tomar')) return LC.toast('Tu usuario no puede tomar pedidos', 'error');
    if (!LC.turno()) return;
    const m = +d.m;
    const ya = abiertas().find((o) => o.tipo === 'mesa' && o.mesa === m);
    const o = ya || nuevaOrden({ tipo: 'mesa', mesa: m });
    LC.go('orden', { id: o.id });
  };
  LC.A.ordenVer = (d) => LC.go('orden', { id: d.id });

  LC.A.domNuevo = () => {
    LC.modal(`${LC.modalHead('Nuevo domicilio')}
      <form class="form" data-submit="domCrear">
        <label>Nombre del cliente<input name="cliente" required></label>
        <label>Teléfono<input name="telefono" inputmode="tel"></label>
        <label>Dirección<input name="direccion" required></label>
        <label>Valor del envío (se le paga al mensajero en efectivo)<input type="number" name="envio" min="0" step="500" required value="${LC.num(LC.db.config.valorDomicilio) || ''}"></label>
        <fieldset class="seg"><legend>¿Cómo va a pagar el cliente?</legend>
          ${LC.CUENTAS.map((c) => `<label><input type="radio" name="pago" value="${c}" required><span>${c}</span></label>`).join('')}</fieldset>
        <label>Indicaciones<input name="nota" placeholder="Ej. casa esquinera, portón negro"></label>
        <button class="btn primary lg block">Crear y tomar pedido</button>
      </form>`);
  };
  LC.A.domCrear = (d) => {
    if (!LC.turno()) return;
    if (!d.pago) return LC.toast('Indica cómo va a pagar el cliente', 'error');
    const o = nuevaOrden({ tipo: 'domicilio', cliente: d.cliente.trim(), telefono: d.telefono.trim(), direccion: d.direccion.trim(), nota: d.nota.trim(), pagoCliente: d.pago });
    const envio = Math.round(LC.num(d.envio));
    if (envio > 0) agregar(o, { tipo: 'domicilio', nombre: 'Servicio de domicilio', categoria: 'Domicilio', precio: envio, sinCocina: true }, false);
    LC.go('orden', { id: o.id });
  };

  /* ================= ORDEN ================= */
  LC.V.orden = (p) => {
    const o = buscar(p.id);
    if (!o || o.estado !== 'abierta') return `<div class="empty"><h2>Esta cuenta ya no está abierta</h2><button class="btn" data-a="go" data-v="pos">Volver a pedidos</button></div>`;
    const cats = LC.categoriasPOS();
    const cat = cats.includes(P.cat) ? P.cat : cats[0];
    P.cat = cat;
    const tomar = LC.can('pos.tomar');
    const total = LC.totalOrden(o);
    const pend = pendientes(o);
    const vivas = o.lineas.filter((l) => !l.anulada);
    return `
    <div class="orden-head">
      <button class="icon-btn" data-a="ordenSalir" data-id="${o.id}" aria-label="Volver">←</button>
      <div class="oh-t"><h1>${esc(LC.tituloOrden(o))}</h1>
        <small>${o.numero ? 'Orden #' + pad3(o.numero) + ', ' : o.local ? 'Sin enviar, ' : ''}abierta ${LC.hora(o.creadaEn)} por ${esc(o.mesero)}${o.tipo === 'domicilio' ? `<br>${esc(o.direccion)}${o.telefono ? ', ' + esc(o.telefono) : ''}${o.pagoCliente ? `<br>Paga con ${esc(o.pagoCliente)}` : ''}` : ''}</small></div>
      ${o.tipo === 'mesa' && tomar ? `<button class="btn sm" data-a="mesaMover" data-id="${o.id}">Cambiar mesa</button>` : ''}
    </div>
    <div class="orden-grid">
      ${tomar ? `<section class="menu" aria-label="Menú">
        <div class="chips">${cats.map((c) => `<button class="chip${c === cat ? ' on' : ''}" data-a="posCat" data-c="${esc(c)}">${esc(c)}</button>`).join('')}</div>
        <div class="prods">${menuHTML(cat)}</div>
      </section>` : ''}
      <section class="cuenta" aria-label="Cuenta">
        <h2>Cuenta</h2>
        ${lineasHTML(o)}
        <div class="total-row"><span>Total</span><strong class="num">${LC.fmt(total)}</strong></div>
        <div class="cuenta-actions">
          ${pend.some((l) => !l.sinCocina) && tomar ? `<label class="nota-comanda">Nota para cocina (opcional)<input data-in="comandaNota" data-id="${o.id}" value="${esc(LC.borrador(o).nota || '')}" placeholder="Ej. tienen afán, la pizza para llevar"></label>` : ''}
          ${pend.length && tomar ? `<button class="btn maiz lg block" data-a="comandaEnviar" data-id="${o.id}">${pend.some((l) => !l.sinCocina) ? 'Enviar a cocina' : 'Enviar pedido'} (${pend.reduce((a, l) => a + l.qty, 0)})</button>` : ''}
          ${LC.guard('pos.precuenta', 'pos.cobrar') && vivas.length && !o.local ? `<button class="btn block" data-a="precuenta" data-id="${o.id}">${o.precuentaEn ? 'Reimprimir pre-cuenta' : 'Imprimir pre-cuenta'}</button>` : ''}
          ${LC.can('pos.cobrar') && total > 0 && !o.local ? `<button class="btn ok lg block" data-a="cobrar" data-id="${o.id}">Cobrar ${LC.fmt(total)}</button>` : ''}
          ${total === 0 && o.lineas.length && !o.local ? `<button class="btn ghost block" data-a="ordenAnular" data-id="${o.id}">Liberar sin cobrar</button>` : ''}
          ${o.tipo === 'domicilio' && !o.local ? `<button class="btn ghost block" data-a="ticketDomicilio" data-id="${o.id}">Imprimir datos de envío</button>` : ''}
        </div>
      </section>
    </div>`;
  };

  function menuHTML(cat) {
    if (cat === 'Pizzas') {
      return LC.db.pizza.tipos.map((tp) => {
        const precios = LC.TAMANOS.map((s) => LC.num(tp.precios[s])).filter((x) => x > 0);
        if (!precios.length) return '';
        return `<button class="prod pizza" data-a="pizzaNueva" data-t="${tp.id}"><span class="prod-n">${esc(tp.nombre)}</span><span class="prod-p">desde ${LC.fmt(Math.min(...precios))}</span><small>${tp.gratis} sabores incluidos</small></button>`;
      }).join('');
    }
    if (cat === 'Bebidas') {
      const quedan = LC.stockBebidasTeorico(LC.turno());
      return LC.db.bebidas.map((b) => `<button class="prod" data-a="addBebida" data-id="${b.id}"><span class="prod-n">${esc(b.nombre)}</span><span class="prod-p">${LC.fmt(b.precio)}</span><small class="${quedan[b.id] <= 0 ? 'neg' : ''}">quedan ${LC.q(quedan[b.id])}</small></button>`).join('');
    }
    return LC.db.productos.filter((x) => x.activo && x.categoria === cat)
      .map((x) => `<button class="prod" data-a="addProd" data-id="${x.id}"><span class="prod-n">${esc(x.nombre)}</span><span class="prod-p">${LC.fmt(x.precio)}</span></button>`).join('')
      || '<p class="muted">Sin productos activos en esta categoría.</p>';
  }

  function lineasHTML(o) {
    if (!o.lineas.length) return '<p class="muted pad">Toca un producto del menú para agregarlo.</p>';
    const comandaDe = (n) => o.comandas.find((c) => c.num === n);
    return `<div class="lineas">${o.lineas.map((l) => {
      let badge = '';
      if (l.anulada) badge = `<span class="tag bad">Anulado</span>`;
      else if (l.comanda) { const c = comandaDe(l.comanda); badge = `<span class="tag">Comanda #${l.comanda}${c ? ' ' + LC.hora(c.en) : ''}</span>`; }
      else if (l.borrador) badge = '<span class="tag maiz">Por enviar</span>';
      if (!l.anulada && trasPrecuenta(o, l)) badge += '<span class="tag maiz">Después de la pre-cuenta</span>';
      let acc = '';
      if (l.borrador && LC.can('pos.tomar')) {
        acc = `<div class="qty"><button class="icon-btn sm" data-a="lineaMenos" data-l="${l.lid}" aria-label="Quitar uno">−</button><span>${l.qty}</span><button class="icon-btn sm" data-a="lineaMas" data-l="${l.lid}" aria-label="Agregar uno">+</button></div>
          <button class="link" data-a="lineaNota" data-l="${l.lid}">${l.obs ? 'Editar nota' : 'Nota'}</button>`;
      } else if (quitable(o, l) && LC.can('pos.tomar')) {
        acc = `<button class="link" data-a="lineaQuitar" data-l="${l.lid}">Quitar uno</button>`;
      } else if (!l.anulada && !l.borrador && LC.can('pos.anular')) {
        acc = `<button class="link danger" data-a="lineaAnular" data-l="${l.lid}">Anular</button>`;
      }
      return `<div class="linea${l.anulada ? ' anulada' : ''}">
        <div class="l-main"><span class="l-qty">${l.qty}×</span><div><strong>${esc(l.nombre)}</strong>
          ${l.detalle ? `<small>${esc(l.detalle)}</small>` : ''}${l.obs ? `<small class="obs">${esc(l.obs)}</small>` : ''}
          ${l.anulada ? `<small class="neg">${esc(l.anulada.motivo)}, ${esc(l.anulada.por)}</small>` : ''}${badge}</div></div>
        <div class="l-side"><span class="num">${LC.fmt(l.precio * l.qty)}</span>${acc}</div>
      </div>`;
    }).join('')}</div>`;
  }

  // Agregar algo a la cuenta: queda en el borrador de este equipo hasta que se envíe
  function agregar(o, l, render = true) {
    const d = LC.borrador(o);
    d.lote = null; // el pedido cambió: es un envío nuevo
    const igual = d.lineas.find((x) => !x.obs && !l.obs && x.nombre === l.nombre && x.detalle === (l.detalle || '') && x.precio === l.precio);
    if (igual) igual.qty += l.qty || 1;
    else d.lineas.push(Object.assign({ lid: LC.uid(), qty: 1, detalle: '', obs: '', comanda: null, anulada: null, sinCocina: false, borrador: true, por: LC.user.nombre, en: new Date().toISOString() }, l));
    LC.armarPedidos();
    if (render) LC.render();
  }
  const actual = () => buscar(LC.state.params.id);
  const linea = (lid) => { const o = actual(); return o && o.lineas.find((l) => l.lid === lid); };

  LC.A.posCat = (d) => { P.cat = d.c; LC.render(); };
  const extrasDe = (cat) => (LC.db.extras || {})[cat] || [];
  LC.A.addProd = (d) => {
    const o = actual(), x = LC.db.productos.find((p) => p.id === d.id);
    if (!o || !x) return;
    const ex = extrasDe(x.categoria);
    if (!ex.length) return agregar(o, { tipo: 'producto', pid: x.id, nombre: x.nombre, categoria: x.categoria, precio: x.precio });
    // La categoría tiene extras: se eligen antes de agregar
    LC.modal(`${LC.modalHead(x.nombre)}
      <form class="form extras-form" data-submit="prodExtrasAgregar" data-ch="prodExtrasCalc">
        <input type="hidden" name="id" value="${x.id}">
        <fieldset><legend>Extras (opcional)</legend>
          <div class="checks">${ex.map((e, i) => `<label class="check"><input type="checkbox" name="ex" value="${i}"><span>${esc(e.nombre)} <small>+${LC.fmt(e.precio)}</small></span></label>`).join('')}</div></fieldset>
        <div class="grid2"><label>Cantidad<input type="number" name="qty" value="1" min="1" step="1"></label>
        <label>Observaciones<input name="obs" placeholder="Ej. sin cebolla"></label></div>
        <div class="pizza-total"><span>Valor</span><strong id="ex-total" class="num">${LC.fmt(x.precio)}</strong></div>
        <button class="btn primary lg block">Agregar a la cuenta</button>
      </form>`, true);
  };
  const extrasElegidos = (f) => {
    const x = LC.db.productos.find((p) => p.id === f.elements.id.value), ex = extrasDe(x.categoria);
    const sel = Array.from(f.querySelectorAll('input[name=ex]:checked')).map((i) => ex[+i.value]);
    return { x, sel, unit: x.precio + sel.reduce((a, e) => a + e.precio, 0), qty: Math.max(1, parseInt(f.elements.qty.value, 10) || 1) };
  };
  LC.A.prodExtrasCalc = (d, f) => { const r = extrasElegidos(f); document.getElementById('ex-total').textContent = LC.fmt(r.unit * r.qty); };
  LC.A.prodExtrasAgregar = (d, f) => {
    const o = actual(); if (!o) return;
    const r = extrasElegidos(f);
    LC.cerrarModal();
    agregar(o, {
      tipo: 'producto', pid: r.x.id, nombre: r.x.nombre, categoria: r.x.categoria, precio: r.unit, qty: r.qty, obs: (d.obs || '').trim(),
      extras: r.sel.map((e) => e.nombre), detalle: r.sel.length ? 'Con ' + r.sel.map((e) => e.nombre).join(', ') : ''
    });
  };
  LC.A.addBebida = (d) => {
    const o = actual(), b = LC.db.bebidas.find((x) => x.id === d.id);
    if (o && b) agregar(o, { tipo: 'bebida', bebidaId: b.id, nombre: b.nombre, categoria: 'Bebidas', precio: LC.num(b.precio), sinCocina: true });
  };
  // Cambios en lo que está por enviar (solo en este equipo)
  const enBorrador = (lid, fn) => {
    const o = actual(); if (!o || !LC.can('pos.tomar')) return;
    const d = LC.borrador(o), l = d.lineas.find((x) => x.lid === lid); if (!l) return;
    fn(l, d); d.lote = null;
    LC.armarPedidos(); LC.render();
  };
  LC.A.lineaMas = (d) => enBorrador(d.l, (l) => l.qty++);
  LC.A.lineaMenos = (d) => enBorrador(d.l, (l, b) => { if (l.qty > 1) l.qty--; else b.lineas = b.lineas.filter((x) => x !== l); });
  LC.A.lineaNota = (d) => {
    const l = linea(d.l); if (!l) return;
    LC.modal(`${LC.modalHead('Nota para ' + l.nombre)}
      <form class="form" data-submit="lineaNotaGuardar"><input type="hidden" name="l" value="${l.lid}">
        <label>Observación para cocina<input name="obs" value="${esc(l.obs)}" placeholder="Ej. sin cebolla, término medio"></label>
        <button class="btn primary block">Guardar nota</button></form>`);
  };
  LC.A.lineaNotaGuardar = (d) => { LC.cerrarModal(); enBorrador(d.l, (l) => (l.obs = d.obs.trim())); };
  // Lo que ya está en el servidor
  LC.A.lineaQuitar = async (d, el) => {
    const o = actual(); if (!o) return;
    el.disabled = true;
    try { await LC.accionPedido('quitar', { orden: o.id, linea: d.l }); } catch (e) { aviso(e); }
    LC.render();
  };
  LC.A.lineaAnular = (d) => {
    const l = linea(d.l); if (!l) return;
    LC.modal(`${LC.modalHead('Anular ' + l.nombre)}
      <form class="form" data-submit="lineaAnularGuardar"><input type="hidden" name="l" value="${l.lid}">
        <p class="muted">Queda registrado quién anuló y por qué. El administrador lo ve en el reporte del día.</p>
        <label>Motivo<input name="motivo" required placeholder="Ej. el cliente cambió de opinión"></label>
        <button class="btn danger block">Anular ${l.qty} ${esc(l.nombre)}</button></form>`);
  };
  LC.A.lineaAnularGuardar = async (d, f) => {
    const o = actual(); if (!o || !LC.can('pos.anular')) return;
    f.querySelector('button').disabled = true;
    try { await LC.accionPedido('anular', { orden: o.id, linea: d.l, motivo: d.motivo.trim() }); } catch (e) { f.querySelector('button').disabled = false; return aviso(e); }
    LC.cerrarModal(); LC.render();
  };

  LC.A.ordenSalir = (d) => {
    const o = buscar(d.id);
    const tab = o && o.tipo === 'domicilio' ? 'domicilios' : 'salon';
    if (o && o.local && !o.lineas.length) { delete LC.db.borradores[o.id]; LC.armarPedidos(); }
    LC.go('pos', { tab });
  };
  LC.A.ordenAnular = async (d) => {
    const o = buscar(d.id); if (!o) return;
    if (!confirm(`¿Liberar ${LC.tituloOrden(o)} sin cobrar?`)) return;
    try { await LC.accionPedido('liberar', { orden: o.id }); } catch (e) { return aviso(e); }
    LC.go('pos');
  };
  LC.A.mesaMover = (d) => {
    const o = buscar(d.id); if (!o) return;
    const ocupadas = abiertas().filter((x) => x.tipo === 'mesa').map((x) => x.mesa);
    const n = Math.max(1, parseInt(LC.db.config.mesas, 10) || 8);
    const libres = Array.from({ length: n }, (_, i) => i + 1).filter((m) => !ocupadas.includes(m));
    LC.modal(`${LC.modalHead('Cambiar ' + LC.tituloOrden(o))}<p class="muted">Elige la mesa libre a la que se pasan.</p>
      <div class="mesas mini">${libres.map((m) => `<button class="mesa libre" data-a="mesaMoverA" data-id="${o.id}" data-m="${m}"><span class="mesa-n">${m}</span></button>`).join('') || '<p>No hay mesas libres.</p>'}</div>`);
  };
  LC.A.mesaMoverA = async (d) => {
    const o = buscar(d.id); if (!o) return;
    if (o.local) { LC.db.borradores[o.id].nueva.mesa = +d.m; LC.armarPedidos(); }
    else { try { await LC.accionPedido('mover', { orden: o.id, mesa: +d.m }); } catch (e) { return aviso(e); } }
    LC.cerrarModal(); LC.render();
  };

  /* ---------- armador de pizza ---------- */
  LC.A.pizzaNueva = (d) => {
    const tp = LC.db.pizza.tipos.find((x) => x.id === d.t); if (!tp) return;
    const sizes = LC.TAMANOS.filter((s) => LC.num(tp.precios[s]) > 0);
    LC.modal(`${LC.modalHead(tp.nombre)}
      <form class="form pizza-form" data-submit="pizzaAgregar" data-ch="pizzaCalc">
        <input type="hidden" name="tipo" value="${tp.id}">
        <fieldset class="seg"><legend>Tamaño</legend>
          ${sizes.map((s, i) => `<label><input type="radio" name="tam" value="${s}" ${i === sizes.length - 1 ? 'checked' : ''}><span>${s}<small>${LC.fmt(tp.precios[s])}</small></span></label>`).join('')}</fieldset>
        <fieldset><legend>Sabores: ${tp.gratis} incluidos, los demás se cobran</legend>
          <div class="checks">${tp.sabores.map((s) => `<label class="check"><input type="checkbox" name="sabor" value="${esc(s)}"><span>${esc(s)}</span></label>`).join('')}</div></fieldset>
        <div class="grid2"><label>Cantidad<input type="number" name="qty" value="1" min="1" step="1"></label>
        <label>Observaciones<input name="obs" placeholder="Ej. bien tostada"></label></div>
        <div class="pizza-total"><span id="pz-det"></span><strong id="pz-total" class="num"></strong></div>
        <button class="btn primary lg block">Agregar a la cuenta</button>
      </form>`, true);
    LC.A.pizzaCalc(null, document.querySelector('.pizza-form'));
  };
  function pizzaPrecio(f) {
    const tp = LC.db.pizza.tipos.find((x) => x.id === f.elements.tipo.value);
    const tam = (f.querySelector('input[name=tam]:checked') || {}).value;
    const sabores = Array.from(f.querySelectorAll('input[name=sabor]:checked')).map((x) => x.value);
    const extras = Math.max(0, sabores.length - LC.num(tp.gratis));
    const unit = LC.num(tp.precios[tam]) + extras * LC.num(tp.extra[tam]);
    return { tp, tam, sabores, extras, unit, qty: Math.max(1, parseInt(f.elements.qty.value, 10) || 1) };
  }
  LC.A.pizzaCalc = (d, f) => {
    const r = pizzaPrecio(f);
    document.getElementById('pz-det').textContent = r.extras
      ? `${r.sabores.length} sabores, ${r.extras} adicional${r.extras > 1 ? 'es' : ''} de ${LC.fmt(r.tp.extra[r.tam])}`
      : `${r.sabores.length} de ${r.tp.gratis} sabores incluidos`;
    document.getElementById('pz-total').textContent = LC.fmt(r.unit * r.qty);
  };
  LC.A.pizzaAgregar = (d, f) => {
    const o = actual(); if (!o) return;
    const r = pizzaPrecio(f);
    if (!r.sabores.length) return LC.toast('Elige al menos un sabor', 'error');
    LC.cerrarModal();
    agregar(o, {
      tipo: 'pizza', pizza: { id: r.tp.id, tam: r.tam, sabores: r.sabores },
      nombre: `${r.tp.nombre} ${r.tam}`, categoria: 'Pizzas', precio: r.unit, qty: r.qty, obs: (d.obs || '').trim(),
      detalle: r.sabores.join(', ') + (r.extras ? ` (${r.extras} adicional${r.extras > 1 ? 'es' : ''})` : '')
    });
  };

  /* ---------- comandas ---------- */
  // Se envía todo lo que está por enviar. Lo de cocina sale como comanda y se imprime en caja.
  LC.A.comandaEnviar = async (d, el) => {
    const o = buscar(d.id); if (!o || !LC.turno()) return;
    if (!pendientes(o).length) return LC.toast('No hay productos nuevos para enviar');
    el.disabled = true;
    let r;
    try { r = await LC.enviarPedido(o); } catch (e) { el.disabled = false; return aviso(e); }
    if (r.repetido) LC.toast('Ese pedido ya estaba guardado');
    else if (r.comanda) LC.toast(`Comanda #${r.comanda} enviada a cocina${LC.db.config.imprimirComandas ? ', se imprime en caja' : ''}`);
    else LC.toast('Pedido guardado');
    LC.go('pos', { tab: o.tipo === 'domicilio' ? 'domicilios' : 'salon' });
  };

  LC.A.comandaNota = (d, el) => { const o = buscar(d.id); if (o) { LC.borrador(o).nota = el.value.slice(0, 200); LC.save(); } };

  LC.A.precuenta = async (d, el) => {
    const o = buscar(d.id); if (!o) return;
    if (pendientes(o).length && !confirm('Hay productos sin enviar y no saldrán en la pre-cuenta. ¿Imprimirla igual?')) return;
    el.disabled = true;
    try { await LC.accionPedido('precuenta', { orden: o.id }); } catch (e) { el.disabled = false; return aviso(e); }
    LC.toast('La pre-cuenta se imprime en caja');
    LC.render();
  };

  /* ---------- cobro ---------- */
  LC.A.cobrar = (d) => {
    const o = buscar(d.id); if (!o) return;
    if (pendientes(o).length) return LC.toast('Hay productos sin enviar. Envíalos o quítalos antes de cobrar.', 'error');
    const total = LC.totalOrden(o);
    const envio = o.tipo === 'domicilio' ? o.lineas.filter((l) => !l.anulada && l.categoria === 'Domicilio').reduce((a, l) => a + l.precio * l.qty, 0) : 0;
    LC.modal(`${LC.modalHead('Cobrar ' + LC.tituloOrden(o))}
      <form class="form cobro-form" data-submit="cobroConfirmar" data-in="cobroCalc" data-total="${total}">
        <input type="hidden" name="id" value="${o.id}">
        <div class="cobro-total"><span>Total a pagar</span><strong class="num">${LC.fmt(total)}</strong></div>
        ${envio ? `<div class="notice">El envío (${LC.fmt(envio)}) se le paga al mensajero en efectivo de la caja: la app lo resta sola del efectivo.</div>` : ''}
        <p class="muted">Escribe cuánto paga por cada medio. Si divide (mitad Nequi, mitad efectivo), llena ambos.</p>
        ${LC.CUENTAS.map((c) => `<div class="pago-row"><label>${c}<input type="number" name="p_${c}" min="0" step="1" inputmode="numeric" placeholder="0"></label>
          <button type="button" class="btn sm" data-a="cobroTodo" data-c="${c}">Todo</button><button type="button" class="btn sm" data-a="cobroResto" data-c="${c}">Resto</button></div>`).join('')}
        <label class="recibido">Efectivo que entrega el cliente<input type="number" name="recibido" min="0" step="1" inputmode="numeric" placeholder="Para calcular el cambio"></label>
        <div class="cobro-estado" id="cobro-estado"></div>
        <label class="check"><input type="checkbox" name="imprimir" checked><span>Imprimir recibo</span></label>
        <button class="btn ok lg block">Cerrar cuenta</button>
      </form>`);
    const f = document.querySelector('.cobro-form');
    // Si el domicilio dijo cómo paga, se deja lleno (se puede cambiar)
    if (o.pagoCliente && f.elements['p_' + o.pagoCliente]) f.elements['p_' + o.pagoCliente].value = total;
    LC.A.cobroCalc(null, f);
  };
  const pagado = (f) => LC.CUENTAS.reduce((a, c) => a + LC.num(f.elements['p_' + c].value), 0);
  LC.A.cobroTodo = (d, el) => {
    const f = el.form;
    LC.CUENTAS.forEach((c) => (f.elements['p_' + c].value = ''));
    f.elements['p_' + d.c].value = f.dataset.total;
    LC.A.cobroCalc(null, f);
  };
  LC.A.cobroResto = (d, el) => {
    const f = el.form, inp = f.elements['p_' + d.c];
    const resto = +f.dataset.total - (pagado(f) - LC.num(inp.value));
    inp.value = Math.max(0, resto);
    LC.A.cobroCalc(null, f);
  };
  LC.A.cobroCalc = (d, f) => {
    const total = +f.dataset.total, pag = pagado(f), falta = total - pag;
    const efe = LC.num(f.elements['p_Efectivo'].value), rec = LC.num(f.elements.recibido.value);
    let h = falta > 0 ? `<p class="neg">Falta ${LC.fmt(falta)}</p>` : falta < 0 ? `<p class="neg">Sobran ${LC.fmt(-falta)}: revisa los valores</p>` : '<p class="pos">Pago completo</p>';
    if (efe > 0 && rec > 0) h += rec >= efe ? `<p class="cambio">Cambio para el cliente <strong class="num">${LC.fmt(rec - efe)}</strong></p>` : '<p class="neg">El efectivo entregado es menor que el valor en efectivo</p>';
    document.getElementById('cobro-estado').innerHTML = h;
  };
  LC.A.cobroConfirmar = async (d, f) => {
    const o = buscar(d.id);
    if (!o || o.estado !== 'abierta') return;
    const total = LC.totalOrden(o);
    const pagos = LC.CUENTAS.map((c) => ({ cuenta: c, monto: Math.round(LC.num(d['p_' + c])) })).filter((x) => x.monto > 0);
    const suma = pagos.reduce((a, x) => a + x.monto, 0);
    if (suma !== total) return LC.toast(`Los pagos suman ${LC.fmt(suma)} y la cuenta es ${LC.fmt(total)}`, 'error');
    const efe = pagos.find((x) => x.cuenta === 'Efectivo');
    const rec = Math.round(LC.num(d.recibido));
    if (efe && rec && rec < efe.monto) return LC.toast('El efectivo entregado es menor que el valor en efectivo', 'error');
    // El servidor revisa que la cuenta siga valiendo lo mismo, la cobra y la deja en el libro contable
    const btn = f.querySelector('button.ok');
    btn.disabled = true;
    let r;
    try {
      r = await LC.accionPedido('cobrar', { orden: o.id, total, pagos, recibido: efe ? rec : 0, imprimir: !!d.imprimir });
    } catch (e) {
      btn.disabled = false;
      return aviso(e);
    }
    LC.toast(r.orden.cambio ? `Cuenta cerrada. Cambio: ${LC.fmt(r.orden.cambio)}` : 'Cuenta cerrada');
    LC.go('pos', { tab: o.tipo === 'domicilio' ? 'domicilios' : 'salon' });
  };

  /* ---------- tickets ---------- */
  const cab = () => {
    const c = LC.db.config;
    return `<div class="c b big">${esc(c.negocio)}</div>${c.nit ? `<div class="c s">NIT ${esc(c.nit)}</div>` : ''}${c.direccion ? `<div class="c s">${esc(c.direccion)}</div>` : ''}${c.telefono ? `<div class="c s">Tel. ${esc(c.telefono)}</div>` : ''}`;
  };
  function ticketComanda(o, c) {
    const ls = o.lineas.filter((l) => c.lids.includes(l.lid));
    return `<div class="c b big">COMANDA #${c.num}</div><div class="c b big">${esc(LC.tituloOrden(o))}</div>
      <div class="c">${LC.hora(c.en)}${o.numero ? ', orden #' + pad3(o.numero) : ''}</div><div class="c s">Tomó: ${esc(c.por)}</div>${c.nota ? `<div class="b">** ${esc(c.nota)}</div>` : ''}<div class="hr"></div>
      ${ls.map((l) => `<div class="b big">${l.qty} x ${esc(l.nombre)}</div>${l.detalle ? `<div class="ind">${esc(l.detalle)}</div>` : ''}${l.obs ? `<div class="ind b">** ${esc(l.obs)}</div>` : ''}`).join('')}
      <div class="hr"></div>${o.tipo === 'domicilio' ? `<div>${esc(o.direccion)}</div><div>${esc(o.telefono || '')}</div>` : ''}`;
  }
  function ticketCuenta(o, titulo, fecha) {
    const ls = o.lineas.filter((l) => !l.anulada);
    return `${cab()}<div class="hr"></div><div class="c b">${titulo}</div><div class="c">${esc(LC.tituloOrden(o))}, orden #${pad3(o.numero)}</div>
      <div class="c s">${LC.fechaHora(fecha || new Date())}</div><div class="hr"></div>
      ${ls.map((l) => `<div class="r"><span>${l.qty} ${esc(l.nombre)}</span><span>${LC.fmt(l.precio * l.qty)}</span></div>${l.detalle ? `<div class="ind s">${esc(l.detalle)}</div>` : ''}`).join('')}
      <div class="hr"></div><div class="r b big"><span>TOTAL</span><span>${LC.fmt(LC.totalOrden(o))}</span></div>
      ${o.pagos.length ? `<div class="hr"></div>${o.pagos.map((x) => `<div class="r"><span>${x.cuenta}</span><span>${LC.fmt(x.monto)}</span></div>`).join('')}
        ${o.cambio ? `<div class="r"><span>Recibido</span><span>${LC.fmt(o.recibido)}</span></div><div class="r b"><span>Cambio</span><span>${LC.fmt(o.cambio)}</span></div>` : ''}` : ''}
      <div class="hr"></div><div class="c s">${o.pagos.length ? 'Gracias por tu compra' : 'Documento informativo, no es factura'}</div>`;
  }
  function ticketDomicilio(o) {
    return `${cab()}<div class="hr"></div><div class="c b big">DOMICILIO #${pad3(o.numero)}</div>
      <div class="b">${esc(o.cliente)}</div><div>${esc(o.direccion)}</div><div>${esc(o.telefono || '')}</div>${o.nota ? `<div class="s">${esc(o.nota)}</div>` : ''}${o.pagoCliente ? `<div class="b">Paga con: ${esc(o.pagoCliente)}</div>` : ''}
      <div class="hr"></div>${o.lineas.filter((l) => !l.anulada).map((l) => `<div>${l.qty} ${esc(l.nombre)}</div>`).join('')}
      <div class="hr"></div><div class="r b big"><span>COBRAR</span><span>${LC.fmt(LC.totalOrden(o))}</span></div>`;
  }
  LC.A.ticketDomicilio = async (d) => {
    const o = buscar(d.id); if (!o) return;
    try { await LC.accionPedido('domicilio', { orden: o.id }); } catch (e) { return aviso(e); }
    LC.toast('Los datos de envío se imprimen en caja');
  };
  // Lo que imprime el PC de caja: cada trabajo trae la foto de la cuenta en ese momento
  LC.ticketDe = (j) => {
    const o = j.datos.orden;
    if (j.tipo === 'comanda') return ticketComanda(o, j.datos.comanda);
    if (j.tipo === 'precuenta') return ticketCuenta(o, 'PRE-CUENTA', j.creadoEn);
    if (j.tipo === 'recibo') return ticketCuenta(o, 'RECIBO DE PAGO', j.creadoEn);
    return ticketDomicilio(o);
  };

  /* ================= PANTALLA DE COCINA ================= */
  LC.V.cocina = (p) => {
    if (!LC.guard('cocina.comandas', 'cocina.inventario')) return LC.sinPermiso();
    const tabs = [];
    if (LC.can('cocina.comandas')) tabs.push(['comandas', 'Comandas']);
    if (LC.can('cocina.inventario')) tabs.push(['inventario', 'Inventario']);
    // Con la caja ya cerrada, lo que le falta a cocina es su inventario de cierre: se abre esa pestaña
    const pendiente = LC.esperandoCocina() && LC.can('cocina.inventario');
    const tab = tabs.some((x) => x[0] === p.tab) ? p.tab : pendiente ? 'inventario' : tabs[0][0];
    return `<div class="page-head"><h1>Cocina</h1></div>${tabs.length > 1 ? LC.tabs(tabs, tab, 'cocina') : ''}${tab === 'comandas' ? kdsHTML() : LC.cocinaInvHTML()}`;
  };
  function kdsHTML() {
    const t = LC.turno();
    if (!t && LC.esperandoCocina()) return `<div class="empty"><h2>La caja ya se cerró</h2><p>No hay más comandas en este turno. Falta el inventario de cierre de cocina.</p>
      ${LC.can('cocina.inventario') ? '<button class="btn primary lg" data-a="go" data-v="cocinaCierre">Hacer inventario de cierre</button>' : ''}</div>`;
    if (!t && LC.soloCocina()) return '<div class="empty"><h2>La encargada todavía no abre la caja</h2><p>Las comandas llegan aquí cuando abra la caja y las meseras empiecen a pedir.</p></div>';
    if (!t) return '<div class="empty"><h2>La caja está cerrada</h2></div>';
    const items = [];
    LC.db.ordenes.forEach((o) => {
      if (o.turnoId !== t.id || o.estado !== 'abierta') return; // una cuenta cobrada o cerrada ya no aparece en cocina
      o.comandas.forEach((c) => { if (c.estado !== 'entregado') items.push({ o, c }); });
    });
    items.sort((a, b) => a.c.num - b.c.num);
    if (!items.length) return '<div class="empty"><h2>Sin comandas pendientes</h2><p>Las comandas aparecen aquí en cuanto se envían desde una mesa o un domicilio.</p></div>';
    return `<div class="kds">${items.map(({ o, c }) => {
      const min = minutos(c.en);
      const ls = o.lineas.filter((l) => c.lids.includes(l.lid));
      return `<article class="ticket ${c.estado}${min >= 25 ? ' tarde' : min >= 15 ? ' alerta' : ''}">
        <header><span class="t-num">#${c.num}</span><span class="t-orig">${esc(LC.tituloOrden(o))}</span><span class="t-min">${min} min</span></header>
        ${c.nota ? `<p class="obs"><strong>Nota:</strong> ${esc(c.nota)}</p>` : ''}<ul>${ls.map((l) => `<li class="${l.anulada ? 'anulada' : ''}"><b>${l.qty}</b><div>${esc(l.nombre)}${l.detalle ? `<small>${esc(l.detalle)}</small>` : ''}${l.obs ? `<small class="obs">${esc(l.obs)}</small>` : ''}${l.anulada ? '<small>Anulado, no preparar</small>' : ''}</div></li>`).join('')}</ul>
        <footer><small>${LC.hora(c.en)}, ${esc(c.por)}</small>
          ${c.estado === 'pendiente' ? `<button class="btn maiz" data-a="kdsEstado" data-o="${o.id}" data-n="${c.num}" data-e="listo">Listo</button>` : `<button class="btn ok" data-a="kdsEstado" data-o="${o.id}" data-n="${c.num}" data-e="entregado">Entregado</button>`}
        </footer></article>`;
    }).join('')}</div>`;
  }
  LC.A.kdsEstado = async (d, el) => {
    const o = buscar(d.o); if (!o) return;
    const c = o.comandas.find((x) => x.num === +d.n); if (!c) return;
    el.disabled = true;
    try { await LC.accionPedido('comanda', { comanda: c.id, estado: d.e }); } catch (e) { aviso(e); }
    LC.render();
  };
})();
