import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AnimeCollection, AnimeEntry, AnimeDisplayToggle } from '../components/anime-collection.ts';

test('both layouts preserve official links, metadata and page-owned actions', () => {
  for (const mode of ['list', 'grid'] as const) {
    const html = renderToStaticMarkup(createElement(AnimeCollection, { mode },
      createElement(AnimeEntry, {
        title: '测试国漫', cover: '', href: 'https://v.qq.com/test',
        platform: { name: '腾讯视频', color: '#53b9ff' },
        actions: createElement('button', { disabled: true }, '修改进度'),
      }, createElement('p', null, '已核验至 12 集'))));
    assert.match(html, new RegExp(`data-display-mode="${mode}"`));
    assert.match(html, /href="https:\/\/v.qq.com\/test"/);
    assert.match(html, /rel="noopener noreferrer"/);
    assert.match(html, /测试国漫/);
    assert.match(html, /腾讯视频/);
    assert.match(html, /已核验至 12 集/);
    assert.match(html, /<button disabled="">修改进度<\/button>/);
    assert.doesNotMatch(html, /<img/);
  }
});

test('display toggle exposes the selected layout to assistive technology', () => {
  const html = renderToStaticMarkup(createElement(AnimeDisplayToggle, { mode: 'list', onChange: () => {} }));
  assert.match(html, /role="group" aria-label="动漫展示形式"/);
  assert.match(html, /aria-pressed="true"[^>]*>[\s\S]*?列表/);
  assert.match(html, /aria-pressed="false"[^>]*>[\s\S]*?大图/);
});

test('entries preserve drag controls and status badges supplied by the library', () => {
  const html = renderToStaticMarkup(createElement(AnimeEntry, {
    title: '作品', cover: '/cover.jpg',
    leading: createElement('button', { draggable: true }, '调整优先级'),
    titleExtras: createElement('small', null, '已暂停'),
    'aria-label': '作品优先级',
  }));
  assert.match(html, /draggable="true"/);
  assert.match(html, /aria-label="作品优先级"/);
  assert.match(html, /已暂停/);
  assert.match(html, /loading="lazy"/);
});
