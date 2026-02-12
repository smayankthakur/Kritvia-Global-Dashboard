export interface PaginatedResponseDto<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export function toPaginatedResponse<T>(
  items: T[],
  page: number,
  pageSize: number,
  total: number
): PaginatedResponseDto<T> {
  return {
    items,
    page,
    pageSize,
    total
  };
}

