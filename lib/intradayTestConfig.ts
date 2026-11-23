// 분봉 장중 가설 H4(318)·H5(319) 시험 기준값. 사전등록: docs/research/intraday-prereg.md (2964d91, 첫 시험 전 커밋). 값은 결과를 보기 전에 고정했고 바꾸지 않는다.
export const INTRADAY_PARAMS = {
  /** 종가 불일치율 이 값 이상인 종목 전체 제외. 사전 점검이 정확히 이 3종목을 제외해야 한다. */
  mismatchRateExclude: 0.3,
  excludeExpected: ["207940", "068270", "010120"],
  expectDays: 244,
  /** 학습 거래일 수(첫 163일), 월 블록 수(거래일 12등분). */
  trainDays: 163,
  blocks: 12,
  /** 설계안 점검 수치(30종목): 10분 무거래 정규 봉, 60분 무거래 봉. */
  designMiss10: 839, designReg10: 277856, designMiss60: 30, designReg60: 51184,
  slotW: 1 / 30,
  // H4: 풀 봉 k=14~23(수익률 k=15~23), 신호 봉 k=24~35(13:00~15:00), 풀 비율 20%, 이웃 15%·25%
  h4PoolFrom: 15, h4PoolTo: 24, h4SigFrom: 24, h4SigTo: 35, h4Frac: 0.2, h4NbFrac: [0.15, 0.25], h4Need: 328,
  // H5: 중앙값 20거래일(유효 ≥15), 배수 3, 보유 6봉, 진입 봉 상한 37, 하루 5건, 이웃: 배수 2.25·3.75, 보유 5봉·8봉
  h5MedianDays: 20, h5MinValid: 15, h5Mult: 3, h5Hold: 6, h5EntryMax: 37, h5MaxPerDay: 5, h5Need: 316,
  h5Nb: [{ label: "배수 2.25", mult: 2.25 }, { label: "배수 3.75", mult: 3.75 }, { label: "보유 45분(5봉)", hold: 5 }, { label: "보유 75분(8봉)", hold: 8 }] as { label: string; mult?: number; hold?: number }[],
  // 관문
  seed: 20261022, bootN: 10000, bootQ: 0.05, randN: 1000,
  aMeanMinPct: 0.10, aMddFrac: 0.5, bTrainBlocksMin: 6, bAllBlocksMin: 8, cDropMaxPp: 0.05, eTopFrac: 0.03, eTopMin: 3, fMinPct: 95, hMinPp: 0.10, valRatio: 0.5,
  extremeKospiPct: 5,
};
