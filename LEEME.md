# Los Chamos POS · versión 2

Punto de venta, control de turno, inventario y finanzas para restaurante de comida rápida.

## Archivos

| Archivo | Qué hace |
|---|---|
| `public/index.html` | Estructura de la app. Es el que se abre. |
| `public/store.js` | Datos: cuentas, catálogo, inventario, libro contable, cálculos del turno. Única puerta a los datos (en la fase 2 se cambia por la API sin tocar lo demás). |
| `public/app.js` | Núcleo: ingreso, permisos, navegación, impresión, WhatsApp, Ajustes y usuarios. |
| `public/turno.js` | Apertura de caja, gastos, llegada de mercancía, inventario de cocina y cierre. |
| `public/pos.js` | Mesas, domicilios, pedidos, pizzas, comandas, pre-cuenta, cobro y pantalla de cocina. |
| `public/reportes.js` | Saldos por cuenta, historial de turnos, resumen del mes, movimientos y auditoría. |
| `public/styles.css` | Diseño. |
| `db/` | Base de datos para Neon (fase 2): migraciones, clave de `app_user`, semilla de Los Chamos y pruebas de seguridad. No lo usa la app todavía. |

Los 7 archivos de la app viven juntos en la carpeta `public/` (es la carpeta que Vercel publica). Las reglas del proyecto para trabajar con Claude están en `CLAUDE.md`.

## Primer uso

1. Abre `public/index.html`. Como no hay usuarios, te pide crear el **administrador** (tú).
2. En **Ajustes** revisa: Menú y precios, Pizzas (precios por tamaño, valor del sabor adicional, sabores), Bebidas, Utensilios e Insumos (costo unitario y **stock sugerido**), Negocio (WhatsApp, número de mesas, ancho del ticket 58/80 mm).
3. En **Ajustes → Usuarios** crea a la encargada, meseras y cocina con usuario y contraseña. El rol pone permisos por defecto y puedes marcar o quitar permisos uno por uno.

Los datos de la versión anterior (bebidas, utensilios, insumos) se importan solos. Los usuarios viejos no, porque tenían claves de 4 dígitos sin protección.

## Flujo del día

**4 p. m. Apertura (encargada).** Asistente obligatorio: quién trabaja y en qué área (debe haber alguien en cocina) → conteo de bebidas → conteo de utensilios → arqueo de Efectivo, Nequi, Bancolombia y Datáfono → revisión. Si algo no cuadra con lo que dice el sistema, pide explicación. Al abrir envía el reporte por WhatsApp.

**Pedidos (mesera / encargada).** Mesa → productos por categoría → pizzas con tamaño y sabores (el precio se calcula solo) → **Enviar a cocina** (solo imprime lo nuevo, con número de comanda y hora) → el cliente puede pedir más → **Pre-cuenta** → **Cobrar** con uno o varios medios de pago; en efectivo escribes lo que entrega y muestra el cambio → la mesa queda libre.

**Cocina.** Pantalla de comandas (pendiente → listo → entregado, con alerta por tiempo). Registra lo que llega en peso o cantidad. Al final hace el inventario de cierre: la app calcula lo gastado (abrió + llegó − queda), su costo y la lista de compras, y la envía por WhatsApp.

**Caja durante el turno.** Gastos e ingresos siempre indicando de qué cuenta salió o a cuál entró. "Llegó mercancía" sube el stock, actualiza el costo y, si se pagó, registra el gasto. Traslados entre cuentas (ej. consignar efectivo).

**Cierre (encargada).** No deja cerrar con cuentas abiertas. Conteo de bebidas y utensilios → arqueo → resumen: ventas por medio de pago, lo que debería haber vs. lo contado, bebidas vendidas por conteo vs. registradas en el POS (⚠️ si no coinciden), utilidad estimada y lista de compras. Si hay diferencias exige observación. Envía todo por WhatsApp.

## Cómo evita fugas

