-- =====================================================================
-- Los Chamos POS · 006 Logo del negocio
-- ---------------------------------------------------------------------
-- Se ejecuta UNA vez, como neondb_owner, después de 001 a 005.
-- Cada negocio sube su logo (imagen pequeña, la app la achica antes de enviarla).
-- Sale en la app y en los tickets. Se guarda aparte de "config" para no cargarlo
-- en cada consulta de configuración.
-- =====================================================================

BEGIN;

ALTER TABLE tenants ADD COLUMN logo text CHECK (logo IS NULL OR (logo LIKE 'data:image/%' AND length(logo) <= 120000));
GRANT UPDATE (logo) ON tenants TO app_user;

COMMIT;
