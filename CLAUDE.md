# Los Chamos POS · Reglas del proyecto

Punto de venta, control de turno, inventario y finanzas para Los Chamos, restaurante de comida rápida en Valledupar, Colombia. El dueño está aprendiendo a programar: explica cada cambio en palabras simples y en español.

## Objetivo

Convertir la app en un **SaaS multitenant** para que el celular de la mesera, la pantalla de cocina y la caja compartan los mismos datos en tiempo real, y para que otros negocios puedan usarla.

```
Navegador (public/)  ──HTTPS──>  API serverless en Vercel (/api, Node + TypeScript)  ──>  Neon Postgres
```

## Estado actual

- `public/`: la app. HTML, CSS y JavaScript puro, sin compilar. Se conecta a la API por partes (fase 3):
  - **Parte 1 hecha:** ingreso (código de negocio + usuario + clave) y usuarios (Ajustes → Usuarios) van al servidor con `LC.api()`. La sesión la da `/api/auth/yo` al cargar; `LC.equipo` (de `/api/equipo`) es el personal para la apertura. `LC.db.usuarios` ya no se usa.
  - **Parte 2 hecha:** menú, pizzas, bebidas/utensilios/insumos y datos del negocio viven en el servidor. `LC.cargarCatalogo()` (al ingresar y al entrar a Pedidos o Ajustes) los copia en `LC.db` con la misma forma de antes; Ajustes guarda con `/api/catalogo/*`. La primera vez, Ajustes ofrece **subir el menú del equipo** (`LC.subirCatalogo()` → `/api/catalogo/importar`, solo si el servidor está vacío) y re-mapea los ids locales a los del servidor.
  - **Parte 3 hecha:** turno, caja, libro contable, stock, conteos, llegadas y ajustes viven en el servidor (`/api/turno/*`). `LC.cargarTurno()` (al ingresar, al navegar y cada 30 s) copia el estado en `LC.db.turnos/movimientos/entradas/saldos`; `LC.accionTurno(accion, body)` hace cada cambio. `LC.turno()` = caja abierta; `LC.turnoCocina()` = turno sin terminar (incluye "esperando cocina"). El resumen del día lo calcula el servidor (`api/_lib/turno.ts → calcularResumen`, igual a `LC.resumenTurno`).
  - **Parte 4 hecha:** pedidos, comandas, anulaciones, cobro e impresión viven en el servidor (`/api/pedidos`, `/api/impresion`). Lo que la mesera agrega queda como **borrador en su celular** (`LC.db.borradores`, "Por enviar") y se envía todo junto con `LC.enviarPedido(o)` (con un `lote` al azar para no duplicar si reintenta). `LC.cargarPedidos()` trae solo lo que cambió (`?desde=`) y `LC.armarPedidos()` arma `LC.db.ordenes` = cuentas del servidor + borradores, con la misma forma de antes. Los demás cambios van por `LC.accionPedido(accion, body)`. El servidor pone los precios del menú (nunca los del celular), numera órdenes y comandas, y calcula lo vendido del resumen desde las cuentas cobradas (`ventasDelTurno`; `ventasPOS` solo existe en turnos viejos). `/api/turno/venta` se eliminó: todo cobro va unido a su cuenta (`payments`).
  - **Impresión:** todo va a la cola `print_jobs`; el PC de caja con "Imprimir en este equipo" (Caja → Impresora, `localStorage lc2_estacion`) la revisa cada 4 s (`LC.revisarImpresion`) y la imprime con `LC.ticketDe(trabajo)`. Actualización automática: cocina y estación cada 4 s, pedidos cada 16 s, turno cada 60 s, solo con la app visible.
  - **Mejoras del dueño (migración 005):** cocina abre el turno desde las 2 p. m. (`/api/turno/abrir-cocina`, `shifts.caja_abierta_en`; `LC.soloCocina()`), la encargada abre la caja en ese mismo turno; se vende solo con caja abierta (`exigirCajaAbierta`), las llegadas solo piden turno activo (`exigirTurnoActivo`). Llegada = factura con varios artículos (`items`); de qué cuenta se pagó solo lo dice quien tiene `caja.movimientos`. Nota general en la comanda (`kitchen_tickets.nota`). Al cobrar o liberar, las comandas salen de cocina (`entregarComandas`). Domicilio exige cómo paga el cliente (`orders.pago_cliente`) y el envío se resta solo del Efectivo al cobrar (gasto `Domiciliario`). Extras por categoría (`categories.extras`, `/api/catalogo/categorias`). Preparaciones con materiales (`tenants.config.preparaciones`, `/api/catalogo/preparaciones`): cocina las marca al cerrar y suman a `comprar`. Almacén del dueño (`warehouse_moves`, solo se agregan filas; `/api/almacen`, permiso `almacen.gestionar`; pantalla `public/almacen.js`); la salida entra al turno como `inventory_entries.motivo = 'almacen'` y el resumen dice cuánto sacar del almacén (`almacen`, `sacar`). Reportes → Semana (martes a lunes) y Mes con categoría por día. Ya no se usa WhatsApp: apertura (`avisarApertura`), cierre de caja y reporte final van por Telegram y correo; el final trae preparaciones, compras con almacén, avalúo del almacén y la semana.
  - Pendiente: importar respaldo y limpiar datos de prueba (parte 5).
