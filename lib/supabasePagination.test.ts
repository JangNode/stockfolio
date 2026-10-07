import test from "node:test";
import assert from "node:assert/strict";
import { fetchAllRows, SUPABASE_MAX_ROWS_PER_REQUEST } from "@/lib/supabasePagination";

function fakeTable(total: number) {
  const calls: [number, number][] = [];
  const fetchPage = async (from: number, to: number) => {
    calls.push([from, to]);
    const data: number[] = [];
    for (let i = from; i <= Math.min(to, total - 1); i++) data.push(i);
    return { data, error: null };
  };
  return { calls, fetchPage };
}

test("행이 상한보다 적으면 한 페이지로 끝난다", async () => {
  const t = fakeTable(999);
  assert.equal((await fetchAllRows(t.fetchPage)).length, 999);
  assert.equal(t.calls.length, 1);
});

test("정확히 상한만큼이면 빈 다음 페이지를 확인하고 끝난다", async () => {
  const t = fakeTable(SUPABASE_MAX_ROWS_PER_REQUEST);
  assert.equal((await fetchAllRows(t.fetchPage)).length, SUPABASE_MAX_ROWS_PER_REQUEST);
  assert.equal(t.calls.length, 2);
});

test("상한을 넘는 행도 순서대로 전부 읽는다", async () => {
  const t = fakeTable(2500);
  const rows = await fetchAllRows(t.fetchPage);
  assert.equal(rows.length, 2500);
  assert.deepEqual(rows.slice(998, 1002), [998, 999, 1000, 1001]);
  assert.deepEqual(t.calls, [[0, 999], [1000, 1999], [2000, 2999]]);
});

test("행이 없으면 빈 배열", async () => {
  assert.deepEqual(await fetchAllRows(fakeTable(0).fetchPage), []);
});

test("조회 오류는 예외로 올린다", async () => {
  await assert.rejects(fetchAllRows(async () => ({ data: null, error: { message: "boom" } })), /boom/);
});