- Cada peso que se mueve queda en un **libro contable** por cuenta. El saldo "debería haber" sale del libro, no de lo que alguien escriba.
- Los conteos son **ciegos**: quien cuenta no ve lo esperado; la diferencia aparece después y queda registrada.
- Bebidas: lo que falta según el conteo se compara con lo que se cobró en el POS.
- Nada se borra: quitar productos ya enviados a cocina exige permiso de anular y motivo. Ajustes de stock también piden motivo. Todo queda en **Auditoría**.
- **Utilidad estimada** = ventas − costo de lo consumido (bebidas, insumos, utensilios) − gastos operativos. Las compras de inventario no se restan dos veces: se restan cuando se consumen.

## Errores que tenía la versión anterior

1. `index.html` y `app.js` no coincidían: el código buscaba pantallas que no existían y se detenía al cargar, así que encargada y cocina no funcionaban.
2. Había dos listas de usuarios con claves distintas; los usuarios creados en la app no podían entrar.
3. Las ventas del POS se guardaban en un objeto que nunca se grababa: no llegaban a finanzas.
4. Mesas abiertas, apertura, gastos y llegadas vivían solo en memoria: al recargar se perdían y el cierre quedaba en cero.
5. Ingreso calculado como saldo final − base, sin restar gastos: resultados falsos y doble conteo.
6. Cobro de domicilios siempre en efectivo, sin pago dividido ni cambio; el botón de ticket de domicilio fallaba.
7. Cada envío a cocina reimprimía toda la comanda.
8. Impresión por ventana emergente (la bloquean los navegadores).
9. Fechas en hora UTC: después de las 7 p. m. los movimientos caían en el día siguiente.
10. Claves en texto plano; textos sin escapar (un nombre con comillas rompía la pantalla).
11. El reporte semanal omitía el martes y `styles.css` no estaba enlazado.

## Limitaciones de esta fase

- **Los datos viven en el navegador de un solo equipo.** Si la mesera usa su celular y la caja un computador, no se ven entre sí. Es la razón principal para pasar a Neon.
- Descarga un respaldo cada semana (Ajustes → Datos).
- WhatsApp se abre con el mensaje listo y hay que tocar "Enviar".
- Las contraseñas usan SHA-256 con sal cuando la app se abre desde `https://` o `localhost`. Abriendo el archivo directo funciona igual, pero si luego cambias de modo hay que volver a crear las claves. Desde la fase 2 las claves se validan en el servidor.

## Fase 2: SaaS multitenant con Neon

```
Celulares / PC (esta app)  ──HTTPS──>  API (Vercel o Netlify Functions, Node)  ──>  Neon Postgres
```

El navegador **nunca** se conecta directo a Neon: la cadena de conexión daría acceso total a la base de todos los negocios.

1. **Neon:** proyecto en AWS US East 1. Se ejecutan en orden `db/migrations/001_esquema.sql`, `002_app_user.sql`, `db/clave_app_user.sql` y `db/semillas/loschamos.sql`. La API usa la cadena de conexión de `app_user`, solo como variable de entorno (`DATABASE_URL`).
2. **API:** endpoints `/auth/login`, `/shifts`, `/orders`, `/payments`, `/inventory`, `/ledger`, `/reports`. Claves con bcrypt, sesión con cookie httpOnly. Los permisos se revisan **en el servidor** en cada llamada.
3. **Multitenant:** cada negocio tiene su `tenant_id`; la API hace `SET LOCAL app.tenant_id` por petición y Row Level Security impide ver datos de otro negocio. Se ingresa con **código de negocio** (`loschamos`) + usuario + contraseña.
4. **Frontend:** se reemplazan las funciones de `store.js` (`load`, `save`, `mov`…) por llamadas a la API. El resto de la app no cambia.
5. **Tiempo real:** comandas nuevas en la pantalla de cocina y mesas actualizadas en todos los equipos (consulta cada pocos segundos al inicio; luego WebSockets o Server-Sent Events).
6. **WhatsApp automático:** WhatsApp Business Cloud API (Meta) con plantillas aprobadas, o Twilio. El cierre se envía solo sin tocar nada.
7. **Opcional:** facturación electrónica DIAN a través de un proveedor autorizado, impresora térmica por red, modo sin internet con cola de sincronización.
