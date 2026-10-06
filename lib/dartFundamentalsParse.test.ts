import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFundamentalsList, type DartAccountRow } from "@/lib/dartFundamentalsParse";

const row = (account_id: string, thstrm_amount: string, sj_div = "IS", account_nm = ""): DartAccountRow => ({
  rcept_no: "20200330003851",
  sj_div,
  account_id,
  account_nm,
  thstrm_amount,
});

test("ifrs-full_ 표기(FY2019~)에서 지배주주 순이익/자본을 읽는다", () => {
  const r = parseFundamentalsList([
    row("ifrs-full_ProfitLossAttributableToOwnersOfParent", "21505054000000"),
    row("ifrs-full_EquityAttributableToOwnersOfParent", "300000000000000", "BS"),
  ]);
  assert.equal(r.netIncomeParent, 21505054000000);
  assert.equal(r.equityParent, 300000000000000);
  assert.equal(r.rceptDate, "2020-03-30");
});

test("ifrs_ 표기(FY2015~2018)에서도 읽는다", () => {
  const r = parseFundamentalsList([
    row("ifrs_ProfitLossAttributableToOwnersOfParent", "18694628000000"),
    row("ifrs_EquityAttributableToOwnersOfParent", "200000000000000", "BS"),
  ]);
  assert.equal(r.netIncomeParent, 18694628000000);
  assert.equal(r.equityParent, 200000000000000);
});

test("두 표기가 함께 있으면 ifrs-full_을 우선한다", () => {
  const r = parseFundamentalsList([
    row("ifrs_ProfitLossAttributableToOwnersOfParent", "1"),
    row("ifrs-full_ProfitLossAttributableToOwnersOfParent", "2"),
  ]);
  assert.equal(r.netIncomeParent, 2);
});

test("지배 계정이 없으면 전체 당기순이익/자본총계로 폴백한다(IS/CIS, BS) — 기존 동작 유지", () => {
  const r = parseFundamentalsList([row("ifrs-full_ProfitLoss", "500"), row("ifrs-full_Equity", "900", "BS")]);
  assert.equal(r.netIncomeParent, 500);
  assert.equal(r.equityParent, 900);
  const cis = parseFundamentalsList([row("ifrs_ProfitLoss", "700", "CIS"), row("ifrs_Equity", "800", "BS")]);
  assert.equal(cis.netIncomeParent, 700);
  assert.equal(cis.equityParent, 800);
});

test("지배 id가 전체 손익 id보다 우선한다(둘 다 있으면 지배 몫)", () => {
  const r = parseFundamentalsList([row("ifrs-full_ProfitLoss", "999"), row("ifrs-full_ProfitLossAttributableToOwnersOfParent", "111")]);
  assert.equal(r.netIncomeParent, 111);
});

test("계정 id가 전혀 없으면 계정명으로 폴백한다(카카오처럼 id 표기가 다른 경우)", () => {
  const r = parseFundamentalsList([
    row("dart_Something", "5", "IS", "당기순이익"),
    row("dart_X", "108596686806", "IS", "지배기업 소유주지분"),
    row("dart_Y", "7", "IS", "비지배지분"),
    row("dart_Z", "4000", "BS", "지배기업의 소유주에게 귀속되는 자본"),
  ]);
  assert.equal(r.netIncomeParent, 108596686806);
  assert.equal(r.equityParent, 4000);
});

test("비지배지분 계정은 지배 몫으로 오인하지 않는다", () => {
  const r = parseFundamentalsList([row("dart_Y", "7", "IS", "비지배지분"), row("dart_Q", "9", "BS", "비지배지분")]);
  assert.equal(r.netIncomeParent, null);
  assert.equal(r.equityParent, null);
});

test("해당 계정이 없으면 null, 숫자가 아니면 null", () => {
  assert.equal(parseFundamentalsList([row("x", "1")]).netIncomeParent, null);
  assert.equal(parseFundamentalsList([row("ifrs-full_ProfitLossAttributableToOwnersOfParent", "-")]).netIncomeParent, null);
});

test("음수(적자) 금액을 그대로 읽는다", () => {
  assert.equal(parseFundamentalsList([row("ifrs-full_ProfitLossAttributableToOwnersOfParent", "-301002847366")]).netIncomeParent, -301002847366);
});
