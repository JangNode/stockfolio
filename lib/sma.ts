/** 단순이동평균. length - 1 이전 인덱스는 아직 평균을 낼 만큼 데이터가 없으므로 undefined. */
export function computeSMA(values: number[], length: number): (number | undefined)[] {
  const result: (number | undefined)[] = new Array(values.length).fill(undefined);

  for (let i = length - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - length + 1; j <= i; j++) sum += values[j];
    result[i] = sum / length;
  }

  return result;
}
