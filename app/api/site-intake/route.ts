import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { siteAccessById } from "@/lib/sites/server";
import { hasProxyIdentityHeaders, readProxyIdentity } from "@/lib/sites/proxyIdentity";
import { encryptIntake, intakeKeyError } from "@/lib/sites/intakeCrypto";
import { readBodyLimited } from "@/lib/sites/upstreamCall";
import {
  allowSubmission,
  parseIntakeSubmission,
  rateKey,
  INTAKE_MAX_BODY_BYTES,
  type RateState,
} from "@/lib/sites/intake";

export const runtime = "nodejs";

/* =====================================================================
   POST /api/site-intake — 초대 게스트가 퍼블리시 페이지의 폼으로 계정 정보를 보낸다.

   **무인증 라우트가 아니라 "자체 인증" 라우트다.** 세션 쿠키로는 올 수 없다:
   퍼블리시 페이지는 sandbox iframe(opaque origin)이고 /pub 프록시가 쿠키·authorization 을
   통째로 떼어 내기 때문이다. 그래서 middleware.isOpenApi 와 authz-coverage WHITELIST 에
   등록하고, 여기서 두 겹으로 스스로 막는다:

     ① 프록시 서명(x-teamspace-proxy-sig, lib/sites/proxyIdentity) — 이 요청이 정말
        /pub 프록시를 통과해 왔는가. 서명은 신원뿐 아니라 **메서드·경로·본문**에 묶여 있어서,
        새어 나간 서명으로 다른 내용을 심을 수 없다.
     ② siteAccessById 재판정 — 그 사이트가 지금도 살아 있고, 그 이메일이 지금도
        초대돼 있는가. 회수·비활성화가 즉시 반영된다.

   쓰기 전용이다. GET/목록/조회가 없다 — 게스트는 자기가 보낸 것조차 다시 못 읽는다.
   읽기·삭제는 워크스페이스 멤버용 /api/sites/<id>/intake 쪽에만 있다.

   값은 저장 직전에 AES-256-GCM 으로 암호화한다(lib/sites/intakeCrypto). 키가 없으면
   503 으로 **거절**한다 — 평문으로 받아 두느니 못 받는 게 낫다.
   로그·에러 메시지에는 입력값을 한 글자도 싣지 않는다.
   ===================================================================== */

const rate: RateState = new Map();

const deny = () => NextResponse.json({ error: "이 링크로는 보낼 수 없습니다." }, { status: 403 });
const json = (body: unknown, status: number) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(req: Request) {
  // 서명 검증은 본문을 봐야 하므로(본문에 묶여 있다), 그 전에 값싼 관문부터 통과시킨다.
  if (!hasProxyIdentityHeaders(req.headers)) return deny();

  // 본문은 **스트리밍으로 상한까지만** 읽는다 — content-length 를 속이거나 chunked 로 보내도
  // 256KB 를 넘는 순간 읽기를 끊는다(무인증 버퍼링 창을 닫는다).
  const read = await readBodyLimited(req, INTAKE_MAX_BODY_BYTES);
  if (!read.ok) return json({ error: "보낸 내용이 너무 큽니다." }, 413);
  const raw = read.body;

  // ① 프록시 서명 — 이 메서드·이 경로·이 본문에 대해서만 유효하다.
  const who = readProxyIdentity(req.headers, { method: "POST", path: new URL(req.url).pathname, body: raw });
  if (!who) return deny();

  // ② 초대 재판정 (토큰·서명이 아니라 지금 DB 가 진실)
  const access = await siteAccessById(who.siteId, who.email);
  if (access.result !== "ok" || !access.site) return deny();
  const siteId = access.site.id;

  // 키가 없으면 아무것도 저장하지 않는다(fail closed). **인증을 통과한 뒤에** 답하는 이유:
  // 앞에 두면 헤더 하나만 붙인 익명 요청이 503/403 차이로 "키가 설정돼 있는가" 를 알아낼 수 있다.
  if (intakeKeyError()) return json({ error: "지금은 제출을 받을 수 없습니다. 담당자에게 알려 주세요." }, 503);

  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return json({ error: "본문이 JSON 이 아닙니다." }, 400);
  }

  const parsed = parseIntakeSubmission(body);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  // 빈도 제한은 **실제로 행을 만들기 직전에** 센다 — 형식 오류로 끝난 시도까지 한도를 깎으면
  // 정상적으로 고쳐 보내는 사람이 먼저 막힌다.
  if (!allowSubmission(rate, rateKey(siteId, who.email))) {
    return json({ error: "잠시 후 다시 시도해 주세요(제출이 너무 잦습니다)." }, 429);
  }

  try {
    await prisma.siteIntakeEntry.createMany({
      data: parsed.items.map((it) => ({
        siteId,
        service: it.service,
        fieldCount: it.fields.length,
        // AAD 로 이 행(사이트·제출자·항목명)에 묶는다 — 암호문을 다른 행으로 옮겨 붙여도 안 풀린다.
        secret: encryptIntake(JSON.stringify(it.fields), { siteId, submittedBy: who.email, service: it.service }),
        submittedBy: who.email,
        submittedByMember: who.member,
      })),
    });
  } catch {
    // 원인(암호화 실패·DB 오류)을 게스트에게 흘리지 않는다. 값이 실린 메시지가 나갈 여지도 없앤다.
    return json({ error: "저장하지 못했습니다. 잠시 후 다시 시도해 주세요." }, 500);
  }

  return json({ ok: true, saved: parsed.items.length, at: new Date().toISOString() }, 200);
}
