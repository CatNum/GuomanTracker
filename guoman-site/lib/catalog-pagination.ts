export function paginateCatalog<T>(items: T[], page: number, size: number) {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const effectivePage = Math.min(Math.max(page, 1), pages);
  return {
    pages,
    effectivePage,
    visible: items.slice((effectivePage - 1) * size, effectivePage * size),
    previousPage: effectivePage <= 1 ? null : effectivePage - 1,
    nextPage: effectivePage >= pages ? null : effectivePage + 1,
  };
}
