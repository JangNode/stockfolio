/**
 * PR #8(잡주 필터링)의 마스터 필터 숫자가 상식과 맞는지 검증하기 위한 1회성 진단
 * 스크립트. 실제 KIS 종목마스터를 받아 productType 분포와 listedDate 파싱률/샘플을
 * 출력한다. DB에 쓰지 않고 콘솔에만 출력하며, 확인이 끝나면 지워도 된다.
 *
 * tsx --conditions=react-server scripts/debug-master-stats.ts
 */

import { getAllStocks } from "@/lib/stockMaster";

async function main(): Promise<void> {
  const stocks = await getAllStocks();
  console.log(`전체 종목 수: ${stocks.length}`);

  const productTypeCounts = new Map<string, number>();
  for (const s of stocks) {
    productTypeCounts.set(s.productType, (productTypeCounts.get(s.productType) ?? 0) + 1);
  }
  console.log("productType 분포:");
  for (const [type, count] of [...productTypeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }

  const withDate = stocks.filter((s) => s.listedDate !== null);
  const withoutDate = stocks.filter((s) => s.listedDate === null);
  console.log(`listedDate 파싱 성공: ${withDate.length}, 실패(null): ${withoutDate.length}`);

  if (withDate.length > 0) {
    const sorted = [...withDate].sort((a, b) => a.listedDate!.localeCompare(b.listedDate!));
    console.log(`listedDate 최솟값(가장 오래됨): ${sorted[0].code} ${sorted[0].name} ${sorted[0].listedDate}`);
    console.log(
      `listedDate 최댓값(가장 최근): ${sorted[sorted.length - 1].code} ${sorted[sorted.length - 1].name} ${sorted[sorted.length - 1].listedDate}`
    );

    // 최근 6개월 이내로 찍힌 샘플 몇 개 (실제로 존재하는지 눈으로 확인용)
    const now = new Date();
    const sixMonthsAgoStr = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate())
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, "");
    const recent = withDate.filter((s) => s.listedDate! >= sixMonthsAgoStr);
    console.log(`상장일 6개월 이내로 파싱된 종목 수: ${recent.length}`);
    for (const s of recent.slice(0, 20)) {
      console.log(`  ${s.code} ${s.name} listedDate=${s.listedDate} productType=${s.productType}`);
    }
  }

  // 잘 알려진 종목 몇 개를 집어서 실제 값 확인
  // 코스피: 삼성전자(1975-06-11), SK하이닉스(1996-12-26), NAVER(2008-11-04)
  // 코스닥: 에코프로비엠(2019-05-09), 에코프로(2001-11-08), 셀트리온헬스케어(2017-07-28),
  //         펄어비스(2017-09-14), 에스엠(2000-04-27)
  const knownCodes = [
    "005930",
    "000660",
    "035420",
    "247540",
    "086520",
    "091990",
    "263750",
    "041510",
  ];
  console.log("알려진 종목 확인:");
  for (const code of knownCodes) {
    const s = stocks.find((x) => x.code === code);
    console.log(`  ${code}: ${s ? `${s.name} productType=${s.productType} listedDate=${s.listedDate}` : "목록에 없음"}`);
  }

  // productType이 EF(ETF)로 잡힌 것 중 이름이 실제로 ETF스러운지 샘플 확인
  const efSamples = stocks.filter((s) => s.productType === "EF").slice(0, 10);
  console.log(`productType=EF 샘플 (${stocks.filter((s) => s.productType === "EF").length}건 중):`);
  for (const s of efSamples) console.log(`  ${s.code} ${s.name}`);

  // ETF일 것 같은데(이름에 KODEX/TIGER/ETF 등) productType이 EF가 아닌 경우 샘플
  const looksLikeEtfButNot = stocks
    .filter(
      (s) =>
        s.productType !== "EF" &&
        /KODEX|TIGER|ETF|ACE |SOL |RISE |ETN|KOSEF|ARIRANG/i.test(s.name)
    )
    .slice(0, 20);
  console.log(`ETF/ETN처럼 보이지만 productType이 EF/EN이 아닌 샘플 (${looksLikeEtfButNot.length}건 중 최대 20):`);
  for (const s of looksLikeEtfButNot) console.log(`  ${s.code} ${s.name} productType=${s.productType}`);
}

main().catch((error) => {
  console.error("진단 스크립트 실행 중 오류:", error);
  process.exit(1);
});
