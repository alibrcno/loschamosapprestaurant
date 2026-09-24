// Mejoras del dueño: cocina abre primero, factura con varios artículos, extras, nota de comanda,
// domicilios con envío en efectivo, preparaciones, almacén y reporte de la semana
const { chromium } = require('playwright'); // instalado aparte (no es dependencia del proyecto)
const BASE = process.env.BASE || 'http://localhost:8770/';
const ok = (c, m) => { console.log(c ? '✅' : '❌', m); if (!c) process.exitCode = 1; };
(async () => {
  const b = await chromium.launch();
  const nuevo = async (tz = 'America/Bogota', celular = false) => {
    const ctx = await b.newContext({ timezoneId: tz, locale: 'es-CO', viewport: celular ? { width: 390, height: 844 } : { width: 1200, height: 900 } });
    const p = await ctx.newPage();
    ctx.on('page', (x) => { if (x !== p) { p.popups = (p.popups || 0) + 1; x.close().catch(() => {}); } });
    p.errs = []; p.on('pageerror', (e) => p.errs.push(e.message)); p.on('dialog', (d) => d.accept(d.type() === 'prompt' ? '12' : undefined));
    return p;
  };
  const toast = async (p) => { await p.waitForTimeout(600); return (await p.textContent('#toast')).trim(); };
  const entrar = async (p, u, c) => {
    await p.goto(BASE); await p.waitForSelector('form[data-submit=login]');
    await p.fill('input[name=codigo]', 'loschamos'); await p.fill('input[name=usuario]', u); await p.fill('input[name=clave]', c);
    await p.click('form[data-submit=login] button'); await p.waitForSelector('#nav .nav-i'); await p.waitForTimeout(400);
  };
  const texto = async (p, sel = '#main') => (await p.textContent(sel)).replace(/\s+/g, ' ');

  // ---- Administrador: personal, menú, extras y preparaciones (desde Ajustes) ----
  const a = await nuevo();
  await entrar(a, 'alirio', 'clave-admin-1');
  await a.evaluate(async () => {
    for (const [nombre, usuario, rol] of [['Encargada Ana', 'ana', 'encargada'], ['Pedro Cocina', 'pedro', 'cocina'], ['María Mesera', 'maria', 'mesera']])
      await LC.api('usuarios', { method: 'POST', body: { nombre, usuario, clave: '1234', rol } });
    await LC.subirCatalogo();
  });
  await a.click('[data-a=go][data-v=ajustes]'); await a.waitForTimeout(400);
  await a.fill('form[data-submit=extrasGuardar]:has(input[value=Hamburguesas]) textarea', 'Queso extra: 3000\nTocineta 4.000');
  await a.click('form[data-submit=extrasGuardar]:has(input[value=Hamburguesas]) button');
  ok((await toast(a)) === 'Extras guardados', 'El dueño pone extras a las Hamburguesas en Ajustes → Menú');
  await a.click('[data-a=go][data-tab=preparaciones]');
  await a.click('[data-a=prepEditar][data-i="-1"]');
  await a.fill('.modal input[name=nombre]', 'Salsa de pizza');
  const idQueso = await a.evaluate(() => LC.db.insumos.find((x) => x.nombre === 'Queso mozzarella').id);
  const idTomate = await a.evaluate(() => LC.db.insumos.find((x) => x.nombre === 'Salsa de tomate').id);
  await a.selectOption('.modal .fila-material >> nth=0 >> select', idTomate); await a.fill('.modal .fila-material >> nth=0 >> input', '2');
  await a.click('.modal [data-a=prepFila]');
  await a.selectOption('.modal .fila-material >> nth=1 >> select', idQueso); await a.fill('.modal .fila-material >> nth=1 >> input', '1');
  await a.click('.modal button.primary');
  ok((await toast(a)) === 'Preparación guardada' && (await texto(a)).includes('Salsa de pizza'), 'El dueño crea la preparación "Salsa de pizza" con sus materiales');

  // ---- El dueño crea un insumo que se cuenta en gramos, con su costo y su stock sugerido ----
  await a.click('[data-a=go][data-tab=insumos]');
  await a.fill('form[data-submit=invNuevo] input[name=nombre]', 'Carne molida');
  await a.selectOption('form[data-submit=invNuevo] select[name=unidad]', 'g');
  await a.fill('form[data-submit=invNuevo] input[name=costo]', '25');
  await a.fill('form[data-submit=invNuevo] input[name=sugerido]', '5000');
  await a.click('form[data-submit=invNuevo] button.primary');
  ok((await toast(a)).startsWith('Agregado') && (await a.evaluate(() => { const x = LC.db.insumos.find((i) => i.nombre === 'Carne molida'); return x && x.unidad === 'g' && x.sugerido === 5000 && x.costo === 25; })), 'Insumo nuevo: se cuenta en gramos, $25 el gramo, stock sugerido 5.000 g');
  ok((await texto(a)).includes('Stock sugerido (solo lo ves tú)'), 'El stock sugerido se configura en Ajustes, que solo ve el dueño');

  // ---- 4 p. m.: cocina llega primero y abre su turno ----
  const c = await nuevo('America/Bogota');
  await entrar(c, 'pedro', '1234');
  await c.click('[data-a=go][data-v=cocina]'); await c.waitForTimeout(300);
  await c.click('[data-a=go][data-tab=inventario]');
  await c.click('[data-a=cocinaAbrir]');
  ok((await toast(c)).startsWith('Cocina abierta'), 'Cocina abre el turno sin esperar a la encargada');
  await c.click('[data-a=entradaNueva][data-solo=insumos]');
  ok(!(await c.$('.modal select[name=cuenta]')), 'Cocina no elige de qué cuenta se pagó la factura');
  await c.selectOption('.modal .fila-llegada >> nth=0 >> select', 'insumos|' + idQueso); await c.fill('.modal .fila-llegada >> nth=0 >> [name=cantidad]', '3');
  await c.fill('.modal .fila-llegada >> nth=0 >> [name=costo]', '90000'); // antes $24.000 el kilo, ahora $30.000
  await c.click('.modal [data-a=entradaFila]');
  await c.selectOption('.modal .fila-llegada >> nth=1 >> select', 'insumos|' + idTomate); await c.fill('.modal .fila-llegada >> nth=1 >> [name=cantidad]', '2');
  await c.fill('.modal input[name=nota]', 'Lácteos, factura 55');
  // Foto de la factura con la cámara del celular (aquí, una imagen de prueba)
  const [selector] = await Promise.all([c.waitForEvent('filechooser'), c.click('.modal [data-a=facturaFoto]')]);
  await selector.setFiles({ name: 'factura.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64') });
  await c.waitForSelector('.modal .foto-mini');
  await c.click('.modal button.primary');
  const tl = await toast(c);
  ok(tl.startsWith('2 artículos registrados') && tl.includes('Llegó más caro: Queso mozzarella (+25 %)'), 'Cocina registra una factura con 2 artículos y foto; avisa que el queso llegó más caro: "' + tl + '"');
  ok(!!(await c.$('[data-a=fotoVer]')), 'La llegada queda con "📷 Ver factura"');

  // ---- La mesera todavía no puede vender ----
  const m = await nuevo('UTC', true);
  await entrar(m, 'maria', '1234');
  ok((await texto(m)).includes('La caja está cerrada'), 'Sin caja abierta la mesera no toma pedidos');

  // ---- 5 p. m.: la encargada abre la caja en el mismo turno ----
  const e = await nuevo();
  await entrar(e, 'ana', '1234');
  ok((await texto(e, '.hero-turno')).includes('Cocina abierta desde'), 'Inicio de la encargada: "Cocina abierta… falta abrir la caja"');
  await e.click('[data-a=go][data-v=apertura]');
  const idPedro = await e.evaluate(() => LC.equipo.find((u) => u.nombre === 'Pedro Cocina').id);
  ok((await e.inputValue('select[name=p_' + idPedro + ']')) === 'Cocina', 'El cocinero ya aparece en Cocina');
  await e.click('form[data-submit=apPersonal] button.primary');
  for (let i = 0; i < 2; i++) { await e.waitForSelector('form[data-submit=apConteo]'); for (const x of await e.$$('form[data-submit=apConteo] input[type=number]')) await x.fill(i ? '5' : '10'); await e.click('form[data-submit=apConteo] button.primary'); await e.waitForTimeout(200); }
  await e.fill('input[name="s_Efectivo"]', '100000');
  for (const k of ['Nequi', 'Bancolombia', 'Datáfono']) await e.fill('input[name="s_' + k + '"]', '0');
  await e.click('form[data-submit=apSaldos] button.primary');
  await e.fill('textarea[name=nota]', 'Base de la caja');
  await e.click('form[data-submit=apConfirmar] button.primary'); await e.waitForSelector('.hero-turno.abierto');
  ok((await toast(e)).startsWith('Caja abierta') && !e.popups, 'Caja abierta sin abrir WhatsApp (el reporte lo manda el servidor)');

  // ---- Mesera: hamburguesa con extras y nota para cocina ----
  await m.click('[data-a=go][data-v=pos]'); await m.waitForTimeout(400);
  await m.click('[data-a=mesaAbrir][data-m="2"]');
  await m.click('[data-a=posCat][data-c=Hamburguesas]'); await m.click('[data-a=addProd] >> text=Hamburguesa clásica');
  ok(!(await m.$('.modal')) && (await texto(m, '.cuenta')).includes('$15.000'), 'La hamburguesa se agrega de una vez, sin abrir otra pantalla');
  await m.click('[data-a=addProd] >> text=Hamburguesa clásica');
  ok((await texto(m, '.cuenta')).includes('2×'), 'Dos hamburguesas en la misma línea');
  await m.click('[data-a=lineaExtra][data-i="0"]'); await m.click('.linea:has-text("Con Queso extra") [data-a=lineaExtra][data-i="1"]');
  const cuenta = await texto(m, '.cuenta');
  ok(cuenta.includes('Con Queso extra, Tocineta') && cuenta.includes('$22.000') && cuenta.includes('$37.000'), 'Los extras se marcan en la línea, solo para UNA hamburguesa: $15.000 + $22.000 = $37.000');
  await m.fill('[data-in=comandaNota]', 'Tienen afán');
  await m.click('[data-a=comandaEnviar]'); await m.waitForTimeout(500);

  // ---- Domicilio: datos obligatorios, cómo paga y valor del envío ----
  await m.click('[data-a=go][data-v=pos][data-tab=domicilios]');
  await m.click('[data-a=domNuevo]');
  ok((await m.inputValue('.modal input[name=envio]')) === '6000', 'El envío viene en $6.000 por defecto');
  await m.fill('.modal input[name=cliente]', 'Carlos Pérez'); await m.fill('.modal input[name=direccion]', 'Cra 9 # 10-20'); await m.fill('.modal input[name=envio]', '3000');
  await m.click('.modal label:has(input[name=pago][value=Nequi])');
  await m.click('.modal button.primary');
  await m.click('[data-a=posCat][data-c=Arepas]'); await m.click('[data-a=addProd] >> text=Arepa mixta');
  await m.click('[data-a=comandaEnviar]'); await m.waitForTimeout(500);
  ok((await texto(m)).includes('paga con Nequi'), 'El domicilio dice cómo paga el cliente');

  // ---- Cocina ve la nota ----
  await c.click('[data-a=go][data-v=cocina]'); await c.click('[data-a=go][data-tab=comandas]'); await c.waitForTimeout(500);
  ok((await texto(c, '.kds')).includes('Nota: Tienen afán') && (await c.$$('.kds .ticket')).length === 2, 'Cocina ve las 2 comandas y la nota "Tienen afán"');

  // ---- Encargada cobra: la mesa sale de cocina sola; el envío sale del efectivo ----
  await e.click('[data-a=go][data-v=pos]'); await e.click('.mesa.ocupada'); await e.click('[data-a=cobrar]');
  await e.click('[data-a=cobroTodo][data-c=Efectivo]'); await e.click('.cobro-form button.ok'); await e.waitForSelector('.mesas');
  await c.waitForTimeout(4500);
  ok((await c.$$('.kds .ticket')).length === 1, 'La mesa cobrada desapareció de cocina sin que cocina tocara "Entregado"');
  await e.click('[data-a=go][data-v=pos][data-tab=domicilios]'); await e.click('.list-item'); await e.click('[data-a=cobrar]');
  ok((await e.inputValue('input[name=p_Nequi]')) === '17000' && (await texto(e, '.cobro-form')).includes('se le paga al mensajero en efectivo'), 'El cobro del domicilio viene lleno en Nequi y avisa lo del mensajero');
  await e.click('.cobro-form button.ok'); await e.waitForSelector('.list, .empty');
  await e.waitForTimeout(400);
  const saldos = await e.evaluate(() => LC.db.saldos);
  ok(saldos.Efectivo === 100000 + 37000 - 3000 && saldos.Nequi === 17000, 'Efectivo: base + mesa − envío del mensajero; Nequi: el domicilio ' + JSON.stringify(saldos));

  // ---- El dueño guarda tenedores en su almacén y saca unos al turno ----
  await a.click('[data-a=go][data-v=almacen]'); await a.waitForSelector('[data-a=almMov]');
  const idServ = await a.evaluate(() => LC.db.utensilios.find((x) => x.nombre === 'Servilletas').id);
  await a.click('[data-a=almMov][data-accion=entrada]');
  await a.selectOption('.modal select[name=itemId]', idServ); await a.fill('.modal input[name=cantidad]', '10'); await a.fill('.modal input[name=costo]', '35000');
  await a.click('.modal button.primary'); await a.waitForTimeout(500);
  ok((await texto(a, '.stat-row')).includes('$35.000'), 'Avalúo del almacén: $35.000');
  await a.click('[data-a=almMov][data-accion=salida]');
  await a.selectOption('.modal select[name=itemId]', idServ); await a.fill('.modal input[name=cantidad]', '2');
  await a.click('.modal button.primary'); await a.waitForTimeout(500);
  ok((await texto(a)).includes('salió al turno') && (await texto(a, '.stat-row')).includes('$28.000'), 'Saca 2 al turno: quedan 8 ($28.000)');

  // ---- Cierre de caja: la encargada no ve compras de cocina ----
  await e.click('[data-a=go][data-v=caja]'); await e.click('[data-a=go][data-v=cierre]');
  for (let i = 0; i < 2; i++) {
    await e.waitForSelector('form[data-submit=ciConteo]');
    for (const x of await e.$$('form[data-submit=ciConteo] label.row-count')) { const n = await x.textContent(); await (await x.$('input')).fill(i ? (n.includes('Servilletas') ? '7' : '5') : '10'); }
    await e.click('form[data-submit=ciConteo] button.primary'); await e.waitForTimeout(200);
  }
  for (const k of Object.keys(saldos)) await e.fill('input[name="s_' + k + '"]', String(saldos[k]));
  await e.click('form[data-submit=ciSaldos] button.primary');
  ok((await texto(e, 'form[data-submit=ciConfirmar]')).includes('Lo de cocina (insumos) sale en el reporte final'), 'El cierre de la encargada no trae las compras de cocina');
  await e.click('form[data-submit=ciConfirmar] button.primary'); await e.waitForSelector('.hero-turno');
  ok((await toast(e)).includes('Falta el inventario de cocina') && !e.popups, 'Caja cerrada sin WhatsApp');

  // ---- Cocina cierra de último: preparación y observación, sin costos ----
  await c.waitForTimeout(4500);
  ok((await texto(c)).includes('Hacer inventario de cierre'), 'Cocina se entera sola, en segundos, de que la caja se cerró');
  await c.click('[data-a=go][data-v=cocinaCierre]');
  for (const x of await c.$$('form[data-submit=coConteo] label.row-count')) await (await x.$('input')).fill('1');
  await c.check('form[data-submit=coConteo] input[name=prep]');
  await c.click('form[data-submit=coConteo] button.primary');
  const rev = await texto(c, 'form[data-submit=coConfirmar]');
  ok(!rev.includes('Costo') && rev.includes('Preparar mañana: Salsa de pizza'), 'Cocina no ve costos y ve lo que hay que preparar');
  await c.fill('textarea[name=obs]', 'Se dañó una tubería');
  await c.click('form[data-submit=coConfirmar] button.primary'); await c.waitForTimeout(900);
  ok((await c.textContent('#toast')).includes('Turno terminado') && !c.popups, 'Cocina cierra de último y termina el turno (sin WhatsApp)');

  // ---- El dueño ve lo que llegó más caro y la foto de la factura ----
  await a.click('[data-a=go][data-v=reportes]'); await a.waitForTimeout(900); await a.click('[data-a=go][data-tab=resumen]'); await a.waitForTimeout(900);
  ok((await texto(a)).includes('Queso mozzarella: $24.000 → $30.000 por kg (+25 %)'), 'Reportes → Cuentas: "Llegó más caro: Queso mozzarella $24.000 → $30.000 (+25 %)"');

  // ---- Reportes de la semana ----
  await a.click('[data-a=go][data-v=reportes]'); await a.click('[data-a=go][data-tab=semana]'); await a.waitForTimeout(800);
  await a.click('[data-a=go][data-tab=semana]'); await a.waitForTimeout(300);
  const sem = await texto(a);
  ok(sem.includes('$54.000') && sem.includes('Hamburguesas $37.000') && sem.includes('Arepas $14.000') && sem.includes('Domicilio $3.000'), 'Semana: ventas del día y por categoría (Hamburguesas $22.000 · Arepas $14.000 · Domicilio $3.000)');
  ok(sem.includes('Queso mozzarella') && sem.includes('+3'), 'Semana: compras y gasto de cocina por día');
  ok(sem.includes('Dinero en las cuentas en la semana'), 'Semana: dinero al abrir y al cerrar');
  await a.click('[data-a=go][data-tab=turnos]'); await a.click('.list-item'); await a.waitForTimeout(300);
  const tv = await texto(a, '.modal');
  ok(tv.includes('Quedó al cierre') && tv.includes('Dinero en caja y cuentas') && tv.includes('Bebidas (a costo)'), 'El turno muestra el dinero y el inventario que quedaron');
  ok(tv.includes('Cocina: Se dañó una tubería') && tv.includes('Preparar al día siguiente: Salsa de pizza'), 'El turno muestra la observación de cocina y lo que hay que preparar');
  await a.click('.modal [data-a=cerrarModal]');
  await a.click('[data-a=go][data-tab=mes]'); await a.waitForTimeout(300);
  ok((await texto(a)).includes('Venta promedio por día y categoría'), 'Mes: promedio por día de la semana y categoría');

  const errs = [a, e, m, c].flatMap((p) => p.errs);
  ok(!errs.length, errs.length ? 'ERRORES: ' + errs.join(' | ') : 'Sin errores de JavaScript');
  await b.close();
})().catch((e) => { console.error('FALLÓ:', e.message.split('\n')[0]); process.exit(1); });
