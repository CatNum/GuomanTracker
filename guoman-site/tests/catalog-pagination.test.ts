import test from 'node:test';
import assert from 'node:assert/strict';
import { paginateCatalog } from '../lib/catalog-pagination.ts';

test('shrinking from twenty to eighteen items clamps page two and shows every remaining item', () => {
  const page = paginateCatalog(Array.from({ length: 18 }, (_, index) => index), 2, 18);
  assert.equal(page.pages, 1);
  assert.equal(page.effectivePage, 1);
  assert.equal(page.visible.length, 18);
});

test('shrinking from four pages to two clamps display and navigation', () => {
  const page = paginateCatalog(Array.from({ length: 36 }, (_, index) => index), 4, 18);
  assert.equal(page.effectivePage, 2);
  assert.equal(page.pages, 2);
  assert.equal(page.nextPage, null);
  assert.equal(page.previousPage, 1);
  assert.deepEqual(page.visible, Array.from({ length: 18 }, (_, index) => index + 18));
});

test('zero results retains a valid page and an actual empty state', () => {
  const page = paginateCatalog([], 99, 18);
  assert.deepEqual(page.visible, []);
  assert.equal(page.effectivePage, 1);
  assert.equal(page.previousPage, null);
  assert.equal(page.nextPage, null);
});
