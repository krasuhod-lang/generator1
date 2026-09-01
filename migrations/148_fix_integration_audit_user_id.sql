-- 148_fix_integration_audit_user_id.sql
-- The application user identifiers are UUID strings. Keep the masked audit trail
-- compatible with both current UUID ids and any legacy numeric identifiers.
ALTER TABLE IF EXISTS admin_integration_secret_audit
  ALTER COLUMN admin_user_id TYPE TEXT
  USING admin_user_id::text;

COMMENT ON COLUMN admin_integration_secret_audit.admin_user_id IS
  'Application user identifier stored as text; supports UUID and legacy numeric ids.';