- `public/store.js` es la **única puerta a los datos**; `LC.api(ruta, {method, body})` es la única forma de llamar al servidor (si responde 401, vuelve al ingreso). Al conectar la API se reemplazan sus funciones (`load`, `save`, `mov`…) por llamadas HTTP; las pantallas (`app.js`, `turno.js`, `pos.js`, `reportes.js`) no deberían tener que reescribirse.
- `db/migrations/`: esquema de Neon en archivos numerados (`001_…`, `002_…`). Nunca se edita una migración ya aplicada en Neon: los cambios van en un archivo nuevo, que también da sus permisos a `app_user`.
- `db/pruebas/probar.sh`: aplica las migraciones en un Postgres **local** y prueba el aislamiento entre negocios y que el dinero no se pueda editar. Correrlo después de cualquier cambio en `db/`.
- `api/`: API en Vercel (TypeScript). **Hay UNA sola función publicada: `api/index.ts`** (el plan Hobby permite máximo 12 funciones y con una por ruta ya nos pasamos una vez). `vercel.json` manda `/api/<ruta>` a `/api/index?ruta=<ruta>` y `api/index.ts` la reparte según su tabla `RUTAS`.
  - Cada ruta vive en `api/_rutas/` (ej. `api/_rutas/usuarios.ts` atiende `/api/usuarios`) y exporta `GET`, `POST`, `PATCH`, `DELETE` con la firma web (`Request` → `Response`). **Ruta nueva = archivo en `api/_rutas/` + una línea en `RUTAS`.** Nunca crear archivos `.ts` publicados fuera de `api/index.ts`: la prueba `pruebas/rutas.test.ts` lo impide.
  - Lo compartido va en `api/_lib/` (Vercel no publica lo que empieza con `_`):
  - `db.ts`: conexión con `pg` y `conNegocio(tenantId, fn)`, que abre transacción y fija el negocio.
  - `auth.ts`: contraseñas (bcryptjs), sesiones, `conUsuario(req, permiso, fn)` y `auditar()`. **Toda ruta protegida entra por `conUsuario`**, y revisa el permiso antes de validar datos o cifrar claves.
  - `http.ts`: `ruta()`, `leerJson()` (exige JSON, protege de CSRF), `texto()`, `pesos()` (solo enteros).
