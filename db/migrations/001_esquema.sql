-- =====================================================================
-- Los Chamos POS · 001 Esquema multitenant para Neon (PostgreSQL 16+)
-- ---------------------------------------------------------------------
-- Se ejecuta UNA vez, conectado con el rol dueño de la base (neondb_owner).
-- Cada tabla de negocio lleva tenant_id y Row Level Security (RLS).
-- La API, en cada petición y dentro de una transacción, hace:
--     SELECT set_config('app.tenant_id', '<uuid>', true);
-- y a partir de ahí solo ve y escribe filas de ese negocio.
--
-- Protecciones que no dependen de que la API esté bien programada:
--   * RLS forzado: ni siquiera el dueño de las tablas ve datos sin tenant.
--   * Llaves foráneas compuestas (tenant_id, id): una fila no puede apuntar
--     a la cuenta, orden o usuario de otro negocio.
--   * El libro contable, los pagos y la auditoría no se pueden editar ni borrar.
-- =====================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- Negocio de la petición actual. NULL si la API no lo fijó: entonces no se ve nada.
CREATE FUNCTION current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

-- Día comercial en Colombia. El turno arranca a las 4 p. m. y puede pasar de
-- medianoche: se toma la fecha en que se abrió, en hora de Colombia.
CREATE FUNCTION dia_colombia(ts timestamptz) RETURNS date
LANGUAGE sql IMMUTABLE AS $$ SELECT (ts AT TIME ZONE 'America/Bogota')::date $$;

-- ---------- Negocios (tenants) ----------
CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre        text NOT NULL,
  codigo        text NOT NULL UNIQUE                -- código de negocio que se escribe al ingresar
                CHECK (codigo ~ '^[a-z0-9][a-z0-9-]{2,30}$'),
  nit           text,
  direccion     text,
  telefono      text,
  whatsapp      text,                              -- 573218382315
  zona_horaria  text NOT NULL DEFAULT 'America/Bogota',
  config        jsonb NOT NULL DEFAULT '{}',       -- mesas, ticket 58/80, valor domicilio...
  plan          text NOT NULL DEFAULT 'basico',
  activo        boolean NOT NULL DEFAULT true,
  creado_en     timestamptz NOT NULL DEFAULT now()
);

-- En la pantalla de ingreso todavía no hay negocio fijado: esta función es la única
-- forma de pasar de "código de negocio" a su id, y solo devuelve el id si está activo.
CREATE FUNCTION tenant_por_codigo(p_codigo text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id FROM tenants WHERE codigo = lower(trim(p_codigo)) AND activo
$$;

-- ---------- Usuarios y sesiones ----------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nombre        text NOT NULL,
  usuario       text NOT NULL CHECK (usuario ~ '^[a-z0-9._-]{3,}$'),
  password_hash text,                              -- bcrypt/argon2 calculado en la API. NULL = debe crear contraseña
  rol           text NOT NULL CHECK (rol IN ('admin','encargada','mesera','cocina')),
  permisos      text[] NOT NULL DEFAULT '{}',      -- pos.tomar, pos.cobrar, turno.operar...
  activo        boolean NOT NULL DEFAULT true,
  intentos_fallidos int NOT NULL DEFAULT 0,
  bloqueado_hasta timestamptz,
  creado_en     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, usuario),
  UNIQUE (tenant_id, id)
);

-- La cookie del navegador lleva un token al azar; aquí solo se guarda su hash.
-- La sesión se busca con el negocio ya fijado, así un token solo sirve en su negocio.
CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  dispositivo text,
  expira_en   timestamptz NOT NULL,
  creado_en   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
);

-- ---------- Cuentas de dinero ----------
CREATE TABLE accounts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nombre     text NOT NULL,                        -- Efectivo, Nequi, Bancolombia, Datáfono
  orden      int NOT NULL DEFAULT 0,
  activo     boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, nombre),
  UNIQUE (tenant_id, id)
);

