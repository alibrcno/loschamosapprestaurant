// Primer día real después de dejar los datos en 0 (db/limpieza/datos_en_cero.sql):
// logo y tickets, todas las pantallas sin errores, y una venta de CADA producto del menú (cada pizza
// en cada tamaño, cada bebida, extras, domicilio) cobrada con todos los medios de pago. Al final se
// compara lo que dice el servidor con la suma de los precios del menú, peso por peso.
// Necesita los usuarios y el menú que deja dia-completo.js (así lo corre correr.sh).
const { chromium } = require('playwright'); // instalado aparte (no es dependencia del proyecto)
const zlib = require('zlib');
const BASE = process.env.BASE || 'http://localhost:8770/';
const ok = (c, m) => { console.log(c ? '✅' : '❌', m); if (!c) process.exitCode = 1; };

// Un PNG de 60×30 en rojo, hecho aquí mismo (sin archivos externos)
function pngDePrueba() {
  const w = 60, h = 30, crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const trozo = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const filas = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, Buffer.from([200, 30, 30]))])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), trozo('IHDR', ihdr), trozo('IDAT', zlib.deflateSync(filas)), trozo('IEND', Buffer.alloc(0))]);
}

(async () => {
  const b = await chromium.launch();
  const nuevo = async (tz = 'America/Bogota', celular = false) => {
    const ctx = await b.newContext({ timezoneId: tz, locale: 'es-CO', viewport: celular ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    ctx.on('page', (x) => { if (x !== p) x.close().catch(() => {}); });
    p.errs = []; p.on('pageerror', (e) => p.errs.push(e.message)); p.on('dialog', (d) => d.accept(d.type() === 'prompt' ? '10' : undefined));
    return p;
  };
  const toast = async (p) => { await p.waitForTimeout(500); return (await p.textContent('#toast')).trim(); };
  const entrar = async (p, u, c) => {
    await p.goto(BASE); await p.waitForSelector('form[data-submit=login]');
    await p.fill('input[name=codigo]', 'loschamos'); await p.fill('input[name=usuario]', u); await p.fill('input[name=clave]', c);
    await p.click('form[data-submit=login] button'); await p.waitForSelector('#nav .nav-i'); await p.waitForTimeout(400);
  };
  const texto = async (p, sel = '#main') => (await p.textContent(sel)).replace(/\s+/g, ' ');

  // ---- El dueño: logo, encabezado y mensaje del ticket ----
  const a = await nuevo();
  await entrar(a, 'alirio', 'clave-admin-1');
  const limpio = await a.evaluate(async () => { const t = await LC.api('turno'); return { turnos: t.turnos.length, saldos: t.saldos }; });
  ok(limpio.turnos === 0 && Object.values(limpio.saldos).every((x) => x === 0), 'La base arranca en 0: sin turnos y con las cuentas en $0');
  await a.click('[data-a=go][data-v=ajustes]'); await a.click('[data-a=go][data-tab=negocio]');
  const [selector] = await Promise.all([a.waitForEvent('filechooser'), a.click('[data-a=logoAbrir]')]);
  await selector.setFiles({ name: 'logo.png', mimeType: 'image/png', buffer: pngDePrueba() });
  await a.waitForFunction(() => document.querySelector('#toast').textContent === 'Logo guardado', null, { timeout: 10000 }).catch(() => {});
  ok(!!(await a.$('.brand .brand-logo')) && !!(await a.$('.logo-vista')), 'El dueño sube el logo y aparece arriba en la app (' + (await a.textContent('#toast')).trim() + ')');
  await a.fill('textarea[name=ticketEncabezado]', 'Domicilios 300 123 4567');
  await a.fill('textarea[name=ticketPie]', '¡Gracias por preferirnos!');
  await a.click('form[data-submit=negocioGuardar] button.primary');
  ok((await toast(a)) === 'Guardado', 'Encabezado y mensaje del ticket guardados');

  // ---- Acceso total: el dueño entra a TODAS las pantallas y pestañas sin errores ----
  const vistas = { inicio: [], pos: ['salon', 'domicilios'], cocina: ['comandas', 'inventario'], caja: [], reportes: ['resumen', 'turnos', 'semana', 'mes', 'movimientos', 'auditoria'],
    almacen: [], ajustes: ['menu', 'pizzas', 'bebidas', 'utensilios', 'insumos', 'preparaciones', 'negocio', 'usuarios', 'datos'] };
  let pantallas = 0;
  for (const [v, tabs] of Object.entries(vistas)) {
    await a.evaluate((v) => LC.go(v), v); await a.waitForTimeout(250); pantallas++;
    for (const t of tabs) { await a.evaluate(([v, t]) => LC.go(v, { tab: t }), [v, t]); await a.waitForTimeout(250); pantallas++; }
  }
  ok(!a.errs.length, `El dueño abrió ${pantallas} pantallas y pestañas sin un solo error`);

  // ---- Cocina abre; la encargada abre la caja en el PC de caja (que imprime) ----
  const c = await nuevo();
  await entrar(c, 'pedro', '1234');
  await c.evaluate(() => LC.go('cocina', { tab: 'inventario' })); await c.click('[data-a=cocinaAbrir]');
  const e = await nuevo('America/Bogota');
  await e.goto(BASE + '?estacion=1'); // así lo abre el acceso directo del PC de caja
  await e.waitForSelector('form[data-submit=login]');
  await e.fill('input[name=codigo]', 'loschamos'); await e.fill('input[name=usuario]', 'ana'); await e.fill('input[name=clave]', '1234');
  await e.click('form[data-submit=login] button'); await e.waitForSelector('#nav .nav-i'); await e.waitForTimeout(400);
  ok((await texto(e, '#top')).includes('Imprime aquí'), 'El PC de caja abierto con el acceso directo queda como estación de impresión');
  await e.evaluate(() => { window.__impresos = []; LC.imprimir = async (html) => { window.__impresos.push(html); }; });
  await e.click('[data-a=go][data-v=apertura]');
  await e.click('form[data-submit=apPersonal] button.primary');
  for (let i = 0; i < 2; i++) { await e.waitForSelector('form[data-submit=apConteo]'); for (const x of await e.$$('form[data-submit=apConteo] input[type=number]')) await x.fill(i ? '20' : '50'); await e.click('form[data-submit=apConteo] button.primary'); await e.waitForTimeout(200); }
  await e.fill('input[name="s_Efectivo"]', '200000');
  for (const k of ['Nequi', 'Bancolombia', 'Datáfono']) await e.fill('input[name="s_' + k + '"]', '0');
  await e.click('form[data-submit=apSaldos] button.primary');
  await e.fill('textarea[name=nota]', 'Base del primer día');
  await e.click('form[data-submit=apConfirmar] button.primary'); await e.waitForSelector('.hero-turno.abierto');
  await e.click('[data-a=go][data-v=caja]'); await e.click('[data-a=imprimirPrueba]'); await e.waitForTimeout(300);
  const prueba = await e.evaluate(() => window.__impresos[0] || '');
  ok(prueba.includes('<img') && prueba.includes('Domicilios 300 123 4567') && prueba.includes('¡Gracias por preferirnos!'), 'La prueba de impresión trae el logo, el encabezado y el mensaje');

  // ---- La mesera vende TODO el menú ----
  const m = await nuevo('UTC', true);
  await entrar(m, 'maria', '1234');
  const menu = await m.evaluate(() => ({ cats: LC.categoriasMenu().filter((cat) => LC.db.productos.some((p) => p.activo && p.categoria === cat)), productos: LC.db.productos.filter((p) => p.activo),
    pizzas: LC.db.pizza.tipos, bebidas: LC.db.bebidas, extras: LC.db.extras, domicilio: LC.valorDomicilio() }));
  let esperado = 0, lineas = 0, envios = 0;
  const abrirMesa = async (n) => { await m.click('[data-a=go][data-v=pos]'); await m.waitForTimeout(300); await m.click(`[data-a=mesaAbrir][data-m="${n}"]`); };
  const enviar = async () => { await m.click('[data-a=comandaEnviar]'); await m.waitForTimeout(500); envios++; };
  // Una mesa por categoría del menú, con todos sus productos
  let mesa = 1;
  for (const cat of menu.cats) {
    await abrirMesa(mesa++);
    await m.click(`[data-a=posCat][data-c="${cat}"]`);
    for (const p of menu.productos.filter((x) => x.categoria === cat)) { await m.click(`[data-a=addProd][data-id="${p.id}"]`); esperado += p.precio; lineas++; }
    // Si la categoría tiene extras, se marca el primero en una línea
    const ex = (menu.extras[cat] || [])[0];
    if (ex) { await m.click('[data-a=lineaExtra][data-i="0"] >> nth=0'); esperado += ex.precio; }
    await enviar();
  }
  // Cada pizza en cada tamaño, con un sabor más de los incluidos (se cobra el adicional)
  await abrirMesa(mesa++);
  for (const tp of menu.pizzas) {
    for (const tam of ['Personal', 'Mediana', 'Familiar'].filter((s) => tp.precios[s] > 0)) {
      await m.click('[data-a=posCat][data-c=Pizzas]'); await m.click(`[data-a=pizzaNueva][data-t="${tp.id}"]`);
      await m.click(`.pizza-form label:has(input[name=tam][value=${tam}])`);
      for (const s of tp.sabores.slice(0, tp.gratis + 1)) await m.check(`.pizza-form input[name=sabor][value="${s}"]`);
      await m.click('.pizza-form button.primary'); await m.waitForTimeout(150);
      esperado += tp.precios[tam] + tp.extra[tam]; lineas++;
    }
  }
  await enviar();
  // Una de cada bebida
  await abrirMesa(mesa++);
  await m.click('[data-a=posCat][data-c=Bebidas]');
  for (const bb of menu.bebidas) { await m.click(`[data-a=addBebida][data-id="${bb.id}"]`); esperado += bb.precio; lineas++; }
  await enviar();
  // Domicilio con el envío por defecto
  await m.click('[data-a=go][data-v=pos][data-tab=domicilios]'); await m.click('[data-a=domNuevo]');
  await m.fill('.modal input[name=cliente]', 'Cliente Domicilio'); await m.fill('.modal input[name=direccion]', 'Calle 16 # 12-30');
  await m.click('.modal label:has(input[name=pago][value=Datáfono])'); await m.click('.modal button.primary');
  await m.click('[data-a=posCat][data-c=Bebidas]'); await m.click(`[data-a=addBebida][data-id="${menu.bebidas[0].id}"]`);
  esperado += menu.domicilio + menu.bebidas[0].precio; lineas++;
  await enviar();
  ok(!m.errs.length, `La mesera cargó ${lineas} productos en ${envios} pedidos (todo el menú) sin errores`);

  // ---- La encargada anula uno con motivo y cobra cada cuenta con un medio de pago distinto ----
  await e.click('[data-a=go][data-v=pos]'); await e.waitForTimeout(500);
  await e.click('.mesa.ocupada >> nth=0');
  const [anulado, anuladoNombre] = await e.evaluate(() => { const l = document.querySelector('.linea [data-a=lineaAnular]').closest('.linea'); return [l.querySelector('.num').textContent, l.querySelector('strong').textContent]; });
  await e.click('.linea [data-a=lineaAnular] >> nth=0');
  await e.fill('.modal input[name=motivo]', 'El cliente no lo quiso'); await e.click('.modal button.danger'); await e.waitForTimeout(400);
  esperado -= Number(anulado.replace(/\D/g, ''));
  const formas = ['efectivoCambio', 'Nequi', 'Bancolombia', 'Datáfono', 'dividido', 'efectivoExacto', 'Nequi', 'Bancolombia', 'dividido'];
  let cobradas = 0, f = 0;
  const cobrar = async () => {
    await e.click('[data-a=cobrar]'); await e.waitForSelector('.cobro-form');
    const total = +(await e.getAttribute('.cobro-form', 'data-total'));
    for (const k of ['Efectivo', 'Nequi', 'Bancolombia', 'Datáfono']) await e.fill(`input[name=p_${k}]`, '');
    const forma = formas[f++ % formas.length];
    if (forma === 'efectivoCambio') { await e.click('[data-a=cobroTodo][data-c=Efectivo]'); await e.fill('input[name=recibido]', String(Math.ceil((total + 1) / 50000) * 50000)); }
    else if (forma === 'efectivoExacto') await e.click('[data-a=cobroTodo][data-c=Efectivo]');
    else if (forma === 'dividido') { await e.fill('input[name=p_Nequi]', String(Math.floor(total / 2))); await e.click('[data-a=cobroResto][data-c=Efectivo]'); }
    else await e.click(`[data-a=cobroTodo][data-c="${forma}"]`);
    await e.click('.cobro-form button.ok'); await e.waitForTimeout(600); cobradas++;
  };
  await cobrar();
  while (await e.$('.mesa.ocupada')) { await e.click('.mesa.ocupada >> nth=0'); await cobrar(); }
  await e.click('[data-a=go][data-v=pos][data-tab=domicilios]'); await e.click('.list-item'); await cobrar();
  ok(cobradas === envios, `${cobradas} cuentas cobradas con efectivo (con cambio y exacto), Nequi, Bancolombia, Datáfono y pagos divididos`);
  await e.waitForTimeout(4500);
  const impresos = await e.evaluate(() => window.__impresos.map((h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')));
  const recibos = impresos.filter((x) => x.includes('RECIBO DE PAGO'));
  // Van a cocina todas las mesas menos la de bebidas y el domicilio (solo lleva una bebida)
  ok(impresos.filter((x) => x.includes('COMANDA #')).length === envios - 2 && recibos.length === cobradas, `El PC de caja imprimió solo las ${envios - 2} comandas y los ${recibos.length} recibos`);
  ok(recibos.every((x) => x.includes('¡Gracias por preferirnos!')), 'Todos los recibos llevan el mensaje del dueño');

  // ---- Cierre de caja: cuadra el dinero y las bebidas ----
  const estado = await e.evaluate(async () => { await LC.cargarTurno(); await LC.cargarPedidos(true); const t = LC.turno(); return { saldos: LC.db.saldos, vendidas: LC.bebidasVendidasPOS(t.id, true) }; });
  await e.click('[data-a=go][data-v=caja]'); await e.click('[data-a=go][data-v=cierre]');
  for (let i = 0; i < 2; i++) {
    await e.waitForSelector('form[data-submit=ciConteo]');
    for (const x of await e.$$('form[data-submit=ciConteo] input[type=number]')) {
      const id = (await x.getAttribute('name')).slice(2);
      await x.fill(String(i ? 20 : 50 - (estado.vendidas[id] || 0)));
    }
    await e.click('form[data-submit=ciConteo] button.primary'); await e.waitForTimeout(200);
  }
  for (const k of Object.keys(estado.saldos)) await e.fill('input[name="s_' + k + '"]', String(estado.saldos[k]));
  await e.click('form[data-submit=ciSaldos] button.primary');
  ok(!(await e.$('form[data-submit=ciConfirmar] .notice.bad')), 'Todo cuadra: el dinero de cada cuenta y cada bebida vendida');
  await e.click('form[data-submit=ciConfirmar] button.primary'); await e.waitForSelector('.hero-turno');
  await c.waitForTimeout(4500);
  await c.evaluate(() => LC.go('cocinaCierre'));
  for (const x of await c.$$('form[data-submit=coConteo] input[type=number]')) await x.fill('1');
  await c.click('form[data-submit=coConteo] button.primary');
  await c.click('form[data-submit=coConfirmar] button.primary'); await c.waitForTimeout(900);
  ok((await c.textContent('#toast')).includes('Turno terminado'), 'Cocina cierra de último y termina el turno');

  // ---- Lo que dice el servidor, peso por peso ----
  const r = await a.evaluate(async () => { await LC.cargarTurno(); return LC.db.turnos.find((t) => t.estado === 'cerrado').resumen; });
  ok(r.ventas === esperado, `Ventas del servidor ${r.ventas} = suma de los precios del menú ${esperado}`);
  ok(r.ordenesPagadas === cobradas && r.anulaciones === 1, `${r.ordenesPagadas} cuentas pagadas y 1 anulación`);
  ok(Object.values(r.porCategoria).reduce((x, y) => x + y, 0) === esperado, 'La suma por categoría da lo mismo');
  const vendidos = new Set(r.productos.map((x) => x.nombre));
  ok(menu.productos.every((p) => vendidos.has(p.nombre) || p.nombre === anuladoNombre) && menu.bebidas.every((bb) => vendidos.has(bb.nombre)), `Cada producto y cada bebida del menú aparece en "lo más vendido" (menos ${anuladoNombre}, que se anuló)`);
  ok(r.bebidas.every((x) => !x.dif), 'Ninguna bebida con diferencia entre el conteo y lo cobrado');
  ok(Object.values(r.descuadre).every((x) => x === 0), 'Sin descuadre en ninguna cuenta');
  await a.click('[data-a=go][data-v=reportes]'); await a.click('[data-a=go][data-tab=semana]'); await a.waitForTimeout(600);
  ok((await texto(a)).includes(`$${esperado.toLocaleString('es-CO')}`), 'Reportes → Semana muestra la venta del día');

  // ---- El dueño reinicia el restaurante a 0 desde la app, con su clave ----
  await a.evaluate(() => LC.go('ajustes', { tab: 'datos' })); await a.waitForTimeout(800);
  await a.evaluate(() => LC.go('ajustes', { tab: 'datos' })); await a.waitForTimeout(300);
  await a.click('[data-a=reinicioAbrir]');
  await a.fill('.modal input[name=clave]', 'clave-equivocada'); await a.fill('.modal input[name=confirmacion]', 'REINICIAR');
  await a.click('.modal button.danger');
  ok((await toast(a)).includes('no es correcta'), 'Con la clave equivocada no reinicia');
  await a.fill('.modal input[name=clave]', 'clave-de-reinicio-prueba'); await a.click('.modal button.danger');
  await a.waitForTimeout(800);
  const cero = await a.evaluate(async () => { const t = await LC.api('turno'); const c = await LC.api('catalogo'); return { turnos: t.turnos.length, saldos: Object.values(t.saldos), productos: c.productos.length, logo: !!c.negocio.logo }; });
  ok((await a.textContent('#toast')).includes('quedó en 0') && cero.turnos === 0 && cero.saldos.every((x) => x === 0) && cero.productos > 0 && cero.logo,
    'Reinicio desde Ajustes → Datos: todo en 0, y se conservan el menú y el logo');
  const cm = await nuevo(); await entrar(cm, 'maria', '1234');
  ok((await texto(cm)).includes('La caja está cerrada'), 'Después del reinicio el restaurante arranca como el primer día');

  const errs = [a, e, m, c].flatMap((p) => p.errs);
  ok(!errs.length, errs.length ? 'ERRORES: ' + errs.join(' | ') : 'Sin errores de JavaScript en ningún equipo');
  await b.close();
})().catch((e) => { console.error('FALLÓ:', e.message.split('\n')[0]); process.exit(1); });
