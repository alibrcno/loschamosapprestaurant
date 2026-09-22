-- =====================================================================
-- Los Chamos POS · Esquema multitenant para Neon (PostgreSQL 16+)
-- Fase 2: frontend estático -> API (Node, serverless) -> Neon
-- Cada tabla de negocio lleva tenant_id y Row Level Security.
-- La API, en cada petición, hace:  SET LOCAL app.tenant_id = '<uuid>';
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ---------- Rol de la aplicación (la API se conecta con este, NUNCA como owner) ----------
-- CREATE ROLE app_user LOGIN PASSWORD '...';   -- créalo en la consola de Neon
-- El owner de las tablas salta RLS; app_user no.

CREATE OR REPLACE FUNCTION current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

-- ---------- Negocios (tenants) ----------
CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre        text NOT NULL,
  slug          text UNIQUE NOT NULL,              -- loschamos -> loschamos.tuapp.com
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

-- ---------- Usuarios y permisos ----------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nombre        text NOT NULL,
  usuario       text NOT NULL,
  password_hash text NOT NULL,                     -- bcrypt/argon2, calculado en la API
  rol           text NOT NULL CHECK (rol IN ('admin','encargada','mesera','cocina')),
  permisos      text[] NOT NULL DEFAULT '{}',      -- pos.tomar, pos.cobrar, turno.operar...
  activo        boolean NOT NULL DEFAULT true,
  intentos_fallidos int NOT NULL DEFAULT 0,
  bloqueado_hasta timestamptz,
  creado_en     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, usuario)
);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  dispositivo text,
  expira_en   timestamptz NOT NULL,
  creado_en   timestamptz NOT NULL DEFAULT now()
);

-- ---------- Cuentas de dinero y libro contable ----------
CREATE TABLE accounts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nombre     text NOT NULL,                        -- Efectivo, Nequi, Bancolombia, Datáfono
  activo     boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, nombre)
);

-- ---------- Turnos ----------
CREATE TABLE shifts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  dia           date NOT NULL,                     -- día comercial (hora Colombia)
  abierto_por   uuid NOT NULL REFERENCES users(id),
  abierto_en    timestamptz NOT NULL DEFAULT now(),
  cerrado_por   uuid REFERENCES users(id),
  cerrado_en    timestamptz,
  nota_apertura text,
  nota_cierre   text,
  seq_orden     int NOT NULL DEFAULT 0,
  seq_comanda   int NOT NULL DEFAULT 0,
  resumen       jsonb                               -- snapshot del cierre
);
-- Solo un turno abierto por negocio
CREATE UNIQUE INDEX one_open_shift ON shifts (tenant_id) WHERE cerrado_en IS NULL;

CREATE TABLE shift_staff (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shift_id   uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  user_id    uuid REFERENCES users(id),
  nombre     text NOT NULL,                        -- permite personal sin usuario
  area       text NOT NULL CHECK (area IN ('Cocina','Salón','Caja','Domicilios')),
  PRIMARY KEY (shift_id, nombre)
);

CREATE TABLE ledger_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shift_id    uuid REFERENCES shifts(id),
  account_id  uuid NOT NULL REFERENCES accounts(id),
  tipo        text NOT NULL CHECK (tipo IN ('venta','gasto','ingreso','traslado','ajuste')),
  monto       bigint NOT NULL,                     -- pesos, + entra / - sale
  concepto    text NOT NULL,
  categoria   text,
  ref_id      uuid,                                -- orden, entrada de inventario, etc.
  user_id     uuid REFERENCES users(id),
  creado_en   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ledger_entries (tenant_id, account_id, creado_en);
-- Saldo de cada cuenta = suma del libro (nunca se guarda un saldo editable)
CREATE VIEW account_balances AS
  SELECT a.tenant_id, a.id AS account_id, a.nombre, coalesce(sum(l.monto),0) AS saldo
  FROM accounts a LEFT JOIN ledger_entries l ON l.account_id = a.id
  GROUP BY a.tenant_id, a.id, a.nombre;

-- ---------- Catálogo ----------
CREATE TABLE categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nombre     text NOT NULL,
  orden      int NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, nombre)
);

CREATE TABLE products (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category_id  uuid REFERENCES categories(id),
  nombre       text NOT NULL,
  precio       bigint NOT NULL CHECK (precio >= 0),
  sin_cocina   boolean NOT NULL DEFAULT false,
  activo       boolean NOT NULL DEFAULT true
);

CREATE TABLE pizza_types (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nombre      text NOT NULL,                       -- Sencilla, Premium
  precios     jsonb NOT NULL,                      -- {"Personal":15000,"Mediana":..,"Familiar":..}
  extra       jsonb NOT NULL,                      -- precio por sabor adicional según tamaño
  gratis      int NOT NULL DEFAULT 2,
  sabores     text[] NOT NULL DEFAULT '{}',
  activo      boolean NOT NULL DEFAULT true
);