-- ---------- Turnos ----------
CREATE TABLE shifts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  abierto_en    timestamptz NOT NULL DEFAULT now(),
  dia           date NOT NULL GENERATED ALWAYS AS (dia_colombia(abierto_en)) STORED,
  abierto_por   uuid NOT NULL,
  cerrado_por   uuid,
  cerrado_en    timestamptz,
  nota_apertura text,
  nota_cierre   text,
  seq_orden     int NOT NULL DEFAULT 0,
  seq_comanda   int NOT NULL DEFAULT 0,
  apertura      jsonb,                             -- conteos y arqueo de apertura
  cierre        jsonb,                             -- conteos, arqueo y descuadres del cierre
  cocina_cierre jsonb,                             -- inventario de cierre de cocina
  resumen       jsonb,                             -- foto fija del resumen al cerrar
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, abierto_por) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, cerrado_por) REFERENCES users(tenant_id, id),
  CHECK ((cerrado_en IS NULL) = (cerrado_por IS NULL))
);
-- Solo un turno abierto por negocio
CREATE UNIQUE INDEX one_open_shift ON shifts (tenant_id) WHERE cerrado_en IS NULL;
CREATE INDEX ON shifts (tenant_id, dia);

CREATE TABLE shift_staff (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shift_id   uuid NOT NULL,
  user_id    uuid,                                 -- NULL = persona sin usuario en la app
  nombre     text NOT NULL,
  area       text NOT NULL CHECK (area IN ('Cocina','Salón','Caja','Domicilios')),
  PRIMARY KEY (shift_id, nombre),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES shifts(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
);

-- ---------- Libro contable (no se edita ni se borra) ----------
CREATE TABLE ledger_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shift_id    uuid,
  account_id  uuid NOT NULL,
  tipo        text NOT NULL CHECK (tipo IN ('venta','gasto','ingreso','traslado','ajuste','reverso')),
  monto       bigint NOT NULL CHECK (monto <> 0),  -- pesos enteros: + entra / - sale
  concepto    text NOT NULL CHECK (length(trim(concepto)) > 0),
  categoria   text,
  ref_id      uuid,                                -- orden, llegada de mercancía, etc.
  grupo_id    uuid,                                -- une las dos patas de un traslado
  corrige_id  uuid,                                -- en un reverso: el movimiento que corrige
  user_id     uuid,
  creado_en   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id)   REFERENCES shifts(tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, user_id)    REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, corrige_id) REFERENCES ledger_entries(tenant_id, id),
  CHECK ((tipo = 'reverso') = (corrige_id IS NOT NULL))
);
CREATE INDEX ON ledger_entries (tenant_id, account_id, creado_en);
CREATE INDEX ON ledger_entries (tenant_id, shift_id);
-- Un movimiento se reversa una sola vez
CREATE UNIQUE INDEX one_reverse_per_entry ON ledger_entries (corrige_id) WHERE corrige_id IS NOT NULL;

-- Saldo de cada cuenta = suma del libro (nunca se guarda un saldo editable)
CREATE VIEW account_balances WITH (security_invoker = true) AS
  SELECT a.tenant_id, a.id AS account_id, a.nombre, coalesce(sum(l.monto), 0)::bigint AS saldo
  FROM accounts a LEFT JOIN ledger_entries l ON l.tenant_id = a.tenant_id AND l.account_id = a.id
  GROUP BY a.tenant_id, a.id, a.nombre;

-- ---------- Catálogo ----------
CREATE TABLE categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nombre     text NOT NULL,
  orden      int NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, nombre),
  UNIQUE (tenant_id, id)
);

CREATE TABLE products (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category_id  uuid,
  nombre       text NOT NULL,
  precio       bigint NOT NULL CHECK (precio >= 0),
  sin_cocina   boolean NOT NULL DEFAULT false,
  activo       boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories(tenant_id, id)
);

CREATE TABLE pizza_types (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nombre      text NOT NULL,                       -- Pizza sencilla, Pizza premium
  precios     jsonb NOT NULL,                      -- {"Personal":15000,"Mediana":28000,"Familiar":38000}
  extra       jsonb NOT NULL,                      -- precio por sabor adicional según tamaño
  gratis      int NOT NULL DEFAULT 2 CHECK (gratis >= 0),
  sabores     text[] NOT NULL DEFAULT '{}',
  orden       int NOT NULL DEFAULT 0,
  activo      boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id)
);

