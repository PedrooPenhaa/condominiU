-- Isolamento entre condomínios feito pelo próprio banco.
-- O sistema se conecta como condo_app, que não é dono das tabelas, então as regras sempre valem.
SET search_path = app;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'condo_app') THEN
    CREATE ROLE condo_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

CREATE FUNCTION app.current_tenant() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE FUNCTION app.is_platform() RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.is_platform', true), '') = 'on' $$;

REVOKE ALL ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO condo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO condo_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO condo_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO condo_app;
REVOKE DELETE, UPDATE ON app.audit_log FROM condo_app;

-- Dados só da plataforma
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON users TO condo_app USING (app.is_platform()) WITH CHECK (app.is_platform());
CREATE POLICY platform_only ON sessions TO condo_app USING (app.is_platform()) WITH CHECK (app.is_platform());
CREATE POLICY platform_only ON webhook_events TO condo_app USING (app.is_platform()) WITH CHECK (app.is_platform());
CREATE POLICY platform_only ON platform_invoices TO condo_app USING (app.is_platform()) WITH CHECK (app.is_platform());

-- O condomínio lê a própria linha; só a plataforma altera
ALTER TABLE condominiums ENABLE ROW LEVEL SECURITY;
CREATE POLICY condo_read ON condominiums FOR SELECT TO condo_app
  USING (app.is_platform() OR id = app.current_tenant());
CREATE POLICY condo_write ON condominiums FOR ALL TO condo_app
  USING (app.is_platform()) WITH CHECK (app.is_platform());

-- Dados de cada condomínio
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['units', 'memberships', 'residents', 'charges', 'visitor_passes'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON app.%I TO condo_app
         USING (app.is_platform() OR condominium_id = app.current_tenant())
         WITH CHECK (app.is_platform() OR condominium_id = app.current_tenant())', t);
  END LOOP;
END $$;

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON audit_log FOR SELECT TO condo_app
  USING (app.is_platform() OR condominium_id = app.current_tenant());
CREATE POLICY audit_write ON audit_log FOR INSERT TO condo_app
  WITH CHECK (app.is_platform() OR condominium_id = app.current_tenant());
