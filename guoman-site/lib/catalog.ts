import { isSupportedPlatform, SUPPORTED_PLATFORMS } from "../../cloudbase/shared/platform-support.mjs";

export { isSupportedPlatform, SUPPORTED_PLATFORMS };
export type Anime = {
  id: string; title: string; platform: string; url: string; cover: string;
  status: string; episodes: string; checkedAt: string; source: string;
  events: { at: number; label: string; published: boolean; delayed: boolean }[];
  days?: number[]; time?: string; schedule?: string;
  /** scheduleCheckedAt（排期核验时间）：避免新标题的核验时间延长旧排期有效期。 */
  scheduleCheckedAt?: string;
  latestEpisode?: number; monitoring?: 'queued'|'active'|'unsupported'|'error';
  metadataPending?: boolean;
  lastScanAt?: string; lastScanAttemptAt?: string; nextScanAt?: string; scanError?: string;
};
export const platforms: Record<string, {name:string; letter:string; color:string; home:string}> = {
  bilibili:{name:'哔哩哔哩',letter:'哔',color:'#fb7299',home:'https://www.bilibili.com/guochuang/'},
  tencent:{name:'腾讯视频',letter:'腾',color:'#53b9ff',home:'https://v.qq.com/channel/cartoon'},
  youku:{name:'优酷',letter:'优',color:'#38cbea',home:'https://www.youku.com/channel/webcomic'},
  iqiyi:{name:'爱奇艺',letter:'爱',color:'#71d867',home:'https://www.iqiyi.com/dongman/'},
  mgtv:{name:'芒果TV',letter:'芒',color:'#ffa544',home:'https://www.mgtv.com/'}
};
export const dayNames=['周日','周一','周二','周三','周四','周五','周六'];
export function chinaDay(at:number){return new Date(at+8*3600000).getUTCDay()}
export function chinaDate(at:number){return new Date(at+8*3600000).toISOString().slice(0,10)}
export function timeText(at:number){return new Date(at+8*3600000).toISOString().slice(11,16)}
export function validSchedule(a:Anime,now:number){return !!a.days?.length && !!a.time && now-Date.parse(a.scheduleCheckedAt??a.checkedAt)<30*86400000}
export function upcoming(a:Anime,now:number){
  const dated=a.events.filter(e=>e.at>=now&&!e.delayed).sort((x,y)=>x.at-y.at)[0];
  if(dated) return dated.at;
  if(!validSchedule(a,now))return null;
  const base=new Date(now+8*3600000);base.setUTCHours(0,0,0,0);
  const [h,m]=a.time!.split(':').map(Number);
  for(let i=0;i<8;i++){const at=base.getTime()+i*86400000+(h*60+m)*60000-8*3600000;if(at>=now&&a.days!.includes(chinaDay(at)))return at;}
  return null;
}
export function scheduleText(a:Anime,now:number){
  if(a.status==='finished')return '已完结';
  if(validSchedule(a,now))return a.schedule||`${a.days!.map(d=>dayNames[d]).join('、')} ${a.time}`;
  const next=upcoming(a,now);
  if(next)return `${chinaDate(next).slice(5).replace('-','月')}日 ${timeText(next)}`;
  return '排期待确认';
}