-- ---------- Inventario (bebidas, utensilios, insumos) ----------
CREATE TABLE inventory_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tipo       text NOT NULL CHECK (tipo IN ('bebida','utensilio','insumo')),
  nombre     text NOT NULL,
  unidad     text NOT NULL DEFAULT 'und',          -- und, kg, L, paquete
  precio     bigint CHECK (precio >= 0),           -- precio de venta (solo bebidas)
  costo      numeric(14,2) NOT NULL DEFAULT 0 CHECK (costo >= 0),  -- costo unitario (puede ser por gramo, por eso admite centavos)
  stock      numeric(14,3) NOT NULL DEFAULT 0,
  sugerido   numeric(14,3) NOT NULL DEFAULT 0,     -- stock sugerido por el admin
  activo     boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id)
);

CREATE TABLE inventory_counts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shift_id   uuid NOT NULL,
  momento    text NOT NULL CHECK (momento IN ('apertura','cierre','cocina_cierre')),
  item_id    uuid NOT NULL,
  sistema    numeric(14,3) NOT NULL,               -- lo que decía el sistema
  contado    numeric(14,3) NOT NULL CHECK (contado >= 0),  -- lo que se contó (conteo ciego)
  user_id    uuid,
  creado_en  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shift_id, momento, item_id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES shifts(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id)  REFERENCES inventory_items(tenant_id, id),
  FOREIGN KEY (tenant_id, user_id)  REFERENCES users(tenant_id, id)
);

CREATE TABLE inventory_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shift_id    uuid,
  item_id     uuid NOT NULL,
  cantidad    numeric(14,3) NOT NULL CHECK (cantidad <> 0),  -- negativo solo en ajustes
  motivo      text NOT NULL DEFAULT 'llegada' CHECK (motivo IN ('llegada','ajuste')),
  costo_total bigint NOT NULL DEFAULT 0 CHECK (costo_total >= 0),
  account_id  uuid,                                -- de dónde se pagó (genera movimiento en el libro)
  nota        text,
  user_id     uuid,
  creado_en   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, shift_id)   REFERENCES shifts(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id)    REFERENCES inventory_items(tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, user_id)    REFERENCES users(tenant_id, id),
  CHECK (motivo = 'ajuste' OR cantidad > 0),
  CHECK (motivo = 'llegada' OR length(trim(coalesce(nota, ''))) > 0)  -- un ajuste siempre lleva motivo
);

-- ---------- Órdenes, comandas y pagos ----------
CREATE TABLE orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shift_id      uuid NOT NULL,
  numero        int,                               -- consecutivo del turno
  tipo          text NOT NULL CHECK (tipo IN ('mesa','domicilio')),
  mesa          int CHECK (mesa > 0),
  cliente       text, telefono text, direccion text, nota text,
  estado        text NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta','pagada','anulada')),
  mesero_id     uuid,
  cobrado_por   uuid,
  precuenta_en  timestamptz,
  recibido      bigint CHECK (recibido >= 0),
  cambio        bigint CHECK (cambio >= 0),
  creado_en     timestamptz NOT NULL DEFAULT now(),
  cerrado_en    timestamptz,
  version       int NOT NULL DEFAULT 1,            -- control de concurrencia entre dispositivos
  UNIQUE (shift_id, numero),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id)    REFERENCES shifts(tenant_id, id),
  FOREIGN KEY (tenant_id, mesero_id)   REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, cobrado_por) REFERENCES users(tenant_id, id),
  CHECK ((tipo = 'mesa') = (mesa IS NOT NULL)),
  CHECK (tipo = 'mesa' OR (cliente IS NOT NULL AND direccion IS NOT NULL)),
  CHECK ((estado = 'abierta') = (cerrado_en IS NULL))
);
-- Una mesa no puede tener dos cuentas abiertas
CREATE UNIQUE INDEX one_open_order_per_table ON orders (tenant_id, mesa) WHERE estado = 'abierta' AND tipo = 'mesa';
CREATE INDEX ON orders (tenant_id, shift_id, estado);

