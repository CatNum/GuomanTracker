"""从官方目录采集节目元数据，不请求或保存音视频内容。"""
import json, urllib.request, concurrent.futures, datetime, pathlib, re, html
ROOT=pathlib.Path(__file__).resolve().parent.parent
STAMP=datetime.datetime.now(datetime.timezone.utc).isoformat()
def get(url):
    req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0'})
    return urllib.request.urlopen(req,timeout=25).read().decode()
def page(n):
    d=json.loads(get(f'https://api.bilibili.com/pgc/season/index/result?season_type=4&type=1&page={n}&pagesize=200&order=3&sort=0'))
    if d['code']!=0: raise RuntimeError(f'目录页 {n} 返回 {d["code"]}')
    return d['data']
def collect(limit=None):
    first=page(1); count=(first['total']+199)//200
    pages=[first]
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        pages += list(pool.map(page,range(2,(min(count,limit) if limit else count)+1)))
    timeline=json.loads(get('https://api.bilibili.com/pgc/web/timeline?types=4&before=6&after=6'))
    if timeline['code']!=0: raise RuntimeError('更新日历读取失败')
    events={}
    for day in timeline['result']:
        for e in day['episodes']:
            events.setdefault(e['season_id'],[]).append({'at':e['pub_ts']*1000,'label':e['pub_index'],'published':bool(e['published']),'delayed':bool(e['delay'])})
    records={}
    for p in pages:
        for e in p['list']:
            records[f'bili-{e["season_id"]}']={'id':f'bili-{e["season_id"]}','title':e['title'],'platform':'bilibili','url':e['link'],'cover':e['cover'].replace('http:','https:'),'status':'finished' if e['is_finish'] else 'ongoing','episodes':e['index_show'],'events':events.get(e['season_id'],[]),'checkedAt':STAMP,'source':'https://www.bilibili.com/guochuang/index/'}
    for day in timeline['result']:
        for e in day['episodes']:
            key=f'bili-{e["season_id"]}'
            if key not in records:
                records[key]={'id':key,'title':e['title'],'platform':'bilibili','url':f'https://www.bilibili.com/bangumi/play/ss{e["season_id"]}','cover':e['cover'].replace('http:','https:'),'status':'ongoing','episodes':e['pub_index'],'events':events[e['season_id']],'checkedAt':STAMP,'source':'https://www.bilibili.com/guochuang/'}
    old=ROOT/'data/catalog.json'
    if old.exists():
        for e in json.loads(old.read_text())['items']:
            if e['platform']!='bilibili':records[e['id']]=e
    result={'checkedAt':STAMP,'bilibiliTotal':first['total'],'items':list(records.values())}
    old.write_text(json.dumps(result,ensure_ascii=False,separators=(',',':')))
    print(json.dumps({'items':len(records),'bilibiliTotal':first['total']}))
if __name__=='__main__':
    import sys
    collect(int(sys.argv[1]) if len(sys.argv)>1 else None)
