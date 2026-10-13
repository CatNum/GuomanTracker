-- 对真实PG执行的回滚验证：不留下探针节目，不修改用户记录。
BEGIN;
DO LANGUAGE plpgsql $verify$
DECLARE item jsonb; response jsonb; current_doc jsonb;
BEGIN
  PERFORM guoman_private.assert_backend();
  IF EXISTS(SELECT 1 FROM guoman_private.documents WHERE collection='guoman_series' AND id='pg-catalog-verification') THEN
    RAISE EXCEPTION 'probe ID already exists';
  END IF;
  item := jsonb_build_object('id','pg-catalog-verification','_id','pg-catalog-verification',
    'title','验证节目','platform','bilibili','url','https://www.bilibili.com/bangumi/play/ss999999998',
    'checkedAt','2026-10-12T00:00:00Z');
  response := guoman_private.ingest_series_batch(jsonb_build_object('items',jsonb_build_array(item),'update',false));
  IF response->>'changed' <> '1' THEN RAISE EXCEPTION 'insert failed'; END IF;
  response := guoman_private.ingest_series_batch(jsonb_build_object('items',jsonb_build_array(item || '{"title":"不可覆盖"}'),'update',false));
  IF response->>'changed' <> '0' THEN RAISE EXCEPTION 'initial import overwrote existing record'; END IF;
  response := guoman_private.ingest_series_batch(jsonb_build_object('items',jsonb_build_array(item || '{"title":"新资料","checkedAt":"2026-10-13T00:00:00Z"}'),'update',true));
  IF response->>'changed' <> '1' THEN RAISE EXCEPTION 'newer update failed'; END IF;
  response := guoman_private.ingest_series_batch(jsonb_build_object('items',jsonb_build_array(item),'update',true));
  IF response->>'changed' <> '0' THEN RAISE EXCEPTION 'older data overwrote newer data'; END IF;
  response := guoman_private.find_series_by_url(jsonb_build_object('url',item->>'url'));
  IF response->'document'->>'id' <> 'pg-catalog-verification'
     OR response->'document'->>'title' <> '新资料' THEN RAISE EXCEPTION 'canonical lookup failed'; END IF;
  response := guoman_private.list_series_page('{"after":""}'::jsonb);
  IF jsonb_typeof(response->'documents') <> 'array' OR jsonb_array_length(response->'documents') > 200 THEN
    RAISE EXCEPTION 'bounded paging failed';
  END IF;
  IF has_function_privilege('anon','guoman_private.list_series_page(jsonb)','EXECUTE')
     OR has_function_privilege('authenticated','guoman_private.ingest_series_batch(jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'client role unexpectedly has SQL access';
  END IF;
END;
$verify$;
ROLLBACK;
