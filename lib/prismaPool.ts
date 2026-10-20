/* PrismaPg(pg.Pool) 설정을 env 에서 만든다(순수). 값이 없거나 잘못되면 그 키를 빼서 pg 기본값(max 10·idle 10초)을 쓴다.
 * 호스트·값을 하드코딩하지 않는다(AGENTS.md) — 동시 콜드 요청이 풀을 기다리면 DATABASE_POOL_MAX 로 올린다(감사 P-13). */
type PoolEnv = Readonly<Record<string, string | undefined>>;

export type PoolConfig = { connectionString: string | undefined; max?: number; idleTimeoutMillis?: number };

const intAtLeast = (raw: string | undefined, min: number): number | undefined =>
  raw !== undefined && /^\d+$/.test(raw) && Number(raw) >= min ? Number(raw) : undefined;

export function poolConfigFromEnv(env: PoolEnv): PoolConfig {
  const max = intAtLeast(env.DATABASE_POOL_MAX, 1);
  const idleTimeoutMillis = intAtLeast(env.DATABASE_POOL_IDLE_MS, 0);
  return {
    connectionString: env.DATABASE_URL,
    ...(max !== undefined ? { max } : {}),
    ...(idleTimeoutMillis !== undefined ? { idleTimeoutMillis } : {}),
  };
}
