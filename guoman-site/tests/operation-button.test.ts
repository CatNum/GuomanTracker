import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OperationButton } from '../components/operation-button.ts';

test('a temporary operation lock blocks clicks without applying unavailable styling', () => {
  const html = renderToStaticMarkup(createElement(OperationButton, { busy: true, 'aria-busy': true }, '正在取消…'));
  assert.match(html, /disabled=""/);
  assert.match(html, /data-busy-lock="true"/);
  assert.match(html, /aria-busy="true"/);
});

test('an unavailable action stays visually disabled during another operation', () => {
  const html = renderToStaticMarkup(createElement(OperationButton, { busy: true, disabled: true }, '上移'));
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, /data-busy-lock="true"/);
});

test('an idle available action remains enabled and preserves native button attributes', () => {
  const html = renderToStaticMarkup(createElement(OperationButton, { type: 'button', className: 'text-action', 'aria-label': '取消追番' }, '取消追番'));
  assert.doesNotMatch(html, /disabled=""|data-busy-lock="true"/);
  assert.match(html, /type="button"/);
  assert.match(html, /class="text-action"/);
  assert.match(html, /aria-label="取消追番"/);
});