CREATE TABLE kitchen_tickets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id     uuid NOT NULL,
  numero       int NOT NULL,                       -- número de comanda del turno
  estado       text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','listo','entregado')),
  user_id      uuid,
  creado_en    timestamptz NOT NULL DEFAULT now(),
  listo_en     timestamptz,
  entregado_en timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id)  REFERENCES users(tenant_id, id)
);
CREATE INDEX ON kitchen_tickets (tenant_id, estado, creado_en);

CREATE TABLE order_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id          uuid NOT NULL,
  product_id        uuid,
  inventory_item_id uuid,                          -- si es bebida
  nombre            text NOT NULL,                 -- copia al momento de vender
  categoria         text,
  detalle           text,                          -- sabores de pizza, etc.
  obs               text,
  precio            bigint NOT NULL CHECK (precio >= 0),
  qty               int NOT NULL CHECK (qty > 0),
  sin_cocina        boolean NOT NULL DEFAULT false,
  ticket_id         uuid,
  agregado_por      uuid,
  anulada           boolean NOT NULL DEFAULT false,
  anulada_motivo    text,
  anulada_por       uuid,
  anulada_en        timestamptz,
  creado_en         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, order_id)          REFERENCES orders(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id)        REFERENCES products(tenant_id, id),
  FOREIGN KEY (tenant_id, inventory_item_id) REFERENCES inventory_items(tenant_id, id),
  FOREIGN KEY (tenant_id, ticket_id)         REFERENCES kitchen_tickets(tenant_id, id),
  FOREIGN KEY (tenant_id, agregado_por)      REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, anulada_por)       REFERENCES users(tenant_id, id),
  CHECK (NOT anulada OR (length(trim(coalesce(anulada_motivo, ''))) > 0 AND anulada_por IS NOT NULL AND anulada_en IS NOT NULL))
);
CREATE INDEX ON order_items (tenant_id, order_id);

CREATE TABLE payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id    uuid NOT NULL,
  account_id  uuid NOT NULL,
  monto       bigint NOT NULL CHECK (monto > 0),
  ledger_id   uuid NOT NULL UNIQUE,                -- el movimiento del libro que registra este pago
  user_id     uuid,
  creado_en   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, order_id)   REFERENCES orders(tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, ledger_id)  REFERENCES ledger_entries(tenant_id, id),
  FOREIGN KEY (tenant_id, user_id)    REFERENCES users(tenant_id, id)
);

-- ---------- Auditoría ----------
CREATE TABLE audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid,
  accion     text NOT NULL,
  detalle    text,
  datos      jsonb,
  creado_en  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
);
CREATE INDEX ON audit_log (tenant_id, creado_en DESC);

-- ---------- Libro contable, pagos y auditoría: solo se agregan filas ----------
-- Aplica a todos, incluido el dueño de la base. Un error de dinero se corrige con
-- un movimiento nuevo (tipo 'reverso' o 'ajuste'), nunca editando ni borrando.
CREATE FUNCTION solo_agregar() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'La tabla % no se puede % : registra un movimiento de corrección', TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = 'insufficient_privilege';
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ledger_entries','payments','audit_log'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION solo_agregar()', t || '_solo_agregar', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION solo_agregar()', t || '_sin_truncate', t);
  END LOOP;
END $$;

-- ---------- Row Level Security ----------
-- tenants: cada negocio solo ve su propia fila. (Sin FORCE, para que tenant_por_codigo funcione.)
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants USING (id = current_tenant()) WITH CHECK (id = current_tenant());

-- Todas las demás: filtro por tenant_id, forzado también para el dueño de las tablas.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','sessions','accounts','shifts','shift_staff','ledger_entries',
    'categories','products','pizza_types','inventory_items','inventory_counts','inventory_entries',
    'orders','kitchen_tickets','order_items','payments','audit_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant())', t);
  END LOOP;
END $$;

COMMIT;
