export function normalizePagination(
  rawPage: unknown,
  rawPageSize: unknown,
  defaultPageSize = 25,
  maxPageSize = 100,
) {
  const page = Math.max(1, Math.trunc(Number(rawPage) || 1));
  const pageSize = Math.max(1, Math.min(maxPageSize, Math.trunc(Number(rawPageSize) || defaultPageSize)));
  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
  };
}

export function normalizeSortOrder(value: unknown): 'asc' | 'desc' {
  return String(value ?? '').toLowerCase() === 'asc' ? 'asc' : 'desc';
}
