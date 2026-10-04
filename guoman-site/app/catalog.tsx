'use client';
import { z } from 'zod';
import { useEffect, useMemo, useState } from 'react';
import { Play, Search, CalendarDays, Layers3, ExternalLink, Clock3, RefreshCw, ChevronLeft, ChevronRight, TvMinimal, X } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '@/components/ui/select';
import { platforms, chinaDay, chinaDate, dayNames, scheduleText, upcoming, validSchedule, type Anime } from '@/lib/catalog';
export default function Catalog({initial,checkedAt,embedded=false,onFollow,followed=[]}:{initial:Anime[];checkedAt:string;embedded?:boolean;onFollow?:(series:Anime)=>void;followed?:string[]}){
 const Content=embedded?'div':'main';
 const [items,setItems]=useState(initial);const [now,setNow]=useState(0);const [query,setQuery]=useState('');const [platform,setPlatform]=useState('all');const [status,setStatus]=useState('all');const [view,setView]=useState('all');const [day,setDay]=useState(-1);const [page,setPage]=useState(1);const [refresh,setRefresh]=useState(false);const [note,setNote]=useState('');
 useEffect(()=>{setNow(Date.now());const t=setInterval(()=>setNow(Date.now()),60000);return()=>clearInterval(t)},[]);
 async function reload(){setRefresh(true);setNote('');try{const r=await fetch('/api/catalog');if(!r.ok)throw new Error();const data=z.object({items:z.array(z.object({id:z.string(),title:z.string(),platform:z.string(),url:z.string().url(),cover:z.string(),status:z.string(),episodes:z.string(),checkedAt:z.string(),source:z.string(),events:z.array(z.object({at:z.number(),label:z.string(),published:z.boolean(),delayed:z.boolean()})),days:z.array(z.number()).optional(),time:z.string().optional(),schedule:z.string().optional()})),live:z.boolean()}).parse(await r.json());if(data.items)setItems(data.items);setNote(data.live?'已同步官方国创更新日历':'官方日历暂不可用，正在展示最近核验的收录');}catch{setNote('同步未完成，仍可浏览已收录的作品。')}finally{setRefresh(false)}}
 useEffect(()=>{void reload()},[]);
 useEffect(()=>{
  const context=(document as Document & {modelContext?:{registerTool:(tool:unknown,options:{signal:AbortSignal})=>unknown}}).modelContext;
  if(!context?.registerTool)return;
  const lifecycle=new AbortController();
  const input=z.object({query:z.string().max(100).default(''),platform:z.enum(['all','bilibili','tencent','youku','iqiyi','mgtv']).default('all')}).strict();
  try{void Promise.resolve(context.registerTool({
   name:'filter_guoman_catalog',title:'筛选国漫合集',description:'按名称和官方平台筛选当前国漫合集，并更新页面显示；不会打开播放链接。',
   inputSchema:{type:'object',properties:{query:{type:'string',maxLength:100},platform:{type:'string',enum:['all','bilibili','tencent','youku','iqiyi','mgtv']}},additionalProperties:false},
   annotations:{readOnlyHint:false,untrustedContentHint:true},
   async execute(raw:unknown){const value=input.parse(raw);setQuery(value.query);setPlatform(value.platform);setStatus('all');setView('all');setDay(-1);setPage(1);
    await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
    const matches=items.filter(a=>(value.platform==='all'||a.platform===value.platform)&&a.title.toLowerCase().includes(value.query.trim().toLowerCase()));
    return {total:matches.length,items:matches.slice(0,20).map(a=>({id:a.id,title:a.title,platform:a.platform,url:a.url}))};}
  },{signal:lifecycle.signal})).catch(()=>{});}catch{}
  return()=>lifecycle.abort();
 },[items]);
 const t=now||Date.parse(checkedAt);const today=chinaDay(t);const counts=Object.fromEntries(Object.keys(platforms).map(k=>[k,items.filter(a=>a.platform===k).length]));
 const scheduled=items.filter(a=>upcoming(a,t)!==null||a.events.some(e=>chinaDate(e.at)===chinaDate(t)));
 const filtered=useMemo(()=>items.filter(a=>{
  if(platform!=='all'&&a.platform!==platform)return false;
  if(query&&!a.title.toLowerCase().includes(query.trim().toLowerCase()))return false;
  if(status!=='all'&&a.status!==status)return false;
  if(view==='week'){
    const weekStart=Date.parse(chinaDate(t)+'T00:00:00+08:00')-((chinaDay(t)+6)%7)*86400000;const dates=a.events.filter(e=>e.at>=weekStart&&e.at<weekStart+7*86400000);
    if(!dates.length&&!validSchedule(a,t))return false;
    if(day!==-1&&!dates.some(e=>chinaDay(e.at)===day)&&!(validSchedule(a,t)&&a.days?.includes(day)))return false;
  }
  return true;
 }).sort((a,b)=>{
  const x=upcoming(a,t),y=upcoming(b,t);
  if(x!==null&&y!==null)return x-y;
  if(x!==null)return -1;if(y!==null)return 1;return 0;
 }),[items,platform,query,status,view,day,t]);
 const pages=Math.max(1,Math.ceil(filtered.length/18));const visible=filtered.slice((page-1)*18,page*18);
 function reset(){setPlatform('all');setStatus('all');setQuery('');setDay(-1);setPage(1)}
 const dateLabel=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'long',day:'numeric',weekday:'long'}).format(t);
 return <div className={embedded?'embedded-catalog':'site-shell'}>
  {!embedded&&<header className="site-header"><a className="brand" href="/" aria-label="国漫追更首页"><span className="brand-icon"><Play size={19} fill="currentColor"/></span><b>国漫<span>追更</span></b><span className="brand-en">GUOMAN TRACKER</span></a><div className="header-right"><span className="header-note">一个入口，找到你的国漫</span><a href="#catalog" className="header-link"><Layers3 size={16}/>浏览合集</a></div></header>}
  <Content>
   <div className="intro"><div><div className="eyebrow"><span/>国漫更新指南</div><h1>好故事，<span>不漏更。</span></h1><p>汇集各平台国漫与更新安排，直达官方播放。</p></div><div className="date-box"><CalendarDays size={19}/><div><strong>{dateLabel}</strong><span>北京时间 · UTC+8</span></div></div></div>
   <section className="overview" aria-label="收录概况"><div><span>已收录作品</span><strong>{items.length.toLocaleString()}<small>部</small></strong></div><div><span>有更新安排</span><strong>{scheduled.length}<small>部</small></strong></div><div><span>平台入口</span><strong>{Object.keys(platforms).length.toString().padStart(2,'0')}<small>个</small></strong></div><div className="overview-last"><TvMinimal size={23}/><p>只记录更新信息<small>观看体验，留给官方平台</small></p></div></section>
   <section id="catalog" className="catalog-section">
    <Tabs value={view} onValueChange={v=>{setView(v);setPage(1);setDay(-1)}}>
     <div className="section-bar"><TabsList className="view-tabs" variant="line"><TabsTrigger value="all"><Layers3 size={17}/>国漫合集</TabsTrigger><TabsTrigger value="week"><CalendarDays size={17}/>本周更新</TabsTrigger></TabsList><button className="sync-button" onClick={reload} disabled={refresh}><RefreshCw size={14} className={refresh?'spinning':''}/>{refresh?'同步中':'同步日历'}</button></div>
     <div className="platform-row" aria-label="筛选平台"><button className={platform==='all'?'platform active':'platform'} onClick={()=>{setPlatform('all');setPage(1)}}>全部平台<span>{items.length}</span></button>{Object.entries(platforms).map(([key,p])=><button key={key} className={platform===key?'platform active':'platform'} onClick={()=>{setPlatform(key);setPage(1)}}><i style={{color:p.color,background:p.color+'18'}}>{p.letter}</i>{p.name}<span>{counts[key]}</span></button>)}</div>
     {view==='week'&&<div className="week-row"><button className={day===-1?'selected':''} onClick={()=>{setDay(-1);setPage(1)}}>全周</button>{[1,2,3,4,5,6,0].map(d=><button key={d} className={day===d?'selected':''} onClick={()=>{setDay(d);setPage(1)}}>{dayNames[d]}{today===d&&<small>今天</small>}</button>)}</div>}
     <div className="filter-row"><label className="search-box"><Search size={18}/><input value={query} onChange={e=>{setQuery(e.target.value);setPage(1)}} placeholder="搜索国漫名称…" aria-label="搜索国漫名称"/>{query&&<button aria-label="清除搜索" onClick={()=>{setQuery('');setPage(1)}}><X size={16}/></button>}</label><Select value={status} onValueChange={v=>{setStatus(v);setPage(1)}}><SelectTrigger className="status-select" aria-label="作品状态"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="all">全部状态</SelectItem><SelectItem value="ongoing">连载中</SelectItem><SelectItem value="finished">已完结</SelectItem><SelectItem value="unknown">状态待核验</SelectItem></SelectContent></Select><span className="result-count">共 {filtered.length} 部</span></div>
     <p className="live-note" role="status">{note||'收录与排期以官方页面为准'}</p>
     {['all','week'].map(v=><TabsContent value={v} key={v}><div className="anime-grid">{visible.map(a=>{const p=platforms[a.platform];const next=upcoming(a,t);const isToday=next&&chinaDate(next)===chinaDate(t);return <article key={a.id} className="anime-card"><a href={a.url} target="_blank" rel="noopener noreferrer" className="cover-link" aria-label={`前往${p.name}观看${a.title}`}><div className="cover"><img src={a.cover} alt={a.title+'官方封面'} loading="lazy" referrerPolicy="no-referrer" onError={e=>{e.currentTarget.style.display='none'}}/><span className="cover-fallback">{a.title}</span><span className="platform-badge" style={{color:p.color}}>{p.name}</span><span className="episode-label">{a.episodes||'前往平台查看'}</span><span className="cover-play"><Play fill="currentColor" size={21}/></span></div></a><div className="card-body"><h2 title={a.title}>{a.title}</h2><div title={scheduleText(a,t)} className={'schedule '+(isToday?'today':'')}><Clock3 size={14}/><span>{scheduleText(a,t)}</span>{isToday&&<b>今日</b>}</div><div className="card-bottom"><a href={a.url} target="_blank" rel="noopener noreferrer">官方播放<ExternalLink size={13}/></a><span>{a.status==='finished'?'已完结':a.status==='ongoing'?'连载中':'状态待核验'}</span></div></div>{onFollow&&<button className="follow-button" disabled={followed.includes(a.id)} onClick={()=>onFollow(a)}>{followed.includes(a.id)?"已追番":"＋ 加入追番"}</button>}</article>})}</div>{!visible.length&&<div className="empty-state"><Search size={30}/><h2>{platform!=='all'&&counts[platform]===0?'该平台作品正在补充':'没有找到符合条件的国漫'}</h2><p>可以查看平台官方目录，或调整筛选条件。</p><button onClick={reset}>清除筛选</button>{platform!=='all'&&<a href={platforms[platform].home} target="_blank" rel="noopener noreferrer">访问{platforms[platform].name}官方目录<ExternalLink size={14}/></a>}</div>}</TabsContent>)}
    </Tabs>
    {pages>1&&<nav className="pagination" aria-label="作品分页"><button aria-label="上一页" disabled={page===1} onClick={()=>setPage(x=>x-1)}><ChevronLeft size={17}/></button><span>第 {page} / {pages} 页</span><button aria-label="下一页" disabled={page===pages} onClick={()=>setPage(x=>x+1)}><ChevronRight size={17}/></button></nav>}
   </section>
   <section className="source-note"><div><span className="source-label">收录说明</span><p>已接入哔哩哔哩国创索引与腾讯、优酷、爱奇艺的部分国漫；芒果TV收录正在补充。更新时间为官方已公布排期，具体上线、会员与地区权益以平台为准。</p><p>手机点击官方播放链接可由平台尝试唤起 App；是否唤起及自动播放取决于设备和平台支持。</p></div><span>目录核验：{chinaDate(Date.parse(checkedAt))}</span></section>
  </Content>{!embedded&&<footer><a className="footer-brand" href="/">国漫追更 <span>GUOMAN TRACKER</span></a><span>聚合信息 · 官方观看 · 不存储音视频</span></footer>}
 </div>
}
