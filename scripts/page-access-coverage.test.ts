import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * D3 회귀 가드: **페이지를 만지는 라우트는 페이지 게이트도 거쳐야 한다.**
 *
 * requireCtx(authz-coverage.test.ts)는 "이 워크스페이스 멤버인가" 까지만 본다.
 * D3 이후로는 그것만으로 부족하다 — 멤버여도 못 보는 페이지가 있다. 그런데 이런
 * 누락은 눈에 안 띈다: 새 라우트를 추가하고 requireCtx 만 붙이면 테스트도 타입도
 * 전부 초록인데 비공개 문서가 그 경로로 샌다.
 *
 * 그래서 정적으로 강제한다. Page/DbRow 를 건드리는 라우트 소스에 lib/pageGuard
 * 사용 흔적이 없으면 실패한다. 문자열 검사라 완벽하진 않지만, 잡으려는 것은
 * '아예 빠뜨린' 경우이고 그게 실제로 일어나는 사고다(authz-coverage 와 같은 태도).
 *
 * 예외는 이유와 함께 여기 적는다.
 */

const API_ROOT = join(__dirname, "..", "app", "api");

/** 페이지 데이터를 만지지만 게이트가 필요 없는 라우트 — 이유 필수. */
const EXEMPT = new Map<string, string>([
  // 자체 인증(훅·슬랙·설치기)이라 사용자 컨텍스트가 없다. 워크스페이스 스코프까지만 본다.
  ["ingest/route.ts", "훅 자체 인증(HMAC) — 사용자 컨텍스트 없음"],
  ["slack/interactions/route.ts", "슬랙 서명 인증 — 승인 카드 처리만"],
  ["cron/tick/route.ts", "워커 디스패치 — 예약 발송, 사용자 열람 경로 아님"],
  // 페이지를 **만들기만** 한다(읽지 않는다). 생성은 editor 역할로 충분하고,
  // 만든 사람이 곧 작성자라 그 자리에서 접근이 성립한다.
  ["clip/route.ts", "웹 클리퍼 — 새 문서 생성만, 기존 페이지를 읽지 않는다"],
  ["databases/route.ts", "보드 생성만 — 기존 페이지를 읽지 않는다"],
  // 알림 발송 대상 계산은 lib/notify 안에서 페이지를 읽지만, 사용자에게 본문을
  // 돌려주지 않는다(채널 라우팅용 제목만). 별도 슬라이스로 다룬다.
  ["notif-rules/route.ts", "알림 규칙 CRUD — 페이지 본문을 반환하지 않는다"],
  ["schedules/route.ts", "리마인더 — databasePageId 는 라우팅 키, 본문 미반환"],
  ["events/route.ts", "SSE 스트림 — 갱신 신호만 보내고 내용은 각 API 가 게이트한다"],
]);

/** 이 심볼 중 하나라도 쓰면 게이트를 거친 것으로 본다. */
const GUARD_TOKENS = ["requirePage(", "gatePage(", "requireProject(", "visibleOnly(", "visibleByPageId(", "pageAccess(", "projectAccess("];

/** 페이지 데이터를 만진다고 볼 신호. */
const TOUCHES = ["prisma.page.", "prisma.dbRow.", "prisma.pageGrant.", "prisma.projectGrant.", "databasePageId"];

function collectRoutes(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...collectRoutes(full, rel));
    else if (name === "route.ts") out.push(rel);
  }
  return out;
}

describe("D3 페이지 접근 커버리지", () => {
  const routes = collectRoutes(API_ROOT);

  it("라우트가 수집된다(스캐너 자체 검증)", () => {
    expect(routes.length).toBeGreaterThan(50);
  });

  for (const rel of routes) {
    const src = readFileSync(join(API_ROOT, rel), "utf8");
    if (!TOUCHES.some((t) => src.includes(t))) continue;
    if (EXEMPT.has(rel)) continue;

    it(`${rel} 는 페이지 게이트를 거친다`, () => {
      expect(
        GUARD_TOKENS.some((t) => src.includes(t)),
        `${rel} 이 Page/DbRow 를 만지는데 lib/pageGuard 를 쓰지 않습니다 — 비공개 문서가 이 경로로 샙니다(D3). ` +
          `단건은 requirePage/requireProject 로 게이트하고 목록은 visibleOnly 로 거르세요. ` +
          `정말 필요 없다면 EXEMPT 에 이유와 함께 등록하세요.`,
      ).toBe(true);
    });
  }

  it("면제 목록의 파일이 실제로 존재한다(오타·이사 방지)", () => {
    for (const rel of EXEMPT.keys()) {
      expect(() => readFileSync(join(API_ROOT, rel), "utf8"), `EXEMPT 의 ${rel} 가 없습니다`).not.toThrow();
    }
  });

  it("서버 컴포넌트(app/(ws))도 게이트를 거친다", () => {
    // API 만 막고 화면을 안 막으면 서버 렌더가 제목·본문을 먼저 그린다.
    const pageTsx = readFileSync(join(__dirname, "..", "app", "(ws)", "p", "[id]", "page.tsx"), "utf8");
    expect(pageTsx).toContain("pageAccess(");
  });
});