- `public/instalar.html`: pantalla de un solo uso para crear el primer administrador (usa `/api/auth/instalar`).
- Rutas hechas: `/api/almacen`, `/api/catalogo/categorias` (extras), `/api/catalogo/preparaciones`, `/api/turno/abrir-cocina`, `/api/pedidos` (GET cuentas del turno; POST `enviar`, `quitar`, `anular`, `mover`, `liberar`, `precuenta`, `domicilio`, `cobrar`, `comanda`, cada una con su permiso), `/api/impresion` (cola del PC de caja, permiso `pos.cobrar`), `/api/avisos` (configurar Telegram y correo del dueño, permiso `reportes.ver`), `/api/turno` (estado; el dinero solo a quien maneja caja o reportes), `/api/turno/{abrir,movimiento,traslado,llegada,ajuste,cerrar-caja,cerrar-cocina,terminar-sin-cocina}`, `/api/auditoria` (permiso `reportes.ver`), `/api/catalogo` (GET, cualquier usuario), `/api/catalogo/{productos,pizzas,inventario,negocio,importar}` (permiso `catalogo.editar`), `/api/equipo` (nombres del personal, permiso `turno.operar`), `/api/salud`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/yo`, `/api/auth/instalar` (primer admin, exige `CLAVE_INSTALACION`), `/api/usuarios`.
- Pruebas: `PGHOST=… PGPORT=… npm run probar` corre las pruebas de la base y de la API (`pruebas/*.test.ts`, una a la vez) en un Postgres local. Cada archivo de pruebas usa su propio negocio (`chamos-c` catálogo, `chamos-d` turno, `chamos-e` avisos, `chamos-f` pedidos). `npm run revisar` revisa TypeScript.
- Dependencias aprobadas: `pg` (conexión a Neon, la misma en pruebas locales), `bcryptjs`, `typescript`, `@types/*`. Nada más sin preguntar.
- Variables de entorno en Vercel: `DATABASE_URL` (cadena de `app_user`, con `-pooler` y `sslmode=require`), `CLAVE_INSTALACION` (frase del dueño, mínimo 12 caracteres), `TELEGRAM_BOT_TOKEN` (bot de @BotFather) y `RESEND_API_KEY` (resend.com; opcional `RESEND_FROM`). En pruebas, `TELEGRAM_API_URL` y `RESEND_API_URL` apuntan a servidores falsos locales (`pruebas/avisos.test.ts`): nunca se escribe a Telegram ni se envían correos reales en pruebas.
- `LEEME.md`: manual de uso del negocio (flujo del día, cómo evita fugas).
- Lee `LEEME.md`, `db/migrations/` y los `.js` que vayas a tocar antes de cambiar algo.

## Reglas de arquitectura y seguridad (obligatorias)

1. **El navegador nunca se conecta directo a Neon.** Solo la API habla con la base de datos.
2. **Secretos solo en variables de entorno** (`DATABASE_URL` y demás, en Vercel o en `.env.local`). Nunca en el código, en `public/`, en commits, en logs ni en mensajes. `.env*` va en `.gitignore`.
3. **Cada negocio aislado con `tenant_id` y Row Level Security.** En cada petición la API hace `SET LOCAL app.tenant_id = '<uuid>'` dentro de una transacción. La API se conecta con el rol `app_user` (sin permisos de owner, así no se salta RLS). El `tenant_id` sale de la sesión del usuario en el servidor, nunca de lo que mande el navegador.
4. **Permisos verificados en el servidor en cada llamada.** Lo que el frontend oculte o muestre es solo comodidad; la API vuelve a revisar el permiso (`pos.cobrar`, `turno.operar`, etc.). Contraseñas con bcrypt o argon2 en la API; sesión con cookie `httpOnly`, `Secure`, `SameSite`.
5. **El dinero se maneja con un libro contable que no se edita ni se borra** (`ledger_entries`). El saldo de cada cuenta es la suma del libro, nunca un número guardado aparte. Un error se corrige con un movimiento nuevo de ajuste o reverso, con motivo y usuario. Lo mismo para `payments` y `audit_log`: a `app_user` se le quitan `UPDATE` y `DELETE` en esas tablas.
6. Dinero en **pesos enteros** (`bigint`), nunca con decimales ni `float`. Postgres redondea en silencio un `1000.5` a `1001`, así que **la API rechaza cualquier monto que no sea entero** (`Number.isSafeInteger`).
7. Toda acción sensible (anulaciones, ajustes de stock, cambios de precio, descuadres) queda en auditoría con usuario y motivo.

## Idioma, formatos y fechas

- Interfaz, mensajes de error, reportes y WhatsApp en **español de Colombia**.
- Pesos sin decimales y con punto de miles: `$50.000` (usar `LC.fmt`).
- Fechas y horas siempre en **hora de Colombia** (`America/Bogota`, UTC−5, sin horario de verano), aunque el equipo o el servidor tengan otra zona. En el frontend usar `LC.hora`, `LC.fecha`, `LC.fechaLarga`, `LC.fechaHora`, `LC.diaLocal`, `LC.diaSemana`. En la base, guardar `timestamptz` y convertir con `AT TIME ZONE 'America/Bogota'`.
- **El turno empieza a las 4 p. m. y puede pasar de medianoche.** Un turno pertenece al día en que se abrió (día comercial), no al día en que ocurre cada venta. Los reportes por día o por mes agrupan por el turno, no por la fecha de cada movimiento.

## Forma de trabajar

- **No cambiar el diseño visual** salvo lo necesario para la tarea.
- **No agregar dependencias innecesarias.** El frontend sigue sin framework ni paso de compilación. En la API, solo lo indispensable (por ejemplo el driver de Neon y una librería de hash de contraseñas) y explicando por qué.
- **Preguntar antes de decisiones importantes**: estructura de datos, dependencias nuevas, cambios de flujo del negocio, cosas que borren o migren datos, costos de servicios.
- Cambios pequeños y que se puedan revisar. Explicar qué se hizo y por qué, en palabras simples.
- Probar en navegador real (Playwright) el flujo principal después de cambios en `public/`: apertura de caja → pedido de mesa con pizza y bebidas → comanda → cobro dividido (Nequi + efectivo) → cierre. Usar `timezoneId: 'America/Bogota'` y también una zona distinta para detectar errores de hora.
- Nunca subir datos reales del negocio (respaldos `.json`, clientes, ventas) al repositorio.

## Decisiones ya tomadas por el dueño

- **Pre-cuenta:** lo que salió en la pre-cuenta impresa solo se quita anulando (permiso `pos.anular` y motivo). Lo agregado después y aún no enviado a cocina se puede corregir libremente. La API debe respetar la misma regla.
- **Permisos:** la fuente de verdad es el servidor (fase 2). El frontend solo oculta botones.
- **Contraseñas:** el administrador crea la contraseña de cada persona al crear su usuario (y la cambia si la olvidan; eso también la desbloquea). El personal puede usar claves sencillas (mínimo 4 caracteres); el administrador, mínimo 8. Protección: bcrypt, bloqueo de 15 minutos tras 5 intentos fallidos y mensaje de error que no dice qué dato falló.
- **Importación del respaldo:** los usuarios no se importan con sus claves viejas; el administrador les pone clave nueva.
- **Ingreso:** con **código de negocio** (ej. `loschamos`) + usuario + contraseña; no por subdominio. La función `tenant_por_codigo()` convierte el código en el id del negocio.
- **Sesión:** la cookie trae el negocio y un token al azar; la API fija ese negocio y busca el hash del token *dentro de ese negocio*, así un token solo sirve en su propio negocio.
- **Internet:** la app necesita internet (sin modo fuera de línea por ahora). Si falla, muestra "No hay conexión" y no guarda nada a medias.
- **Cierre en dos pasos:** la encargada cierra la CAJA (arqueo, bebidas, utensilios) y **cocina cierra de último** con su inventario; con ese último paso termina el turno y se calcula la utilidad. Mientras tanto no se vende ni se abre otro turno. Si cocina no lo hace, quien opera caja puede "terminar sin inventario de cocina" con motivo (queda en el reporte). El reporte de la encargada por WhatsApp dice que el resultado llega con cocina; el mensaje de cocina no lleva dinero; el resultado completo queda en Reportes → Turnos (el administrador lo reenvía).
- **Avisos del cierre (Telegram + correo):** el servidor (`api/_lib/avisos.ts`) envía al dueño un aviso cuando la encargada cierra la caja y el **reporte completo con la utilidad** cuando termina el turno (cocina). Se envían después de guardar, fuera de la transacción: si fallan, el cierre no se afecta. Cada negocio guarda su chat de Telegram y su correo en `tenants.config.avisos` (Ajustes → Negocio → Avisos del cierre).
- **Impresora:** térmica DIG-K260L, papel 80 mm, USB, en el PC de caja con Windows. Impresión automática sin cuadro de diálogo (Chrome `--kiosk-printing`) y corte automático del papel (configuración del controlador de Windows).
- **Parte 4 (pedidos):** habrá 3 a 5 meseras tomando pedidos a la vez en sus celulares. **Todo se imprime en el PC de caja**, que tiene la impresora: las comandas y pre-cuentas que pide una mesera deben salir allá, no en su celular. El dueño eligió: la mesera **arma el pedido en su celular y lo envía todo junto**; se imprimen solas en caja las **comandas, pre-cuentas y recibos**; cocina y caja se actualizan cada 4 s y los celulares cada 16 s (cabe en el plan gratis de Vercel).
- **Mejoras (sept. 2026):** cocina abre primero (desde las 2 p. m.) y la caja después; el envío de domicilio **siempre** se le paga al mensajero en efectivo de la caja; extras **por categoría**; reportes **sin IA** por ahora; la semana del negocio va de **martes a lunes**; el reporte de la encargada no lleva compras de cocina (van en el final); el reporte final se envía cuando cierra el último (caja o cocina).
- **Vercel:** el dueño ya tiene cuenta.
- **Neon:** cuenta creada. Proyecto `loschamos-pos` en AWS US East 1 (N. Virginia), cerca de la región por defecto de Vercel. La cadena de conexión nunca se pega en el chat ni en el código.
