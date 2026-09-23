// Fase 3, parte 4: pedidos en el servidor con varias meseras a la vez, cocina en vivo e impresión en el PC de caja
const { chromium } = require('playwright'); // instalado aparte (no es dependencia del proyecto)
const BASE = process.env.BASE || 'http://localhost:8770/';
const ok = (c, m) => { console.log(c ? '✅' : '❌', m); if (!c) process.exitCode = 1; };
(async () => {
  const b = await chromium.launch();
  const nuevo = async (tz = 'America/Bogota', celular = false) => {
    const ctx = await b.newContext({ timezoneId: tz, locale: 'es-CO', viewport: celular ? { width: 390, height: 844 } : { width: 1200, height: 900 } });
    const p = await ctx.newPage();
    ctx.on('page', (x) => { if (x !== p) x.close().catch(() => {}); });
    p.errs = []; p.on('pageerror', (e) => p.errs.push(e.message)); p.on('dialog', (d) => d.accept());
    return p;
  };
  const toast = async (p) => { await p.waitForTimeout(500); return (await p.textContent('#toast')).trim(); };
  const entrar = async (p, u, c) => {
    await p.goto(BASE); await p.waitForSelector('form[data-submit=login]');
    await p.fill('input[name=codigo]', 'loschamos'); await p.fill('input[name=usuario]', u); await p.fill('input[name=clave]', c);
    await p.click('form[data-submit=login] button'); await p.waitForSelector('#nav .nav-i'); await p.waitForTimeout(300);
  };
  const texto = async (p, sel = '#main') => (await p.textContent(sel)).replace(/\s+/g, ' ');

  // ---- Administrador: personal y menú ----
  const a = await nuevo();
  await entrar(a, 'alirio', 'clave-admin-1');
  await a.evaluate(async () => {
    for (const [nombre, usuario, rol] of [['Encargada Ana', 'ana', 'encargada'], ['Pedro Cocina', 'pedro', 'cocina'], ['María Mesera', 'maria', 'mesera'], ['Lucía Mesera', 'lucia', 'mesera']])
      await LC.api('usuarios', { method: 'POST', body: { nombre, usuario, clave: '1234', rol } });
    await LC.subirCatalogo();
  });

  // ---- Encargada abre la caja en el PC de caja y lo marca como estación de impresión ----
  const e = await nuevo('Europe/Madrid');
  await entrar(e, 'ana', '1234');
  await e.click('[data-a=go][data-v=apertura]');
  const idPedro = await e.evaluate(() => LC.equipo.find((u) => u.nombre === 'Pedro Cocina').id);
  await e.selectOption('select[name=p_' + idPedro + ']', 'Cocina');
  await e.click('form[data-submit=apPersonal] button.primary');
  for (let i = 0; i < 2; i++) { await e.waitForSelector('form[data-submit=apConteo]'); for (const x of await e.$$('form[data-submit=apConteo] input[type=number]')) await x.fill(i ? '5' : '10'); await e.click('form[data-submit=apConteo] button.primary'); await e.waitForTimeout(200); }
  await e.fill('input[name="s_Efectivo"]', '100000');
  for (const c of ['Nequi', 'Bancolombia', 'Datáfono']) await e.fill('input[name="s_' + c + '"]', '0');
  await e.click('form[data-submit=apSaldos] button.primary');
  await e.fill('textarea[name=nota]', 'Base de la caja');
  await e.click('form[data-submit=apConfirmar] button.primary'); await e.waitForSelector('.hero-turno.abierto');
  // La impresora de verdad no existe en la prueba: se guarda lo que se habría impreso
  await e.evaluate(() => { window.__impresos = []; LC.imprimir = async (html) => { window.__impresos.push(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')); }; });
  await e.click('[data-a=go][data-v=caja]');
  await e.check('[data-ch=estacionCambiar]');
  ok((await toast(e)).includes('Este equipo imprime'), 'La encargada activa "Imprimir en este equipo" en el PC de caja');
  const impresos = () => e.evaluate(() => window.__impresos.slice());

  // ---- María (celular con otra zona horaria) toma la mesa 3 ----
  const m = await nuevo('UTC', true);
  await entrar(m, 'maria', '1234');
  await m.click('[data-a=mesaAbrir][data-m="3"]');
  const premium = await m.evaluate(() => LC.db.pizza.tipos.find((t) => t.nombre === 'Pizza premium').id);
  await m.click('[data-a=pizzaNueva][data-t="' + premium + '"]');
  for (const s of ['Pepperoni', 'Tocineta', 'Chorizo']) await m.check('input[name=sabor][value="' + s + '"]');
  await m.click('.pizza-form button.primary');
  await m.click('[data-a=posCat][data-c=Bebidas]');
  await m.click('[data-a=addBebida] >> text=Coca-Cola 400 ml'); await m.click('[data-a=addBebida] >> text=Coca-Cola 400 ml'); await m.click('[data-a=addBebida] >> text=Cerveza Águila');
  ok((await texto(m, '.cuenta')).includes('Por enviar') && (await texto(m, '.total-row')).includes('$62.000'), 'María arma el pedido en su celular: queda "Por enviar", total $62.000');
  ok((await e.evaluate(() => LC.db.ordenes.length)) === 0, 'Mientras no lo envía, la caja no ve nada');
  await m.click('[data-a=comandaEnviar]');
  ok((await toast(m)) === 'Comanda #1 enviada a cocina, se imprime en caja', 'María envía: "' + (await m.textContent('#toast')).trim() + '"');

  // ---- Lucía, en otro celular, ve la mesa 3 y le suma unos tequeños ----
  const l = await nuevo('America/Bogota', true);
  await entrar(l, 'lucia', '1234');
  ok((await texto(l, '.mesa.ocupada')).includes('$62.000'), 'Lucía ve la mesa 3 ocupada con $62.000 (la tomó María en otro celular)');
  await l.click('.mesa.ocupada');
  await l.click('[data-a=posCat][data-c=Entradas]'); await l.click('[data-a=addProd] >> text=Tequeños x6');
  await l.click('[data-a=comandaEnviar]');
  ok((await toast(l)).startsWith('Comanda #2'), 'Lucía suma tequeños a la misma cuenta: comanda #2');

  // ---- Las dos abren la mesa 5 al mismo tiempo, sin saber de la otra ----
  await m.click('[data-a=go][data-v=pos]'); await l.click('[data-a=go][data-v=pos]');
  await m.click('[data-a=mesaAbrir][data-m="5"]'); await l.click('[data-a=mesaAbrir][data-m="5"]');
  await m.click('[data-a=posCat][data-c=Bebidas]'); await l.click('[data-a=posCat][data-c=Bebidas]');
  await m.click('[data-a=addBebida] >> text=Agua 600 ml'); await l.click('[data-a=addBebida] >> text=Malta');
  await m.click('[data-a=comandaEnviar]'); await l.click('[data-a=comandaEnviar]');
  ok((await toast(l)) === 'Pedido guardado', 'Solo bebidas: se guarda sin comanda');
  const mesa5 = await e.evaluate(async () => { await LC.cargarPedidos(); return LC.db.ordenes.filter((o) => o.mesa === 5).map((o) => o.lineas.map((x) => x.nombre)); });
  ok(mesa5.length === 1 && mesa5[0].length === 2, 'Mesa 5 abierta a la vez por dos meseras: queda UNA cuenta con lo de las dos ' + JSON.stringify(mesa5));

  // ---- El PC de caja imprime las comandas solo, en unos segundos ----
  await e.waitForTimeout(4500);
  let imp = await impresos();
  ok(imp.length === 2 && imp[0].includes('COMANDA #1') && imp[0].includes('Mesa 3') && imp[0].includes('Pepperoni') && imp[1].includes('COMANDA #2') && imp[1].includes('Tequeños'), 'El PC de caja imprimió solo las 2 comandas (sin tocar nada)');
  ok(!imp[0].includes('Coca-Cola'), 'La comanda no lleva las bebidas');

  // ---- Cocina ve las comandas en vivo ----
  const c = await nuevo();
  await entrar(c, 'pedro', '1234');
  ok((await c.$$('.kds .ticket')).length === 2, 'Cocina ve las 2 comandas');
  await c.click('.kds .ticket >> nth=0 >> [data-a=kdsEstado]'); await c.waitForTimeout(400);
  await c.click('.kds .ticket >> nth=0 >> [data-a=kdsEstado][data-e=entregado]'); await c.waitForTimeout(400);
  ok((await c.$$('.kds .ticket')).length === 1, 'Cocina marca la comanda #1 lista y entregada');
  await l.click('[data-a=go][data-v=pos]'); await l.click('.mesa.ocupada:has-text("5")');
  await l.click('[data-a=posCat][data-c=Entradas]'); await l.click('[data-a=addProd] >> text=Papas a la francesa');
  await l.click('[data-a=comandaEnviar]'); await l.waitForTimeout(300);
  await c.waitForTimeout(4500);
  ok((await texto(c, '.kds')).includes('Papas a la francesa'), 'Una comanda nueva aparece sola en la pantalla de cocina (en ~4 s)');

  // ---- María pide la pre-cuenta desde su celular: sale en caja ----
  await m.click('[data-a=go][data-v=pos]'); await m.click('.mesa.ocupada >> nth=0');
  await m.click('[data-a=precuenta]');
  ok((await toast(m)) === 'La pre-cuenta se imprime en caja', 'María pide la pre-cuenta: "La pre-cuenta se imprime en caja"');
  await e.waitForTimeout(4500);
  imp = await impresos();
  ok(imp.some((x) => x.includes('PRE-CUENTA') && x.includes('Mesa 3') && x.includes('$77.000')), 'La pre-cuenta de $77.000 salió en el PC de caja');
  ok(!(await m.$('.cuenta [data-a=lineaQuitar]')) && !(await m.$('.cuenta [data-a=lineaAnular]')), 'Lo de la pre-cuenta ya no lo puede quitar la mesera (ni anular: no tiene permiso)');
  // Algo agregado después de la pre-cuenta sí se corrige
  await m.click('[data-a=posCat][data-c=Bebidas]'); await m.click('[data-a=addBebida] >> text=Cerveza Águila');
  ok((await texto(m, '.cuenta')).includes('Después de la pre-cuenta'), 'Lo nuevo aparece como "Después de la pre-cuenta"');
  await m.click('[data-a=comandaEnviar]'); await m.click('.mesa.ocupada >> nth=0');
  ok((await m.$$('.cuenta [data-a=lineaQuitar]')).length === 1, 'La cerveza agregada después de la pre-cuenta se puede quitar');
  await m.click('.cuenta [data-a=lineaQuitar]'); await m.waitForTimeout(400);
  ok((await texto(m, '.total-row')).includes('$77.000'), 'María la quita y la cuenta vuelve a $77.000');

  // ---- La encargada anula la cerveza (con motivo) y cobra dividido ----
  await e.click('[data-a=go][data-v=pos]'); await e.click('.mesa.ocupada >> nth=0');
  await e.click('.linea:has-text("Cerveza Águila") [data-a=lineaAnular]');
  await e.fill('.modal input[name=motivo]', 'Se la cambiaron por agua');
  await e.click('.modal button.danger'); await e.waitForTimeout(400);
  ok((await texto(e, '.total-row')).includes('$73.000'), 'Cerveza anulada con motivo: la cuenta queda en $73.000');
  await e.click('[data-a=cobrar]');
  await e.fill('input[name=p_Nequi]', '36500'); await e.click('[data-a=cobroResto][data-c=Efectivo]'); await e.fill('input[name=recibido]', '50000');
  await e.click('.cobro-form button.ok'); await e.waitForSelector('.mesas');
  ok((await toast(e)).includes('Cambio: $13.500'), 'Cobro dividido Nequi + efectivo: "' + (await e.textContent('#toast')).trim() + '"');
  await e.waitForTimeout(1000);
  imp = await impresos();
  ok(imp.some((x) => x.includes('RECIBO DE PAGO') && x.includes('Nequi') && x.includes('$13.500')), 'El recibo con los pagos y el cambio salió enseguida en el PC de caja');
  await e.click('.mesa.ocupada:has-text("5")'); await e.click('[data-a=cobrar]');
  await e.click('[data-a=cobroTodo][data-c=Datáfono]'); await e.click('.cobro-form button.ok'); await e.waitForSelector('.mesas');
  ok((await e.$$('.mesa.ocupada')).length === 0, 'Mesa 5 (agua, malta y papas) cobrada con datáfono: el salón queda libre');
  await m.waitForTimeout(100);
  await m.click('[data-a=go][data-v=pos]'); await m.waitForTimeout(500);
  ok((await m.$$('.mesa.ocupada')).length === 0, 'En el celular de María también se ven libres');

  // ---- Reimprimir desde Caja ----
  await e.click('[data-a=go][data-v=caja]'); await e.click('[data-a=impresionesVer]'); await e.waitForSelector('.modal .list');
  const n = (await impresos()).length;
  await e.click('.modal [data-a=reimprimir] >> nth=0'); await e.waitForTimeout(500);
  ok((await impresos()).length === n + 1, 'La encargada reimprime desde Caja → "Ver impresiones y reimprimir"');
  await e.click('.modal [data-a=cerrarModal]');

  // ---- Cierre de caja: lo vendido sale de las cuentas del servidor ----
  await e.click('[data-a=go][data-v=cierre]');
  for (let i = 0; i < 2; i++) {
    await e.waitForSelector('form[data-submit=ciConteo]');
    for (const x of await e.$$('form[data-submit=ciConteo] label.row-count')) {
      const t = await x.textContent();
      await (await x.$('input')).fill(i ? '5' : t.includes('Coca-Cola 400') ? '8' : t.includes('Agua 600') || t.includes('Malta') ? '9' : '10');
    }
    await e.click('form[data-submit=ciConteo] button.primary'); await e.waitForTimeout(200);
  }
  const saldos = await e.evaluate(() => LC.db.saldos);
  ok(saldos.Efectivo === 136500 && saldos.Nequi === 36500 && saldos['Datáfono'] === 13500, 'Saldos del libro: ' + JSON.stringify(saldos));
  for (const k of Object.keys(saldos)) await e.fill('input[name="s_' + k + '"]', String(saldos[k]));
  await e.click('form[data-submit=ciSaldos] button.primary');
  ok(!(await e.$('form[data-submit=ciConfirmar] .notice.bad')), 'Todo cuadra: dinero y bebidas (las cobradas coinciden con el conteo)');
  await e.click('form[data-submit=ciConfirmar] button.primary'); await e.waitForSelector('.hero-turno');
  ok((await toast(e)).includes('Falta el inventario de cocina'), 'Caja cerrada');

  await c.click('[data-a=go][data-v=cocina]'); await c.click('[data-a=go][data-v=cocinaCierre]');
  for (const x of await c.$$('form[data-submit=coConteo] label.row-count')) await (await x.$('input')).fill('0');
  await c.click('form[data-submit=coConteo] button.primary');
  await c.click('form[data-submit=coConfirmar] button.primary'); await c.waitForTimeout(800);
  ok((await c.textContent('#toast')).includes('Turno terminado'), 'Cocina cierra de último');

  const r = await a.evaluate(async () => { await LC.cargarTurno(); const t = LC.db.turnos.find((x) => x.estado === 'cerrado'); return t && t.resumen; });
  ok(r.ventas === 86500 && r.ordenesPagadas === 2 && r.anulaciones === 1 && r.porCategoria.Pizzas === 50000 && r.porCategoria.Entradas === 22000,
    'Resumen del día (servidor): ventas ' + r.ventas + ', cuentas ' + r.ordenesPagadas + ', anulaciones ' + r.anulaciones + ', ' + JSON.stringify(r.porCategoria));
  await a.click('[data-a=go][data-v=reportes]'); await a.click('[data-a=go][data-tab=auditoria]'); await a.waitForTimeout(800);
  const aud = await texto(a);
  ok(aud.includes('Producto anulado') && aud.includes('Se la cambiaron por agua') && aud.includes('Pre-cuenta impresa'), 'Auditoría: la anulación con su motivo y la pre-cuenta');

  const errs = [a, e, m, l, c].flatMap((p) => p.errs);
  ok(!errs.length, errs.length ? 'ERRORES: ' + errs.join(' | ') : 'Sin errores de JavaScript');
  await b.close();
})().catch((e) => { console.error('FALLÓ:', e.message.split('\n')[0]); process.exit(1); });
