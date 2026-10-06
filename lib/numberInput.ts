/**
 * 숫자 입력칸(type="number") 컨트롤드 인풋용 변환.
 *
 * 입력칸을 지우면 Number("")이 0이 되어 다시 "0"으로 렌더링돼(진짜로 비워지지 않음) 이어서 입력한
 * 숫자가 "0" 뒤에 붙는 문제가 있었다(예: 20 → 지우기 → 2 입력 시 "02"). 지운 상태는 0이 아니라 NaN으로
 * 두고, NaN일 때만 빈 문자열로 렌더링한다. NaN인 채로는 제출하지 못하게 호출부에서 검증한다.
 */

export const toInputValue = (value: number): number | "" => (Number.isNaN(value) ? "" : value);
export const parseInputValue = (raw: string): number => (raw === "" ? NaN : Number(raw));
