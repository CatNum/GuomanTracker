import { createElement as h, type ComponentProps, type ReactNode } from 'react';
import { LayoutGrid, List, ListVideo, Play } from 'lucide-react';

/** AnimeDisplayMode（动漫展示形式）：列表或大图，共用同一份作品与业务操作。 */
export type AnimeDisplayMode = 'list' | 'grid';

/** AnimeDisplayToggle（展示切换按钮）：只通知选择结果，不管理页面筛选或业务状态。 */
export function AnimeDisplayToggle({ mode, onChange }: {
  mode: AnimeDisplayMode; onChange: (mode: AnimeDisplayMode) => void;
}) {
  return h('div', { className: 'anime-display-toggle', role: 'group', 'aria-label': '动漫展示形式' },
    ...([['list', '列表', List], ['grid', '大图', LayoutGrid]] as const).map(([value, label, Icon]) =>
      h('button', { key: value, type: 'button', 'aria-pressed': mode === value, onClick: () => onChange(value) },
        h(Icon, { size: 15, 'aria-hidden': true }), label)));
}

/** AnimeCollection（动漫集合）：统一布局容器，排序、分页与空态仍由调用页面决定。 */
export function AnimeCollection({ mode, children }: { mode: AnimeDisplayMode; children?: ReactNode }) {
  return h('div', { className: `anime-collection anime-collection-${mode}`, 'data-display-mode': mode }, children);
}

type EntryProps = Omit<ComponentProps<'article'>, 'title'> & {
  title: string;
  cover?: string;
  href?: string;
  platform?: { name: string; color: string };
  coverLabel?: string;
  titleExtras?: ReactNode;
  /** leading（前置操作插槽）：供追番页面放置拖动排序手柄。 */
  leading?: ReactNode;
  /** actions（业务操作插槽）：由页面提供追番、进度等操作，展示模块不依赖账号或接口。 */
  actions?: ReactNode;
};

/** AnimeEntry（动漫展示项）：列表与大图复用封面、标题、内容和操作，只通过容器样式切换。 */
export function AnimeEntry({ title, cover, href, platform, coverLabel, titleExtras, leading, actions, children, className = '', ...props }: EntryProps) {
  const poster = h('div', { className: 'anime-entry-poster' },
    h('span', { className: 'anime-entry-fallback', 'aria-hidden': true }, h(ListVideo, { size: 28 })),
    cover && h('img', { key: cover, src: cover, alt: `${title}官方封面`, loading: 'lazy', referrerPolicy: 'no-referrer', onError: (event) => { event.currentTarget.style.display = 'none'; } }),
    platform && h('span', { className: 'anime-entry-platform', style: { color: platform.color } }, platform.name),
    coverLabel && h('span', { className: 'anime-entry-cover-label' }, coverLabel),
    href && h('span', { className: 'anime-entry-play', 'aria-hidden': true }, h(Play, { size: 21, fill: 'currentColor' })));
  return h('article', { ...props, className: `anime-entry ${className}`.trim() },
    leading && h('div', { className: 'anime-entry-leading' }, leading),
    href ? h('a', { className: 'anime-entry-cover', href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `前往${platform?.name || '官方平台'}观看${title}` }, poster)
      : h('div', { className: 'anime-entry-cover' }, poster),
    h('div', { className: 'anime-entry-body' }, h('h2', { title }, title, titleExtras), children),
    actions && h('div', { className: 'anime-entry-actions' }, actions));
}
