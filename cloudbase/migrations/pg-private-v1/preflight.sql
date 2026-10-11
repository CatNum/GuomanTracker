SELECT jsonb_build_object(
  'database',current_database(), 'database_role',current_user::text,
  'has_schema_create',has_database_privilege(current_user,current_database(),'CREATE'),
  'isolation',current_setting('transaction_isolation'),
  'role_attributes',(SELECT jsonb_build_object('superuser',rolsuper,'bypass_rls',rolbypassrls,'create_role',rolcreaterole)
    FROM pg_catalog.pg_roles WHERE rolname=current_user),
  'anon_exists',EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='anon'),
  'authenticated_exists',EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='authenticated'),
  'private_schema_exists',EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname='guoman_private'),
  'private_schema_owner',(SELECT pg_catalog.pg_get_userbyid(nspowner)
    FROM pg_catalog.pg_namespace WHERE nspname='guoman_private')
) AS result;
