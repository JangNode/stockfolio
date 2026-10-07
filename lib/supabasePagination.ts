/**
 * Supabase(PostgREST)는 한 번의 요청에 최대 SUPABASE_MAX_ROWS_PER_REQUEST행까지만 돌려주고, 더 많아도 에러 없이 앞쪽만
 * 반환한다(2026-10-07 KR 스크리닝의 추적 종목 조회가 1,000건에서 조용히 잘리는 것으로 확인). 행 수가 1,000을 넘을 수 있는
 * 조회는 이 함수로 페이지를 돌아 전부 가져온다. 페이지 사이에 순서가 흔들리지 않도록 호출부가 고유 컬럼(.order("id"))으로
 * 정렬해야 한다.
 */
export const SUPABASE_MAX_ROWS_PER_REQUEST = 1000;

export async function fetchAllRows<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += SUPABASE_MAX_ROWS_PER_REQUEST) {
    const { data, error } = await fetchPage(from, from + SUPABASE_MAX_ROWS_PER_REQUEST - 1);
    if (error) throw new Error(error.message);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < SUPABASE_MAX_ROWS_PER_REQUEST) return rows;
  }
}
