SELECT jsonb_build_object(
  'schema_owner',(SELECT pg_catalog.pg_get_userbyid(nspowner) FROM pg_catalog.pg_namespace WHERE nspname='guoman_private'),
  'schema_comment',pg_catalog.obj_description('guoman_private'::regnamespace,'pg_namespace'),
  'table_owner',(SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid='guoman_private.documents'::regclass),
  'row_security',(SELECT relrowsecurity AND relforcerowsecurity FROM pg_catalog.pg_class WHERE oid='guoman_private.documents'::regclass),
  'initial_rows',(SELECT count(*) FROM guoman_private.documents),
  'functions',(SELECT jsonb_agg(jsonb_build_object('name',p.proname,'args',pg_catalog.pg_get_function_identity_arguments(p.oid),
    'owner',pg_catalog.pg_get_userbyid(p.proowner),'security_definer',p.prosecdef,'volatility',p.provolatile,'settings',p.proconfig)
    ORDER BY p.proname) FROM pg_catalog.pg_proc p WHERE p.pronamespace='guoman_private'::regnamespace),
  'client_access',(SELECT jsonb_agg(jsonb_build_object('role',r.rolname,
    'schema_usage',has_schema_privilege(r.oid,'guoman_private','USAGE'),
    'table_select',has_table_privilege(r.oid,'guoman_private.documents','SELECT'),
    'table_insert',has_table_privilege(r.oid,'guoman_private.documents','INSERT'),
    'table_update',has_table_privilege(r.oid,'guoman_private.documents','UPDATE'),
    'table_delete',has_table_privilege(r.oid,'guoman_private.documents','DELETE'),
    'function_execute',EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace='guoman_private'::regnamespace
                              AND has_function_privilege(r.oid,p.oid,'EXECUTE')))
    ORDER BY r.rolname) FROM pg_catalog.pg_roles r WHERE r.rolname IN ('anon','authenticated'))
) AS result;
