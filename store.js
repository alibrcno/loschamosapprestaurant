/* =====================================================================
   Los Chamos POS v2 — Capa de datos
   ---------------------------------------------------------------------
   Todo el acceso a datos pasa por este archivo. Hoy guarda en
   localStorage (un solo dispositivo). En la fase 2 estas mismas
   funciones llamarán a la API conectada a Neon (PostgreSQL), sin
   tener que reescribir las pantallas.
   ===================================================================== */
'use strict';
(function () {
  const LC = (window.LC = window.LC || {});
  LC.VERSION = '2.0.0';
  LC.TENANT = 'loschamos'; // en fase 2 viene del login (multi-negocio)
  LC.KEY = 'lc2_' + LC.TENANT;

  LC.CUENTAS = ['Efectivo', 'Nequi', 'Bancolombia', 'Datáfono'];
  LC.TAMANOS = ['Personal', 'Mediana', 'Familiar'];
  LC.AREAS = ['Cocina', 'Salón', 'Caja', 'Domicilios'];
  LC.CAT_GASTO = ['Compra de inventario', 'Nómina', 'Domiciliario', 'Servicios públicos', 'Arriendo', 'Mantenimiento', 'Otros'];
  LC.CAT_INGRESO = ['Aporte del dueño', 'Base de caja', 'Préstamo', 'Otros'];
  LC.INV = { bebidas: 'Bebidas', utensilios: 'Utensilios y desechables', insumos: 'Insumos de cocina' };

  LC.PERMISOS = {
    'pos.tomar': 'Tomar pedidos de mesa y domicilio',
    'pos.precuenta': 'Imprimir pre-cuenta',
    'pos.cobrar': 'Cobrar y cerrar cuentas',
    'pos.anular': 'Anular productos ya enviados o servidos',
    'cocina.comandas': 'Ver y despachar comandas',
    'cocina.inventario': 'Llegadas e inventario de cocina',
    'turno.operar': 'Abrir y cerrar caja',
    'caja.movimientos': 'Registrar gastos, ingresos y traslados',
    'inventario.entradas': 'Registrar llegada de bebidas y utensilios',
    'reportes.ver': 'Ver finanzas y reportes',
    'catalogo.editar': 'Editar menú, precios, costos y stock sugerido',
    'usuarios.gestionar': 'Crear usuarios y asignar permisos'
  };

  LC.ROLES = {
    admin: { nombre: 'Administrador', permisos: Object.keys(LC.PERMISOS) },
    encargada: {
      nombre: 'Encargada',
      permisos: ['pos.tomar', 'pos.precuenta', 'pos.cobrar', 'pos.anular', 'cocina.comandas', 'turno.operar', 'caja.movimientos', 'inventario.entradas']
    },
    mesera: { nombre: 'Mesera', permisos: ['pos.tomar', 'pos.precuenta'] },
    cocina: { nombre: 'Cocina', permisos: ['cocina.comandas', 'cocina.inventario'] }
  };

  /* ---------------- utilidades ---------------- */
  const pad = (n) => String(n).padStart(2, '0');
  LC.uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  LC.num = (v) => {
    const n = parseFloat(String(v == null ? '' : v).replace(',', '.'));
    return isFinite(n) ? n : 0;
  };
  LC.fmt = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n || 0)).toLocaleString('es-CO');
  LC.q = (n) => (Math.round((+n || 0) * 100) / 100).toLocaleString('es-CO');
  LC.esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  LC.hora = (iso) => new Date(iso).toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' });
  LC.fecha = (iso) => new Date(iso).toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short' });
  LC.fechaLarga = (iso) => new Date(iso).toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  // Fecha local (Colombia) sin el desfase de UTC que tenía la versión anterior
  LC.diaLocal = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  LC.hash = async (texto, salt) => {
    const data = new TextEncoder().encode(salt + '::' + texto);
    if (window.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    let h1 = 0x811c9dc5, h2 = 0x1b873593;
    for (const b of data) { h1 = Math.imul(h1 ^ b, 16777619); h2 = Math.imul(h2 ^ b, 2246822507); }
    return 'fnv' + (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
  };

  /* ---------------- datos iniciales ---------------- */
  function seed(migrar) {
    const P = (categoria, nombre, precio) => ({ id: LC.uid(), categoria, nombre, precio, activo: true });
    const I = (nombre, unidad, costo, sugerido, extra) => Object.assign({ id: LC.uid(), nombre, unidad, costo, sugerido, stock: 0 }, extra || {});
    const db = {
      version: 2,
      config: {
        negocio: 'Los Chamos', whatsapp: '573218382315', mesas: 8, ticket: 58,
        nit: '', direccion: '', telefono: '', imprimirComandas: true, valorDomicilio: 0
      },
      usuarios: [],
      categorias: ['Pizzas', 'Hamburguesas', 'Arepas', 'Perros', 'Patacones', 'Entradas', 'Adicionales', 'Bebidas'],
      productos: [
        P('Hamburguesas', 'Hamburguesa clásica', 15000), P('Hamburguesas', 'Hamburguesa doble carne', 22000), P('Hamburguesas', 'Hamburguesa de pollo', 17000),
        P('Arepas', 'Arepa mixta', 14000), P('Arepas', 'Arepa de carne desmechada', 15000), P('Arepas', 'Arepa reina pepiada', 15000), P('Arepas', 'Arepa de queso', 9000),
        P('Perros', 'Perro sencillo', 9000), P('Perros', 'Perro especial', 14000),
        P('Patacones', 'Patacón mixto', 22000), P('Patacones', 'Patacón de pollo', 19000),
        P('Entradas', 'Tequeños x6', 15000), P('Entradas', 'Papas a la francesa', 7000),
        P('Adicionales', 'Adición de queso', 3000), P('Adicionales', 'Adición de tocineta', 4000)
      ],
      pizza: {
        tipos: [
          {
            id: 'sencilla', nombre: 'Pizza sencilla', gratis: 2,
            precios: { Personal: 15000, Mediana: 28000, Familiar: 38000 },
            extra: { Personal: 2000, Mediana: 3000, Familiar: 4000 },
            sabores: ['Jamón', 'Queso extra', 'Maíz', 'Piña', 'Salami', 'Champiñones', 'Pollo', 'Cebolla']
          },
          {
            id: 'premium', nombre: 'Pizza premium', gratis: 2,
            precios: { Personal: 20000, Mediana: 35000, Familiar: 45000 },
            extra: { Personal: 3000, Mediana: 4000, Familiar: 5000 },
            sabores: ['Pepperoni', 'Tocineta', 'Carne desmechada', 'Chorizo', 'Pollo BBQ', 'Camarones', 'Jamón', 'Maíz', 'Piña', 'Champiñones']
          }
        ]
      },
      bebidas: [
        I('Coca-Cola 400 ml', 'und', 2600, 24, { precio: 4000 }), I('Coca-Cola 1.5 L', 'und', 5500, 12, { precio: 8000 }),
        I('Postobón 400 ml', 'und', 2200, 24, { precio: 3500 }), I('Agua 600 ml', 'und', 1500, 12, { precio: 3000 }),
        I('Cerveza Águila', 'und', 2800, 48, { precio: 4000 }), I('Malta', 'und', 2300, 24, { precio: 3500 }),
        I('Gatorade', 'und', 3500, 12, { precio: 5000 })
      ],
      utensilios: [
        I('Servilletas', 'paquete', 3500, 10), I('Vasos 12 oz', 'paquete x50', 6000, 6), I('Tenedores', 'paquete x100', 5000, 4),
        I('Cuchillos', 'paquete x100', 5000, 4), I('Caja pizza personal', 'und', 700, 40), I('Caja pizza mediana', 'und', 900, 40),
        I('Caja pizza familiar', 'und', 1200, 30), I('Bolsa domicilio', 'und', 200, 50), I('Contenedor icopor', 'und', 350, 50)
      ],
      insumos: [
        I('Harina de maíz', 'kg', 4500, 10), I('Harina de trigo', 'kg', 3500, 10), I('Queso mozzarella', 'kg', 24000, 5),
        I('Jamón', 'kg', 18000, 3), I('Carne molida', 'kg', 22000, 4), I('Pollo desmechado', 'kg', 16000, 4),
        I('Pan de hamburguesa', 'und', 700, 40), I('Pan de perro', 'und', 500, 40), I('Salchicha', 'und', 900, 40),
        I('Plátano verde', 'und', 800, 30), I('Salsa de tomate', 'kg', 8000, 3), I('Aceite', 'L', 9000, 5)
      ],
      saldos: Object.fromEntries(LC.CUENTAS.map((c) => [c, 0])),
      turnos: [], turnoActualId: null,
      ordenes: [], movimientos: [], entradas: [], auditoria: []
    };
    if (migrar) migrarV1(db);
    return db;
  }

  // Trae bebidas, utensilios e insumos de la versión anterior si existen
  function migrarV1(db) {
    try {
      const leer = (k) => JSON.parse(localStorage.getItem(k) || 'null');
      const b = leer('chamos_bebidas'), u = leer('chamos_insumos_desechables'), i = leer('chamos_insumos');
      if (Array.isArray(b) && b.length)
        db.bebidas = b.map((x) => ({ id: LC.uid(), nombre: x.nombre, unidad: 'und', precio: LC.num(x.precio), costo: 0, stock: LC.num(x.stock), sugerido: LC.num(x.sugerido) }));
      if (Array.isArray(u) && u.length)
        db.utensilios = u.map((x) => ({ id: LC.uid(), nombre: x.nombre, unidad: x.unidad || 'und', costo: 0, stock: LC.num(x.stock), sugerido: LC.num(x.sugerido) }));
      if (Array.isArray(i) && i.length)
        db.insumos = i.map((x) => ({ id: LC.uid(), nombre: x.nombre, unidad: x.unidad || 'und', costo: 0, stock: LC.num(x.cantidad), sugerido: LC.num(x.ideal) }));
    } catch (e) { console.warn('Migración v1 omitida', e); }
  }

  LC.normalizar = (db) => {
    const base = seed(false);
    Object.keys(base).forEach((k) => { if (db[k] === undefined) db[k] = base[k]; });
    db.config = Object.assign({}, base.config, db.config);
    LC.CUENTAS.forEach((c) => { if (typeof db.saldos[c] !== 'number') db.saldos[c] = 0; });
    return db;
  };

  LC.load = () => {
    try {
      const raw = localStorage.getItem(LC.KEY);
      if (raw) return LC.normalizar(JSON.parse(raw));
    } catch (e) { console.error('No se pudo leer la base local', e); }
    return seed(true);
  };

  LC.save = () => {
    try { localStorage.setItem(LC.KEY, JSON.stringify(LC.db)); }
    catch (e) { alert('No se pudo guardar. El almacenamiento del navegador está lleno: exporta un respaldo en Ajustes > Datos.'); }
  };

  LC.db = LC.load();
  LC.user = null;

  /* ---------------- reglas de negocio ---------------- */
  LC.can = (p) => !!LC.user && (LC.user.rol === 'admin' || (LC.user.permisos || []).includes(p));
  LC.turno = () => LC.db.turnos.find((t) => t.id === LC.db.turnoActualId) || null;

  LC.log = (accion, detalle = '') => {
    LC.db.auditoria.push({ fecha: new Date().toISOString(), usuario: LC.user ? LC.user.nombre : 'sistema', accion, detalle });
    if (LC.db.auditoria.length > 5000) LC.db.auditoria.splice(0, 1000);
  };

  // Libro contable: cada peso que entra o sale queda aquí y mueve el saldo de su cuenta
  LC.mov = ({ tipo, cuenta, monto, concepto, categoria = '', ref = null }) => {
    const m = {
      id: LC.uid(), fecha: new Date().toISOString(), turnoId: LC.db.turnoActualId,
      tipo, cuenta, monto: Math.round(monto), concepto, categoria, ref, usuario: LC.user ? LC.user.nombre : 'sistema'
    };
    LC.db.movimientos.push(m);
    LC.db.saldos[cuenta] = (LC.db.saldos[cuenta] || 0) + m.monto;
    return m;
  };

  LC.totalOrden = (o) => o.lineas.filter((l) => !l.anulada).reduce((a, l) => a + l.precio * l.qty, 0);

  LC.entradasTurno = (turnoId, tipo) => {
    const m = {};
    LC.db.entradas.forEach((e) => { if (e.turnoId === turnoId && e.tipo === tipo) m[e.itemId] = (m[e.itemId] || 0) + e.cantidad; });
    return m;
  };

  LC.bebidasVendidasPOS = (turnoId, soloPagadas) => {
    const m = {};
    LC.db.ordenes.forEach((o) => {
      if (o.turnoId !== turnoId || o.estado === 'anulada') return;
      if (soloPagadas && o.estado !== 'pagada') return;
      o.lineas.forEach((l) => { if (l.bebidaId && !l.anulada) m[l.bebidaId] = (m[l.bebidaId] || 0) + l.qty; });
    });
    return m;
  };

  LC.stockBebidasTeorico = (t) => {
    const r = {};
    if (!t) { LC.db.bebidas.forEach((b) => (r[b.id] = LC.num(b.stock))); return r; }
    const ent = LC.entradasTurno(t.id, 'bebidas'), ven = LC.bebidasVendidasPOS(t.id, false);
    LC.db.bebidas.forEach((b) => (r[b.id] = LC.num(t.apertura.bebidas[b.id]) + LC.num(ent[b.id]) - LC.num(ven[b.id])));
    return r;
  };

  LC.categoriasMenu = () => {
    const set = [];
    LC.db.categorias.concat(LC.db.productos.map((p) => p.categoria)).forEach((c) => {
      if (c && c !== 'Pizzas' && c !== 'Bebidas' && !set.includes(c)) set.push(c);
    });
    return set;
  };
  LC.categoriasPOS = () => ['Pizzas'].concat(LC.categoriasMenu().filter((c) => LC.db.productos.some((p) => p.activo && p.categoria === c)), ['Bebidas']);

  /* Resumen completo de un turno: ventas, gastos, inventarios, costos y utilidad */
  LC.resumenTurno = (t) => {
    const db = LC.db;
    const movs = db.movimientos.filter((m) => m.turnoId === t.id);
    const ventasCuenta = Object.fromEntries(LC.CUENTAS.map((c) => [c, 0]));
    let ventas = 0, gastos = 0, gastosOp = 0, compras = 0, ingresos = 0;
    const gastosLista = [];
    movs.forEach((m) => {
      if (m.tipo === 'venta') { ventasCuenta[m.cuenta] = (ventasCuenta[m.cuenta] || 0) + m.monto; ventas += m.monto; }
      else if (m.tipo === 'gasto') {
        const v = -m.monto; gastos += v;
        if (m.categoria === 'Compra de inventario') compras += v; else gastosOp += v;
        gastosLista.push({ concepto: m.concepto, cuenta: m.cuenta, valor: v, categoria: m.categoria });
      } else if (m.tipo === 'ingreso') ingresos += m.monto;
    });

    const ords = db.ordenes.filter((o) => o.turnoId === t.id && o.estado === 'pagada');
    const porCategoria = {}, productos = {};
    ords.forEach((o) => o.lineas.forEach((l) => {
      if (l.anulada) return;
      const v = l.precio * l.qty;
      porCategoria[l.categoria] = (porCategoria[l.categoria] || 0) + v;
      const p = (productos[l.nombre] = productos[l.nombre] || { nombre: l.nombre, qty: 0, valor: 0 });
      p.qty += l.qty; p.valor += v;
    }));
    const anulaciones = db.ordenes.filter((o) => o.turnoId === t.id)
      .reduce((a, o) => a + o.lineas.filter((l) => l.anulada).length + (o.estado === 'anulada' ? 1 : 0), 0);

    const ap = t.apertura || {}, ci = t.cierre || null, co = (t.cocina && t.cocina.cierre) || null;
    const inv = (tipo, iniMap, finMap, posMap) => {
      const ent = LC.entradasTurno(t.id, tipo);
      return db[tipo].map((it) => {
        const ini = LC.num(iniMap[it.id]), e = LC.num(ent[it.id]);
        const fin = finMap ? LC.num(finMap[it.id]) : null;
        const consumo = fin === null ? null : ini + e - fin;
        const row = {
          id: it.id, nombre: it.nombre, unidad: it.unidad, ini, ent: e, fin, consumo,
          costo: consumo === null ? 0 : Math.max(0, consumo) * LC.num(it.costo),
          sugerido: LC.num(it.sugerido), comprar: fin === null ? null : Math.max(0, LC.num(it.sugerido) - fin)
        };
        if (tipo === 'bebidas') {
          row.precio = LC.num(it.precio); row.pos = LC.num(posMap[it.id]);
          row.valor = consumo === null ? 0 : consumo * row.precio;
          row.dif = consumo === null ? null : consumo - row.pos;
        }
        return row;
      });
    };
    const bebidas = inv('bebidas', ap.bebidas || {}, ci && ci.bebidas, LC.bebidasVendidasPOS(t.id, true));
    const utensilios = inv('utensilios', ap.utensilios || {}, ci && ci.utensilios, {});
    const insumos = inv('insumos', ap.insumos || {}, co && co.conteo, {});
    const sum = (arr, k) => arr.reduce((a, r) => a + (r[k] || 0), 0);
    const costoBebidas = sum(bebidas, 'costo'), costoUtensilios = sum(utensilios, 'costo'), costoInsumos = sum(insumos, 'costo');
    const costoConsumo = costoBebidas + costoUtensilios + costoInsumos;

    return {
      ventas, ventasCuenta, gastos, gastosOp, compras, ingresos, gastosLista,
      ordenesPagadas: ords.length, ticketProm: ords.length ? ventas / ords.length : 0,
      porCategoria, productos: Object.values(productos).sort((a, b) => b.valor - a.valor), anulaciones,
      bebidas, utensilios, insumos, ventaBebidasConteo: sum(bebidas, 'valor'),
      costoBebidas, costoUtensilios, costoInsumos, costoConsumo, cocinaCerrada: !!co,
      utilidad: ventas - costoConsumo - gastosOp, flujo: ventas + ingresos - gastos,
      descuadre: (ci && ci.descuadre) || null, personal: t.personal || []
    };
  };
})();