-- ---------- Inventario (bebidas, utensilios, insumos) ----------
CREATE TABLE inventory_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tipo       text NOT NULL CHECK (tipo IN ('bebida','utensilio','insumo')),
  nombre     text NOT NULL,
  unidad     text NOT NULL DEFAULT 'und',          -- und, kg, L
  precio     bigint,                               -- precio de venta (bebidas)
  costo      numeric(14,2) NOT NULL DEFAULT 0,     -- costo unitario
  stock      numeric(14,3) NOT NULL DEFAULT 0,
  sugerido   numeric(14,3) NOT NULL DEFAULT 0,     -- stock sugerido del admin
  activo     boolean NOT NULL DEFAULT true
);

CREATE TABLE inventory_counts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shift_id   uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  momento    text NOT NULL CHECK (momento IN ('apertura','cierre','cocina_cierre')),
  item_id    uuid NOT NULL REFERENCES inventory_items(id),
  sistema    numeric(14,3) NOT NULL,               -- lo que decía el sistema
  contado    numeric(14,3) NOT NULL,               -- lo que se contó (conteo ciego)
  user_id    uuid REFERENCES users(id),
  creado_en  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shift_id, momento, item_id)
);

CREATE TABLE inventory_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shift_id    uuid REFERENCES shifts(id),
  item_id     uuid NOT NULL REFERENCES inventory_items(id),
  cantidad    numeric(14,3) NOT NULL CHECK (cantidad <> 0),  -- negativo solo en ajustes
  motivo      text NOT NULL DEFAULT 'llegada' CHECK (motivo IN ('llegada','ajuste')),
  costo_total bigint NOT NULL DEFAULT 0,
  account_id  uuid REFERENCES accounts(id),        -- de dónde se pagó (genera ledger)
  nota        text,
  user_id     uuid REFERENCES users(id),
  creado_en   timestamptz NOT NULL DEFAULT now()
);

-- ---------- Órdenes, comandas y pagos ----------
CREATE TABLE orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shift_id      uuid NOT NULL REFERENCES shifts(id),
  numero        int,                               -- consecutivo del turno
  tipo          text NOT NULL CHECK (tipo IN ('mesa','domicilio')),
  mesa          int,
  cliente       text, telefono text, direccion text,
  estado        text NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta','pagada','anulada')),
  mesero_id     uuid REFERENCES users(id),
  precuenta_en  timestamptz,
  recibido      bigint, cambio bigint,
  creado_en     timestamptz NOT NULL DEFAULT now(),
  cerrado_en    timestamptz,
  version       int NOT NULL DEFAULT 1,            -- control de concurrencia entre dispositivos
  UNIQUE (shift_id, numero)
);
-- Una mesa no puede tener dos cuentas abiertas
CREATE UNIQUE INDEX one_open_order_per_table ON orders (tenant_id, mesa) WHERE estado = 'abierta' AND tipo = 'mesa';

CREATE TABLE kitchen_tickets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id   uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  numero     int NOT NULL,
  estado     text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','listo','entregado')),
  user_id    uuid REFERENCES users(id),
  creado_en  timestamptz NOT NULL DEFAULT now(),
  listo_en   timestamptz, entregado_en timestamptz
);

CREATE TABLE order_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id    uuid REFERENCES products(id),
  inventory_item_id uuid REFERENCES inventory_items(id),   -- si es bebida
  nombre        text NOT NULL,                     -- copia al momento de vender
  categoria     text,
  detalle       text,                              -- sabores de pizza, etc.
  obs           text,
  precio        bigint NOT NULL,
  qty           int NOT NULL CHECK (qty > 0),
  sin_cocina    boolean NOT NULL DEFAULT false,
  ticket_id     uuid REFERENCES kitchen_tickets(id),
  anulada       boolean NOT NULL DEFAULT false,
  anulada_motivo text,
  anulada_por   uuid REFERENCES users(id),
  creado_en     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  account_id  uuid NOT NULL REFERENCES accounts(id),
  monto       bigint NOT NULL CHECK (monto > 0),
  creado_en   timestamptz NOT NULL DEFAULT now()
);

-- ---------- Auditoría ----------
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid REFERENCES users(id),
  accion     text NOT NULL,
  detalle    text,
  datos      jsonb,
  creado_en  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (tenant_id, creado_en DESC);

-- ---------- Row Level Security en todas las tablas con tenant_id ----------
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
-- La vista hereda el filtro de las tablas base
ALTER VIEW account_balances SET (security_invoker = true);

-- El libro contable y la auditoría no se editan ni se borran: solo se agregan correcciones
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
-- REVOKE UPDATE, DELETE ON ledger_entries, audit_log, payments FROM app_user;
-- GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_user;
