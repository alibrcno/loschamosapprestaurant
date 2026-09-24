-- =====================================================================
-- Los Chamos POS · 002 Rol de la API (app_user)
-- ---------------------------------------------------------------------
-- Se ejecuta UNA vez, como neondb_owner, después de 001.
-- La API se conecta SIEMPRE con app_user, nunca con neondb_owner:
--   * app_user no es dueño de las tablas y no puede saltarse RLS.
--   * No puede crear ni borrar tablas.
--   * No puede editar ni borrar el libro contable, los pagos ni la auditoría.
-- La contraseña se crea aparte con db/clave_app_user.sql (no va en este archivo).
-- Si una migración futura crea tablas, debe dar sus permisos a app_user ahí mismo.
-- =====================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
END $$;

-- Una consulta colgada no debe tumbar la API
ALTER ROLE app_user SET statement_timeout = '15s';
ALTER ROLE app_user SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE app_user SET timezone = 'America/Bogota';

GRANT USAGE ON SCHEMA public TO app_user;

-- Datos del día a día: leer, crear, modificar y borrar (siempre filtrado por RLS)
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, sessions, accounts, shifts, shift_staff, categories, products, pizza_types,
  inventory_items, inventory_counts, inventory_entries, orders, kitchen_tickets, order_items
TO app_user;

-- Dinero y auditoría: solo leer y agregar
GRANT SELECT, INSERT ON ledger_entries, payments, audit_log TO app_user;
GRANT SELECT ON account_balances TO app_user;

-- El negocio: ve solo el suyo (RLS) y puede cambiar sus datos de contacto y configuración,
-- pero no su código, su plan ni si está activo. Crear negocios lo hace el dueño de la plataforma.
GRANT SELECT ON tenants TO app_user;
GRANT UPDATE (nombre, nit, direccion, telefono, whatsapp, config) ON tenants TO app_user;

-- Funciones
REVOKE EXECUTE ON FUNCTION tenant_por_codigo(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_por_codigo(text), current_tenant(), dia_colombia(timestamptz) TO app_user;

COMMIT;
