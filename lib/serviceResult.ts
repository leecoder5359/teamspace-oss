/* lib/*Service 공통 결과 타입 (T-3a).
   서비스는 NextResponse 를 만들지 않고 { ok:true, … } | { ok:false, status, error, …extra } 를 돌려준다.
   서비스 안에서 부른 가드·검증 헬퍼(requirePage·gatePage·validateRelationProps·resolveProjectRef)는
   이미 응답을 만들어 돌려주므로 그건 { ok:false, res } 로 그대로 통과시킨다.
   라우트는 failResponse 로 실패를 기존과 같은 본문({ error, …extra })·상태 코드로 바꾼다. */
import { NextResponse } from "next/server";

export type ServiceFail<E extends object = object> = { ok: false; status: number; error: string } & E;
export type ServicePassthrough = { ok: false; res: Response };

/** extra 가 결과의 판별 키(ok·status·error)를 덮어쓰지 못하게 타입으로 막는다. */
type NoReservedKeys = { ok?: never; status?: never; error?: never };

export function fail(status: number, error: string): ServiceFail;
export function fail<E extends object & NoReservedKeys>(status: number, error: string, extra: E): ServiceFail<E>;
export function fail(status: number, error: string, extra?: object): ServiceFail {
  return { ok: false, status, error, ...extra };
}

export const passthrough = (res: Response): ServicePassthrough => ({ ok: false, res });

/** 실패 결과 → 응답. 본문 키 순서는 error 다음 extra(기존 라우트와 같다). */
export function failResponse(f: ServiceFail | ServicePassthrough): Response {
  if ("res" in f && f.res instanceof Response) return f.res;
  const { ok, status, ...body } = f as ServiceFail;
  void ok;
  return NextResponse.json(body, { status });
}
