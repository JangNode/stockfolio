/**
 * [연구용] DART 키 풀: 1순위 키에서 status 020을 받으면 그 실행 동안 1순위를 끄고 2순위로 전환한다.
 * 운영 코드(lib/, 운영 스크립트)는 이 모듈을 쓰지 않는다. 키 값은 로그에 절대 출력하지 않는다(이름만).
 * 요청 예약(reserve)은 동기 구간에서 상한 검사와 카운트 증가를 함께 해 동시 요청이 상한을 넘지 못하게 한다.
 */
export interface PoolKey { name: string; value: string; cap?: number }
export class DartKeyPool {
  readonly used = new Map<string, number>();
  readonly got020 = new Map<string, number>();
  total = 0;
  switchedAt: string | null = null;
  switchedAtRequest: number | null = null;
  stopReason: string | null = null;
  private disabled = new Set<string>();
  constructor(private keys: PoolKey[], private totalCap: number) { for (const k of keys) { this.used.set(k.name, 0); this.got020.set(k.name, 0); } }
  /** 다음 요청에 쓸 키를 예약한다. null이면 더 보낼 수 없음(stopReason 설정). */
  reserve(): PoolKey | null {
    if (this.stopReason) return null;
    if (this.total >= this.totalCap) { this.stopReason = `전체 요청 상한 ${this.totalCap}건 도달`; return null; }
    for (const k of this.keys) {
      if (this.disabled.has(k.name)) continue;
      if (k.cap !== undefined && (this.used.get(k.name) ?? 0) >= k.cap) { this.stopReason = `${k.name} 실행당 상한 ${k.cap}건 도달`; return null; }
      this.total++;
      this.used.set(k.name, (this.used.get(k.name) ?? 0) + 1);
      return k;
    }
    this.stopReason = "사용 가능한 키 없음(모든 키 비활성)";
    return null;
  }
  /** status 020 수신. 1순위면 비활성화하고 true(다른 키로 재시도 가능), 마지막 키면 중단하고 false. */
  on020(name: string): boolean {
    this.got020.set(name, (this.got020.get(name) ?? 0) + 1);
    const idx = this.keys.findIndex((k) => k.name === name);
    this.disabled.add(name);
    if (this.switchedAt === null) { this.switchedAt = new Date().toISOString(); this.switchedAtRequest = this.total; }
    if (idx >= 0 && idx < this.keys.length - 1) return true;
    if (!this.stopReason) this.stopReason = `${name} status 020(요청 한도 초과) 수신, 전환할 키 없음`;
    return false;
  }
}
