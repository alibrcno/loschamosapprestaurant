# Los Chamos POS · Reglas del proyecto

Punto de venta, control de turno, inventario y finanzas para Los Chamos, restaurante de comida rápida en Valledupar, Colombia. El dueño está aprendiendo a programar: explica cada cambio en palabras simples y en español.

## Objetivo

Convertir la app en un **SaaS multitenant** para que el celular de la mesera, la pantalla de cocina y la caja compartan los mismos datos en tiempo real, y para que otros negocios puedan usarla.

```
Navegador (public/)  ──HTTPS──>  API serverless en Vercel (/api, Node + TypeScript)  ──>  Neon Postgres
```

## Estado actual

- `public/`: la app que funciona hoy. HTML, CSS y JavaScript puro, sin compilar. Guarda todo en `localStorage` a través de `public/store.js`.
- `public/store.js` es la **única puerta a los datos**. Al conectar la API se reemplazan sus funciones (`load`, `save`, `mov`…) por llamadas HTTP; las pantallas (`app.js`, `turno.js`, `pos.js`, `reportes.js`) no deberían tener que reescribirse.
- `db/migrations/`: esquema de Neon en archivos numerados (`001_…`, `002_…`). Nunca se edita una migración ya aplicada en Neon: los cambios van en un archivo nuevo, que también da sus permisos a `app_user`.
- `db/pruebas/probar.sh`: aplica las migraciones en un Postgres **local** y prueba el aislamiento entre negocios y que el dinero no se pueda editar. Correrlo después de cualquier cambio en `db/`.
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
- **Importación del respaldo:** los usuarios no se importan con sus claves actuales. Cada persona crea una contraseña nueva, que se guarda con bcrypt o argon2 en la API.
- **Ingreso:** con **código de negocio** (ej. `loschamos`) + usuario + contraseña; no por subdominio. La función `tenant_por_codigo()` convierte el código en el id del negocio.
- **Sesión:** la cookie trae el negocio y un token al azar; la API fija ese negocio y busca el hash del token *dentro de ese negocio*, así un token solo sirve en su propio negocio.
- **Vercel:** el dueño ya tiene cuenta.
- **Neon:** cuenta creada. Proyecto `loschamos-pos` en AWS US East 1 (N. Virginia), cerca de la región por defecto de Vercel. La cadena de conexión nunca se pega en el chat ni en el código.
