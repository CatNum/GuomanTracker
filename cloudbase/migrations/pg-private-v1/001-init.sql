-- 已审查初始化迁移；执行前必须通过生产审查文档中的只读前置条件。
-- 一个 DO 语句，单次管理 API 原子创建；本文件未执行。
-- 仅适用于已实证数据库/角色；任何名称已存在都失败，禁止覆盖。
DO LANGUAGE plpgsql $migration$
BEGIN
  IF current_database() IS DISTINCT FROM 'postgres-8nap8z1o'
     OR current_user::text IS DISTINCT FROM 'cloudbase_postgres_postgres_8nap8z1o' THEN
    RAISE EXCEPTION 'unexpected database identity' USING ERRCODE='42501';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname='guoman_private') THEN
    RAISE EXCEPTION 'guoman_private already exists';
  END IF;
  EXECUTE $ddl$ CREATE SCHEMA guoman_private $ddl$;
  EXECUTE $ddl$ REVOKE ALL ON SCHEMA guoman_private FROM PUBLIC, anon, authenticated $ddl$;
  EXECUTE $ddl$ COMMENT ON SCHEMA guoman_private IS 'GuomanTracker PG storage v1; env guoman-d1goxm3hhb53752a4; optimistic commit protocol 20261011/197307' $ddl$;
  EXECUTE $ddl$
    CREATE TABLE guoman_private.documents (
      collection text NOT NULL CHECK(collection IN ('guoman_series','guoman_watch_state','guoman_monitor_targets')),
      id text COLLATE "C" NOT NULL CHECK(length(id) BETWEEN 1 AND 256),
      document jsonb NOT NULL CHECK(
        jsonb_typeof(document)='object' AND document ? '_id'
        AND jsonb_typeof(document->'_id')='string' AND document->>'_id'=id
      ),
      PRIMARY KEY(collection,id)
    )
  $ddl$;
  EXECUTE $ddl$ CREATE INDEX documents_follows ON guoman_private.documents
    ((document->>'owner'), id COLLATE "C")
    WHERE collection='guoman_watch_state' AND document->>'kind'='follow' $ddl$;
  EXECUTE $ddl$ ALTER TABLE guoman_private.documents ENABLE ROW LEVEL SECURITY $ddl$;
  EXECUTE $ddl$ ALTER TABLE guoman_private.documents FORCE ROW LEVEL SECURITY $ddl$;
  EXECUTE $ddl$ CREATE POLICY backend_only ON guoman_private.documents
    TO "cloudbase_postgres_postgres_8nap8z1o" USING (true) WITH CHECK (true) $ddl$;
  EXECUTE $ddl$
    CREATE FUNCTION guoman_private.assert_backend() RETURNS void
    LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
    BEGIN
      IF current_database() IS DISTINCT FROM 'postgres-8nap8z1o'
         OR current_user::text IS DISTINCT FROM 'cloudbase_postgres_postgres_8nap8z1o' THEN
        RAISE EXCEPTION 'backend identity required' USING ERRCODE='42501';
      END IF;
    END;
    $fn$
  $ddl$;
  EXECUTE $ddl$
    CREATE FUNCTION guoman_private.get_document(p jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
    DECLARE d jsonb;
    BEGIN
      PERFORM guoman_private.assert_backend();
      IF jsonb_typeof(p) IS DISTINCT FROM 'object'
         OR jsonb_typeof(p->'collection') IS DISTINCT FROM 'string'
         OR (p->>'collection') NOT IN ('guoman_series','guoman_watch_state','guoman_monitor_targets')
         OR jsonb_typeof(p->'id') IS DISTINCT FROM 'string'
         OR length(p->>'id') NOT BETWEEN 1 AND 256 THEN
        RAISE EXCEPTION 'invalid read' USING ERRCODE='22023';
      END IF;
      SELECT document INTO d FROM guoman_private.documents
        WHERE collection=p->>'collection' AND id=p->>'id';
      IF FOUND THEN RETURN jsonb_build_object('exists',true,'document',d); END IF;
      RETURN jsonb_build_object('exists',false);
    END;
    $fn$
  $ddl$;
  EXECUTE $ddl$
    CREATE FUNCTION guoman_private.list_follows_page(p jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
    DECLARE answer jsonb;
    BEGIN
      PERFORM guoman_private.assert_backend();
      IF jsonb_typeof(p) IS DISTINCT FROM 'object'
         OR jsonb_typeof(p->'owner') IS DISTINCT FROM 'string'
         OR length(p->>'owner') NOT BETWEEN 1 AND 256
         OR jsonb_typeof(p->'after') IS DISTINCT FROM 'string'
         OR length(p->>'after')>256 THEN
        RAISE EXCEPTION 'invalid list' USING ERRCODE='22023';
      END IF;
      WITH page AS MATERIALIZED (
        SELECT id,document FROM guoman_private.documents
        WHERE collection='guoman_watch_state' AND document->>'kind'='follow'
          AND document->>'owner'=p->>'owner' AND id>(p->>'after') COLLATE "C"
        ORDER BY id COLLATE "C" LIMIT 100
      ), related AS (
        SELECT DISTINCT page.document->>'seriesId' AS series_id, series.document AS doc
        FROM page LEFT JOIN guoman_private.documents series
          ON series.collection='guoman_series' AND series.id=page.document->>'seriesId'
      )
      SELECT jsonb_build_object(
        'documents',COALESCE((SELECT jsonb_agg(document ORDER BY id COLLATE "C") FROM page),'[]'::jsonb),
        'related',COALESCE((SELECT jsonb_agg(CASE WHEN doc IS NULL
          THEN jsonb_build_object('id',series_id,'exists',false)
          ELSE jsonb_build_object('id',series_id,'exists',true,'document',doc) END) FROM related),'[]'::jsonb),
        'next_after',CASE WHEN (SELECT count(*) FROM page)=100
          THEN (SELECT id FROM page ORDER BY id COLLATE "C" DESC LIMIT 1) ELSE '' END
      ) INTO answer;
      RETURN answer;
    END;
    $fn$
  $ddl$;
  EXECUTE $ddl$
    CREATE FUNCTION guoman_private.commit_documents(p jsonb) RETURNS jsonb
    LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
    DECLARE r jsonb; w jsonb; d jsonb; present boolean;
    BEGIN
      PERFORM guoman_private.assert_backend();
      IF jsonb_typeof(p) IS DISTINCT FROM 'object'
         OR jsonb_typeof(p->'reads') IS DISTINCT FROM 'array'
         OR jsonb_typeof(p->'writes') IS DISTINCT FROM 'array'
         OR jsonb_array_length(p->'reads')>128 OR jsonb_array_length(p->'writes')>128
         OR octet_length(p::text)>524288 THEN
        RAISE EXCEPTION 'invalid batch' USING ERRCODE='22023';
      END IF;
      FOR r IN SELECT value FROM jsonb_array_elements(p->'reads') LOOP
        IF jsonb_typeof(r) IS DISTINCT FROM 'object'
           OR jsonb_typeof(r->'collection') IS DISTINCT FROM 'string'
           OR (r->>'collection') NOT IN ('guoman_series','guoman_watch_state','guoman_monitor_targets')
           OR jsonb_typeof(r->'id') IS DISTINCT FROM 'string'
           OR length(r->>'id') NOT BETWEEN 1 AND 256
           OR jsonb_typeof(r->'exists') IS DISTINCT FROM 'boolean'
           OR (r->>'exists'='true' AND jsonb_typeof(r->'document') IS DISTINCT FROM 'object')
           OR (r->>'exists'='false' AND r ? 'document') THEN
          RAISE EXCEPTION 'invalid read item' USING ERRCODE='22023';
        END IF;
      END LOOP;
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'reads') AS x(value)
                GROUP BY value->>'collection',value->>'id' HAVING count(*)>1)
         OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'writes') AS x(value)
                GROUP BY value->>'collection',value->>'id' HAVING count(*)>1) THEN
        RAISE EXCEPTION 'duplicate keys' USING ERRCODE='22023';
      END IF;
      FOR w IN SELECT value FROM jsonb_array_elements(p->'writes') LOOP
        IF jsonb_typeof(w) IS DISTINCT FROM 'object'
           OR jsonb_typeof(w->'collection') IS DISTINCT FROM 'string'
           OR (w->>'collection') NOT IN ('guoman_series','guoman_watch_state','guoman_monitor_targets')
           OR jsonb_typeof(w->'id') IS DISTINCT FROM 'string'
           OR length(w->>'id') NOT BETWEEN 1 AND 256
           OR jsonb_typeof(w->'op') IS DISTINCT FROM 'string'
           OR (w->>'op') NOT IN ('put','remove')
           OR (w->>'op'='put' AND jsonb_typeof(w->'document') IS DISTINCT FROM 'object')
           OR (w->>'op'='remove' AND w ? 'document')
           OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'reads') AS x(value)
                         WHERE value->>'collection'=w->>'collection' AND value->>'id'=w->>'id') THEN
          RAISE EXCEPTION 'invalid write item' USING ERRCODE='22023';
        END IF;
      END LOOP;
      IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
        RAISE EXCEPTION 'unsupported isolation' USING ERRCODE='25000';
      END IF;
      -- 固定事务锁，只覆盖提交窗口；锁和后续校验必须是不同SQL语句。
      PERFORM set_config('lock_timeout','5s',true);
      PERFORM pg_advisory_xact_lock(20261011,197307);
      FOR r IN SELECT value FROM jsonb_array_elements(p->'reads') LOOP
        SELECT document INTO d FROM guoman_private.documents
          WHERE collection=r->>'collection' AND id=r->>'id';
        present:=FOUND;
        IF present IS DISTINCT FROM (r->>'exists')::boolean
           OR (present AND d IS DISTINCT FROM r->'document') THEN
          RETURN jsonb_build_object('ok',false,'code','TX_RETRY');
        END IF;
      END LOOP;
      FOR w IN SELECT value FROM jsonb_array_elements(p->'writes') LOOP
        IF w->>'op'='remove' THEN
          DELETE FROM guoman_private.documents WHERE collection=w->>'collection' AND id=w->>'id';
        ELSE
          INSERT INTO guoman_private.documents(collection,id,document)
          VALUES(w->>'collection',w->>'id',(w->'document')||jsonb_build_object('_id',w->>'id'))
          ON CONFLICT(collection,id) DO UPDATE SET document=EXCLUDED.document;
        END IF;
      END LOOP;
      RETURN jsonb_build_object('ok',true);
    END;
    $fn$
  $ddl$;
  EXECUTE $ddl$ REVOKE ALL ON ALL FUNCTIONS IN SCHEMA guoman_private FROM PUBLIC, anon, authenticated $ddl$;
  EXECUTE $ddl$ REVOKE ALL ON ALL TABLES IN SCHEMA guoman_private FROM PUBLIC, anon, authenticated $ddl$;
END;
$migration$;
