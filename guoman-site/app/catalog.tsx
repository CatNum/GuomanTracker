'use client';
import { z } from 'zod';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Play, Search, CalendarDays, Layers3, ExternalLink, Clock3, RefreshCw, ChevronLeft, ChevronRight, TvMinimal, X } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '@/components/ui/select';
import Link from 'next/link';
import { OperationButton } from '@/components/operation-button';
import { AnimeCollection, AnimeEntry, AnimeDisplayToggle } from '@/components/anime-collection';
import { useAnimeDisplayMode } from '@/hooks/use-anime-display-mode';
import { platforms, chinaDay, chinaDate, dayNames, scheduleText, upcoming, isSupportedPlatform, SUPPORTED_PLATFORMS, type Anime } from '@/lib/catalog';
import { followedCatalog } from '@/lib/personal-catalog';
import { weeklySchedule, unverifiedSchedule } from '@/lib/weekly-schedule';
import { paginateCatalog } from '@/lib/catalog-pagination';
import { catalogTransport, loadCatalogData } from '@/lib/catalog-transport';
export default function Catalog({initial,checkedAt,embedded=false,presentation='catalog',personalSeries=[],onFollow,followed=[],followBusy=false,followBlocked=false,pendingFollowId='',accountReady=true,accountKey='',onLogin,onCatalogSync}:{initial:Anime[];checkedAt:string;embedded?:boolean;presentation?:'catalog'|'calendar';personalSeries?:Anime[];onFollow?:(series:Anime)=>void;followed?:string[];followBusy?:boolean;followBlocked?:boolean;pendingFollowId?:string;accountReady?:boolean;accountKey?:string;onLogin?:()=>void;onCatalogSync?:(items:Anime[])=>void}){
 const Content=embedded?'div':'main';
 const [displayMode,setDisplayMode]=useAnimeDisplayMode('grid');
 const [items,setItems]=useState(initial.filter(a=>isSupportedPlatform(a.platform)));const [now,setNow]=useState(0);const [query,setQuery]=useState('');const [platform,setPlatform]=useState('all');const [status,setStatus]=useState('all');const [view,setView]=useState(presentation==='calendar'?'week':'all');const [day,setDay]=useState<number|null>(null);const [page,setPage]=useState(1);const [refresh,setRefresh]=useState(false);const [note,setNote]=useState('');const requestId=useRef(0);const accountToken=useRef<{active:boolean}|null>(null);
 const scopedItems=useMemo(()=>presentation==='calendar'?(accountReady?followedCatalog(items,personalSeries,followed):[]):items,[items,personalSeries,followed,presentation,accountReady]);
 useLayoutEffect(()=>{const token={active:true};accountToken.current=token;return()=>{token.active=false}},[accountReady,accountKey]);
 useEffect(()=>{const initial=window.setTimeout(()=>setNow(Date.now()),0);const t=setInterval(()=>setNow(Date.now()),60000);return()=>{clearTimeout(initial);clearInterval(t)}},[]);
 async function reload(){
  const id=++requestId.current;const token=accountToken.current;const isCurrent=()=>id===requestId.current&&token?.active===true;setRefresh(true);setNote('');
  try{
   const data=await loadCatalogData({transport:catalogTransport,accountReady,call:async(action,payload)=>await import('@/lib/cloudbase-client').then(({cloudCall})=>cloudCall(action,payload))});
   if(!isCurrent()||!data)return;
   if(data.live){const synced=data.items.filter(a=>isSupportedPlatform(a.platform));setItems(synced);onCatalogSync?.(synced);}
   setNote(data.live?'已同步官方国创更新日历':'官方日历暂不可用，正在展示最近核验的收录');
  }catch{if(isCurrent())setNote('同步未完成，仍可浏览已收录的作品。');}
  finally{if(isCurrent())setRefresh(false)}
 }
 function syncCalendar(){
  if(catalogTransport==='cloudbase'&&!accountReady){setNote('已展示收录目录，请登录邮箱账号后同步官方日历。');onLogin?.();return;}
  void reload();
 }
 useEffect(()=>{
  const generationId=++requestId.current;
  if(catalogTransport==='cloudbase'&&!accountReady){
   const prompt=window.setTimeout(()=>{if(generationId===requestId.current){setRefresh(false);setNote('已收录目录，登录后可同步官方日历')}},0);
   return()=>{clearTimeout(prompt)};
  }
  const initial=window.setTimeout(()=>{void reload()},0);
  return()=>{clearTimeout(initial)};
  // reload reads the current account readiness at the moment the effect runs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[accountReady,accountKey]);
 useEffect(()=>{
  const context=(document as Document & {modelContext?:{registerTool:(tool:unknown,options:{signal:AbortSignal})=>unknown}}).modelContext;
  if(!context?.registerTool)return;
  const lifecycle=new AbortController();
  const input=z.object({query:z.string().max(100).default(''),platform:z.enum(['all',...SUPPORTED_PLATFORMS]).default('all')}).strict();
  try{void Promise.resolve(context.registerTool({
   name:'filter_guoman_catalog',title:'筛选国漫合集',description:'按名称和官方平台筛选当前国漫合集，并更新页面显示；不会打开播放链接。',
   inputSchema:{type:'object',properties:{query:{type:'string',maxLength:100},platform:{type:'string',enum:['all',...SUPPORTED_PLATFORMS]}},additionalProperties:false},
   annotations:{readOnlyHint:false,untrustedContentHint:true},
   async execute(raw:unknown){const value=input.parse(raw);setQuery(value.query);setPlatform(value.platform);setStatus('all');setView(presentation==='calendar'?'week':'all');setDay(null);setPage(1);
    await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
    const matches=scopedItems.filter(a=>(value.platform==='all'||a.platform===value.platform)&&a.title.toLowerCase().includes(value.query.trim().toLowerCase()));
    return {total:matches.length,items:matches.slice(0,20).map(a=>({id:a.id,title:a.title,platform:a.platform,url:a.url}))};}
  },{signal:lifecycle.signal})).catch(()=>{});}catch{}
  return()=>lifecycle.abort();
 },[scopedItems,presentation]);
 const t=now||Date.parse(checkedAt);const today=chinaDay(t);const selectedDay=day??today;const counts=Object.fromEntries(Object.keys(platforms).map(k=>[k,scopedItems.filter(a=>a.platform===k).length]));
 const scheduled=items.filter(a=>upcoming(a,t)!==null||a.events.some(e=>chinaDate(e.at)===chinaDate(t)));
 const calendarWeek=useMemo(()=>weeklySchedule(scopedItems,t),[scopedItems,t]);
 const pendingSchedules=useMemo(()=>unverifiedSchedule(scopedItems,t),[scopedItems,t]);
 const weeklyIds=useMemo(()=>new Set(calendarWeek.filter(d=>selectedDay===-1||d.day===selectedDay).flatMap(d=>d.entries.map(e=>e.series.id))),[calendarWeek,selectedDay]);
 const filtered=useMemo(()=>scopedItems.filter(a=>{
  if(platform!=='all'&&a.platform!==platform)return false;
  if(query&&!a.title.toLowerCase().includes(query.trim().toLowerCase()))return false;
  if(status!=='all'&&a.status!==status)return false;
  if(view==='week'&&!weeklyIds.has(a.id))return false;
  return true;
 }).sort((a,b)=>{
  const x=upcoming(a,t),y=upcoming(b,t);
  if(x!==null&&y!==null)return x-y;
  if(x!==null)return -1;if(y!==null)return 1;return 0;
 }),[scopedItems,platform,query,status,view,weeklyIds,t]);
 const {pages,effectivePage,visible,previousPage,nextPage}=paginateCatalog(filtered,page,18);
 function reset(){setPlatform('all');setStatus('all');setQuery('');setDay(null);setPage(1)}
 const dateLabel=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'long',day:'numeric',weekday:'long'}).format(t);
 return <div className={embedded?'embedded-catalog':'site-shell'}>
  {!embedded&&<header className="site-header"><Link className="brand" href="/" aria-label="国漫追更首页"><span className="brand-icon"><Play size={19} fill="currentColor"/></span><b>国漫<span>追更</span></b><span className="brand-en">GUOMAN TRACKER</span></Link><div className="header-right"><span className="header-note">一个入口，找到你的国漫</span><a href="#catalog" className="header-link"><Layers3 size={16}/>浏览合集</a></div></header>}
  <Content>
   <div className="intro"><div><div className="eyebrow"><span/>{presentation==='calendar'?'我的追番排期':'国漫更新指南'}</div><h1>{presentation==='calendar'?'新番周历':'国漫合集'}</h1><p>{presentation==='calendar'?'仅展示已追番作品的本周排期，全部更新请查看国漫合集。':'汇集各平台国漫与更新安排，直达官方播放。'}</p>
    {presentation==='calendar'&&<p className="calendar-verification-note"><span>排期待核验的番剧不展示在新番周历中。</span>{SUPPORTED_PLATFORMS.map(key=><span className="calendar-verification-count" key={key}>{platforms[key].name}待核验 {pendingSchedules.filter(series=>series.platform===key).length} 部</span>)}</p>}
   </div><div className="date-box"><CalendarDays size={19}/><div><strong>{dateLabel}</strong><span>北京时间 · UTC+8</span></div></div></div>
   {presentation!=='calendar'&&<section className="overview" aria-label="收录概况"><div><span>已收录作品</span><strong>{items.length.toLocaleString()}<small>部</small></strong></div><div><span>有更新安排</span><strong>{scheduled.length}<small>部</small></strong></div><div><span>可用平台</span><strong>{SUPPORTED_PLATFORMS.length.toString().padStart(2,'0')}<small>个</small></strong></div><div className="overview-last"><TvMinimal size={23}/><p>只记录更新信息<small>观看体验，留给官方平台</small></p></div></section>}
   <section id="catalog" className="catalog-section">
    <Tabs value={view} onValueChange={v=>{setView(v);setPage(1);setDay(null)}}>
     <div className="section-bar">{presentation==='calendar'?<div className="calendar-week-label"><CalendarDays size={17}/>{calendarWeek[0].date} — {calendarWeek[6].date}<span>北京时间</span></div>:<TabsList className="view-tabs" variant="line"><TabsTrigger value="all"><Layers3 size={17}/>国漫合集</TabsTrigger><TabsTrigger value="week"><CalendarDays size={17}/>本周更新</TabsTrigger></TabsList>}<OperationButton className="sync-button" onClick={syncCalendar} busy={refresh} aria-busy={refresh}><RefreshCw size={14} className={refresh?'spinning':''}/>{refresh?'同步中':'同步日历'}</OperationButton></div>
     <div className="platform-row" aria-label="筛选平台"><button className={platform==='all'?'platform active':'platform'} onClick={()=>{setPlatform('all');setPage(1)}}>全部平台<span>{scopedItems.length}</span></button>{Object.entries(platforms).map(([key,p])=><button key={key} disabled={!isSupportedPlatform(key)} title={isSupportedPlatform(key)?undefined:'暂不支持该平台'} className={`${platform===key?'platform active':'platform'} ${isSupportedPlatform(key)?'':'unsupported-platform'}`} onClick={()=>{setPlatform(key);setPage(1)}}><i style={{color:p.color,background:p.color+'18'}}>{p.letter}</i>{p.name}<span>{counts[key]}</span></button>)}</div>
     {view==='week'&&<div className="week-row"><button className={selectedDay===-1?'selected':''} onClick={()=>{setDay(-1);setPage(1)}}>全周</button>{[1,2,3,4,5,6,0].map(d=><button key={d} className={selectedDay===d?'selected':''} onClick={()=>{setDay(d);setPage(1)}}>{dayNames[d]}{today===d&&<small>今天</small>}</button>)}</div>}
     <div className="filter-row"><label className="search-box"><Search size={18}/><input value={query} onChange={e=>{setQuery(e.target.value);setPage(1)}} placeholder="搜索国漫名称…" aria-label="搜索国漫名称"/>{query&&<button aria-label="清除搜索" onClick={()=>{setQuery('');setPage(1)}}><X size={16}/></button>}</label><Select value={status} onValueChange={v=>{setStatus(v);setPage(1)}}><SelectTrigger className="status-select" aria-label="作品状态"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="all">全部状态</SelectItem><SelectItem value="ongoing">连载中</SelectItem><SelectItem value="finished">已完结</SelectItem><SelectItem value="unknown">状态待核验</SelectItem></SelectContent></Select><span className="result-count">共 {filtered.length} 部</span></div>
     <div className="catalog-display-toolbar"><p className="live-note" role="status">{note||'收录与排期以官方页面为准'}</p><AnimeDisplayToggle mode={displayMode} onChange={setDisplayMode}/></div>
     {(presentation==='calendar'?['week']:['all','week']).map(v=><TabsContent value={v} key={v}><AnimeCollection mode={displayMode}>{visible.map(a=>{
      const p=platforms[a.platform];const next=upcoming(a,t);const isToday=next!==null&&chinaDate(next)===chinaDate(t);
      return <AnimeEntry key={a.id} title={a.title} cover={a.cover} href={a.url} platform={p} coverLabel={a.episodes||'前往平台查看'}
       actions={onFollow&&presentation!=='calendar'&&<OperationButton className="follow-button" busy={followBusy} disabled={followBlocked||followed.includes(a.id)} aria-busy={pendingFollowId===a.id} onClick={()=>onFollow(a)}>{pendingFollowId===a.id?"正在加入…":followed.includes(a.id)?"已追番":"＋ 加入追番"}</OperationButton>}>
       <div title={scheduleText(a,t)} className={'schedule '+(isToday?'today':'')}><Clock3 size={14}/><span>{scheduleText(a,t)}</span>{isToday&&<b>今日</b>}</div>
       <div className="anime-entry-catalog-meta"><span>{p.name}</span><span>{a.episodes||'集数待核验'}</span><span>{a.status==='finished'?'已完结':a.status==='ongoing'?'连载中':'状态待核验'}</span><a href={a.url} target="_blank" rel="noopener noreferrer">官方播放<ExternalLink size={13}/></a></div>
      </AnimeEntry>;
     })}</AnimeCollection>{!visible.length&&<div className="empty-state"><Search size={30}/><h2>{presentation==='calendar'?(!accountReady?'登录后查看你的新番周历':!followed.length?'还没有追番作品':'本周暂无符合条件的追番排期'):platform!=='all'&&counts[platform]===0?'该平台作品正在补充':'没有找到符合条件的国漫'}</h2><p>{presentation==='calendar'?'在国漫合集中加入追番，这里只展示你的本周更新。':'可以查看平台官方目录，或调整筛选条件。'}</p>{presentation==='calendar'&&!accountReady&&<button onClick={onLogin}>邮箱登录</button>}<button onClick={reset}>清除筛选</button>{platform!=='all'&&<a href={platforms[platform].home} target="_blank" rel="noopener noreferrer">访问{platforms[platform].name}官方目录<ExternalLink size={14}/></a>}</div>}</TabsContent>)}
    </Tabs>
    {pages>1&&<nav className="pagination" aria-label="作品分页"><button aria-label="上一页" disabled={previousPage===null} onClick={()=>setPage(previousPage ?? effectivePage)}><ChevronLeft size={17}/></button><span>第 {effectivePage} / {pages} 页</span><button aria-label="下一页" disabled={nextPage===null} onClick={()=>setPage(nextPage ?? effectivePage)}><ChevronRight size={17}/></button></nav>}
   </section>
   <section className="source-note"><div><span className="source-label">收录说明</span><p>当前仅开放哔哩哔哩国创索引与腾讯、优酷节目。爱奇艺和芒果TV暂不可用。更新时间以官方公布排期为准，具体上线、会员与地区权益以平台为准。</p><p>手机点击官方播放链接可由平台尝试唤起 App；是否唤起及自动播放取决于设备和平台支持。</p></div><span>目录核验：{chinaDate(Date.parse(checkedAt))}</span></section>
  </Content>{!embedded&&<footer><Link className="footer-brand" href="/">国漫追更 <span>GUOMAN TRACKER</span></Link><span>聚合信息 · 官方观看 · 不存储音视频</span></footer>}
 </div>
}
