import { z } from 'zod';
import snapshot from '@/data/catalog.json';
import type { Anime } from '@/lib/catalog';
let retained:{expires:number;items:Anime[]}|null=null;
export async function GET(){
 const baseline=snapshot.items as Anime[];
 if(retained&&retained.expires>Date.now())return Response.json({items:retained.items,live:true});
 try{
  const r=await fetch('https://api.bilibili.com/pgc/web/timeline?types=4&before=6&after=6',{signal:AbortSignal.timeout(10000),headers:{'User-Agent':'GuomanTracker/1.0'}});
  if(!r.ok)throw new Error('timeline unavailable');
  const d=z.object({code:z.number(),result:z.array(z.object({episodes:z.array(z.object({season_id:z.number(),pub_ts:z.number(),title:z.string(),cover:z.string().optional(),pub_index:z.string().optional(),published:z.number().optional(),delay:z.number().optional()}))}))}).parse(await r.json());if(d.code!==0||!Array.isArray(d.result))throw new Error('invalid timeline');
  const events=new Map<string,Anime['events']>();const fresh=new Map<string,Anime>();
  for(const day of d.result){
   for(const e of day.episodes||[]){
    if(!Number.isSafeInteger(e.season_id)||!Number.isFinite(e.pub_ts)||typeof e.title!=='string')continue;
    const id=`bili-${e.season_id}`;const at=e.pub_ts*1000;
    const list=events.get(id)||[];list.push({at,label:String(e.pub_index||''),published:!!e.published,delayed:!!e.delay});events.set(id,list);
    const raw=String(e.cover||'').replace(/^http:/,'https:');const cover=raw.startsWith('https://i0.hdslb.com/')||raw.startsWith('https://i1.hdslb.com/')?raw:'';
    fresh.set(id,{id,title:e.title,platform:'bilibili',url:`https://www.bilibili.com/bangumi/play/ss${e.season_id}`,cover,status:'ongoing',episodes:String(e.pub_index||''),events:[],checkedAt:new Date().toISOString(),source:'https://www.bilibili.com/guochuang/'});
   }
  }
  const items=baseline.map(a=>a.platform==='bilibili'?{...a,events:events.get(a.id)||[],...(events.has(a.id)?{checkedAt:new Date().toISOString()}: {})}:a);
  const known=new Set(items.map(a=>a.id));for(const [id,a] of fresh){if(!known.has(id))items.push({...a,events:events.get(id)||[]})}
  retained={items,expires:Date.now()+10*60000};
  return Response.json({items,live:true},{headers:{'Cache-Control':'public, max-age=300'}});
 }catch{return Response.json({items:baseline,live:false},{headers:{'Cache-Control':'no-store'}})}
}
