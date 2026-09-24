-- =====================================================================
-- Crea (o cambia) la contraseña de app_user y la muestra UNA sola vez.
-- ---------------------------------------------------------------------
-- Ejecútalo en el SQL Editor de Neon, conectado como neondb_owner.
-- Copia la clave que aparece en el resultado DIRECTO a la variable secreta de
-- Vercel. No la pegues en el chat, en WhatsApp ni en ningún archivo.
-- Si la clave se pierde o se filtra, vuelve a ejecutar esto: la anterior deja de servir.
-- =====================================================================

CREATE FUNCTION pg_temp.nueva_clave_app_user() RETURNS text LANGUAGE plpgsql AS $$
DECLARE clave text := encode(gen_random_bytes(24), 'hex');   -- 48 caracteres al azar
BEGIN
  EXECUTE format('ALTER ROLE app_user WITH LOGIN PASSWORD %L', clave);
  RETURN clave;
END $$;

SELECT pg_temp.nueva_clave_app_user() AS clave_app_user;
