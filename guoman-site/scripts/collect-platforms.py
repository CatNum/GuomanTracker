"""补充官方平台频道中的国漫元数据；仅请求网页，不请求音视频。"""
import pathlib,json,re,datetime,urllib.request,concurrent.futures,html
from html.parser import HTMLParser
ROOT=pathlib.Path(__file__).resolve().parent.parent
STAMP=datetime.datetime.now(datetime.timezone.utc).isoformat()
def get(url):return urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0'}),timeout=25).read().decode()
def base(key,title,platform,url,cover='',status='unknown',episodes='',source=''):
 return dict(id=key,title=title,platform=platform,url=url,cover=cover,status=status,episodes=episodes,events=[],checkedAt=STAMP,source=source or url)
class YoukuParser(HTMLParser):
 def __init__(self):super().__init__();self.a=None;self.items={}
 def handle_starttag(self,t,attrs):
  d=dict(attrs)
  if t=='a':self.a=d
  if t!='img' or not self.a:return
  a=self.a;src=d.get('src','');url=a.get('href','');label=a.get('aria-label','')
  if 'youku.com/video?s=' not in url or 'liangcang' not in src:return
  title=re.sub(r'^(独播|VIP|免费试看|逐集限免|全集限免|预告)\s*','',label)
  ep=re.match(r'(更新至\d+话|\d+话全)\s*',title)
  if ep:title=title[ep.end():]
  # 官方频道同时包含海外作品，按已核验的国产作品名单收录。
  names=['沧元图','光阴之外','东大高武学院','一斩苍穹','师兄啊师兄','云深不知梦','神墓','开心锤锤','邪魔墨然','百炼成神','山海经密码','仙武传','楚乌','上城之下']
  if not any(title.startswith(n) for n in names):return
  sid=re.search(r'[?&]s=([^&]+)',url).group(1)
  key='youku-'+sid
  if key in self.items and 'resize,w_352' not in src:return
  self.items[key]=base(key,title,'youku','https:'+url.split('&')[0],src,'finished' if ep and '全' in ep[0] else 'ongoing' if ep else 'unknown',ep[0] if ep else '待播','https://www.youku.com/ku/webcomic/')
 def handle_endtag(self,t):
  if t=='a':self.a=None
p=YoukuParser();p.feed(get('https://www.youku.com/ku/webcomic/'))
for a in p.items.values():
 if a['title']=='沧元图':a.update(days=[5,6],time='10:00',schedule='周五10:00 SVIP / 周六10:00 VIP')
 if a['title']=='师兄啊师兄':a.update(days=[3,4],time='10:00',schedule='周三10:00 SVIP / 周四10:00 VIP')
 if a['title']=='光阴之外':a.update(days=[6,0],time='10:00',schedule='周六10:00 SVIP / 周日10:00 VIP')
s=get('https://v.qq.com/channel/cartoon')
# 名称、封面和 cover ID 来自同一个官方频道节目对象。
for match in re.finditer(r'mzTitle:"([^"]+)"',s):
 title=match[1];chunk=s[max(0,match.start()-1600):match.end()]
 pics=re.findall(r'(https://vcover-hz-pic\.puui\.qpic\.cn/vcover_hz_pic/0/([a-z0-9]+?)(?:\d{13})/0[^" ]*)',chunk)
 if not pics:continue
 cover,cid=pics[-1];key='tencent-'+cid
 if key not in p.items:p.items[key]=base(key,title,'tencent',f'https://v.qq.com/x/cover/{cid}.html',cover,source='https://v.qq.com/channel/cartoon')
iqiyi=[('大主宰年番','1fr4mggsp0t'),('逆天邪神年番','2e4kgxtarw5'),('择日飞升','26rzlsl1999'),('神武天尊','z0ninzd33p'),('神奇日历','m8fxrscgr9')]
def iq(entry):
 title,code=entry;url=f'https://www.iqiyi.com/a_{code}.html';s=get(url)
 image=re.search(r'<meta itemprop="image" content="([^"]+)"',s)
 cover=('https:'+image[1] if image and image[1].startswith('//') else image[1] if image else '')
 ep=re.search(r'（(更新至\s*\d+\s*集\s*/\s*共\d+集|共\d+集)）',s)
 sched=re.search(r'data-widget="album-update-strategy"[^>]*>([^<]+)',s)
 text=html.unescape(sched[1]).strip() if sched else ''
 a=base('iqiyi-'+code,title,'iqiyi',url,cover,'ongoing' if ep and '更新至' in ep[1] else 'unknown',ep[1] if ep else '')
 # 页面排期中明确的周几和时刻；未知排期保持空值。
 daymap={'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'日':0,'天':0}
 days=[daymap[x] for x in re.findall(r'周([一二三四五六日天])',text)]
 time=re.search(r'(\d{1,2}):(\d{2})',text)
 if days and time:a.update(days=days,time=f'{int(time[1]):02d}:{time[2]}',schedule=text)
 if title=='神武天尊' and not text:a.update(status='finished',episodes='24集全')
 return a
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
 for a in pool.map(iq,iqiyi):p.items[a['id']]=a
path=ROOT/'data/catalog.json';data=json.loads(path.read_text());known={a['id']:a for a in data['items']}
known.update(p.items);data['items']=list(known.values());data['checkedAt']=STAMP;path.write_text(json.dumps(data,ensure_ascii=False,separators=(',',':')))
from collections import Counter
print(json.dumps(dict(Counter(a['platform'] for a in data['items']))))
