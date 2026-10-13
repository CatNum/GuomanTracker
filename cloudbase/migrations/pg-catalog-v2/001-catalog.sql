-- 增量目录查询；不修改既有表或用户记录，单次原子创建。
DO LANGUAGE plpgsql $migration$
BEGIN
  PERFORM guoman_private.assert_backend();
  IF to_regprocedure('guoman_private.list_series_page(jsonb)') IS NOT NULL
     OR to_regprocedure('guoman_private.find_series_by_url(jsonb)') IS NOT NULL
     OR to_regprocedure('guoman_private.ingest_series_batch(jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'catalog functions already exist; inspect before retry';
  END IF;
  EXECUTE $ddl$
    CREATE INDEX documents_series_url ON guoman_private.documents
      ((document->>'url'), id COLLATE "C") WHERE collection='guoman_series'
  $ddl$;
  EXECUTE $ddl$
    CREATE FUNCTION guoman_private.list_series_page(p jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
    DECLARE answer jsonb;
    BEGIN
      PERFORM guoman_private.assert_backend();
      IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR p - 'after' <> '{}'::jsonb
         OR jsonb_typeof(p->'after') IS DISTINCT FROM 'string' OR length(p->>'after')>256 THEN
        RAISE EXCEPTION 'invalid catalog cursor' USING ERRCODE='22023';
      END IF;
      WITH page AS MATERIALIZED (
        SELECT id, document FROM guoman_private.documents
        WHERE collection='guoman_series' AND id>(p->>'after') COLLATE "C"
          AND document->>'platform' IN ('bilibili','tencent','youku')
        ORDER BY id COLLATE "C" LIMIT 200
      )
      SELECT jsonb_build_object(
        'documents',COALESCE((SELECT jsonb_agg(document ORDER BY id COLLATE "C") FROM page),'[]'::jsonb),
        'next_after',CASE WHEN (SELECT count(*) FROM page)=200
          THEN (SELECT id FROM page ORDER BY id COLLATE "C" DESC LIMIT 1) ELSE '' END
      ) INTO answer;
      RETURN answer;
    END;
    $fn$
  $ddl$;
  EXECUTE $ddl$
    CREATE FUNCTION guoman_private.find_series_by_url(p jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
    DECLARE d jsonb;
    BEGIN
      PERFORM guoman_private.assert_backend();
      IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR p - 'url' <> '{}'::jsonb
         OR jsonb_typeof(p->'url') IS DISTINCT FROM 'string'
         OR length(p->>'url') NOT BETWEEN 1 AND 2048 THEN
        RAISE EXCEPTION 'invalid catalog URL' USING ERRCODE='22023';
      END IF;
      SELECT document INTO d FROM guoman_private.documents
        WHERE collection='guoman_series' AND document->>'url'=p->>'url'
        ORDER BY id COLLATE "C" LIMIT 1;
      IF FOUND THEN RETURN jsonb_build_object('exists',true,'document',d); END IF;
      RETURN jsonb_build_object('exists',false);
    END;
    $fn$
  $ddl$;
  EXECUTE $ddl$ REVOKE ALL ON FUNCTION guoman_private.list_series_page(jsonb)
    FROM PUBLIC, anon, authenticated $ddl$;
  EXECUTE $ddl$ REVOKE ALL ON FUNCTION guoman_private.find_series_by_url(jsonb)
    FROM PUBLIC, anon, authenticated $ddl$;
  EXECUTE $ddl$
    CREATE FUNCTION guoman_private.ingest_series_batch(p jsonb) RETURNS jsonb
    LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $fn$
    DECLARE item jsonb; d jsonb; changed integer := 0; n integer;
    BEGIN
      PERFORM guoman_private.assert_backend();
      IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR p - ARRAY['items','update'] <> '{}'::jsonb
         OR jsonb_typeof(p->'items') IS DISTINCT FROM 'array'
         OR jsonb_array_length(p->'items') NOT BETWEEN 1 AND 100
         OR jsonb_typeof(p->'update') IS DISTINCT FROM 'boolean'
         OR octet_length(p::text)>262144 THEN
        RAISE EXCEPTION 'invalid catalog batch' USING ERRCODE='22023';
      END IF;
      IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
        RAISE EXCEPTION 'unsupported isolation' USING ERRCODE='25000';
      END IF;
      PERFORM set_config('lock_timeout','5s',true);
      PERFORM pg_advisory_xact_lock(20261011,197307);
      FOR item IN SELECT value FROM jsonb_array_elements(p->'items') LOOP
        IF jsonb_typeof(item) IS DISTINCT FROM 'object'
           OR (item->>'id') IS NULL OR (item->>'id') !~ '^[a-zA-Z0-9_-]{1,160}$'
           OR item->>'_id' IS DISTINCT FROM item->>'id'
           OR (item->>'checkedAt') IS NULL THEN
          RAISE EXCEPTION 'invalid catalog item' USING ERRCODE='22023';
        END IF;
        PERFORM (item->>'checkedAt')::timestamptz;
        INSERT INTO guoman_private.documents AS stored(collection,id,document)
        VALUES('guoman_series',item->>'id',item)
        ON CONFLICT(collection,id) DO NOTHING;
        GET DIAGNOSTICS n = ROW_COUNT;
        changed := changed+n;
        IF n=0 AND (p->>'update')::boolean THEN
          SELECT document INTO d FROM guoman_private.documents
            WHERE collection='guoman_series' AND id=item->>'id';
          IF (item->>'checkedAt')::timestamptz > (d->>'checkedAt')::timestamptz THEN
            UPDATE guoman_private.documents SET document=d || item
              WHERE collection='guoman_series' AND id=item->>'id';
            changed := changed+1;
          END IF;
        END IF;
      END LOOP;
      RETURN jsonb_build_object('changed',changed);
    END;
    $fn$
  $ddl$;
  EXECUTE $ddl$ REVOKE ALL ON FUNCTION guoman_private.ingest_series_batch(jsonb)
    FROM PUBLIC, anon, authenticated $ddl$;
END;
$migration$;
