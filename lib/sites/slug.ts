import type { Prisma } from "@/app/generated/prisma/client";

/* 퍼블리시 사이트의 설명형 주소(슬러그) 규칙.
   - 영문 소문자·숫자·하이픈만, 하이픈은 단어 사이에만: `banjang-handover`.
   - 3~60자, 예약어 거절(라우트·관리 경로와 헷갈리는 이름).
   - 유일성은 **현재 슬러그 + 옛 슬러그(별칭) 전체**에서 본다. 자기 사이트의 별칭은 되찾을 수 있다.
   슬러그가 읽히게 돼도 열람 범위는 그대로다 — 셸·/pub 가 초대·멤버 판정을 매번 한다.
   미지정이면 지금처럼 newSlug()(추측 불가 12자)를 쓴다 — 그 값은 이 규칙을 따르지 않아도 된다. */

export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SLUG_MIN = 3;
export const SLUG_MAX = 60;

export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "api", "pub", "s", "new", "admin", "login", "logout", "signin", "signout", "auth",
  "sites", "site", "settings", "setup", "dashboard", "static", "assets", "public",
  "www", "app", "index", "help", "edit", "delete", "null", "undefined",
]);

export type SlugCheck = { ok: true; slug: string } | { ok: false; error: string };

export function checkSlug(raw: unknown): SlugCheck {
  if (typeof raw !== "string") return { ok: false, error: "slug 는 문자열이어야 합니다." };
  const slug = raw.trim();
  if (slug.length < SLUG_MIN || slug.length > SLUG_MAX) {
    return { ok: false, error: `주소(slug)는 ${SLUG_MIN}~${SLUG_MAX}자여야 합니다.` };
  }
  if (!SLUG_RE.test(slug)) {
    return { ok: false, error: "주소(slug)는 영문 소문자·숫자·하이픈만 쓸 수 있고, 하이픈은 단어 사이에만 옵니다(예: banjang-handover)." };
  }
  if (RESERVED_SLUGS.has(slug)) return { ok: false, error: `예약된 이름이라 주소로 쓸 수 없습니다: ${slug}` };
  return { ok: true, slug };
}

export const slugTakenError = (slug: string) => `이미 쓰고 있는 주소입니다: ${slug} — 다른 이름을 고르세요.`;

type SlugDb = Pick<Prisma.TransactionClient, "publishedSite" | "siteSlugAlias">;
type LockDb = Pick<Prisma.TransactionClient, "$executeRaw">;

/* 슬러그 유일성은 두 테이블(PublishedSite.slug + SiteSlugAlias.slug)에 걸쳐 있어 DB 유일 제약
   하나로 못 막는다(A 가 별칭으로 가진 이름을 B 가 현재 슬러그로 잡는 경합). 그래서 슬러그를
   지정 생성·변경하는 트랜잭션은 검사+쓰기 전에 이 고정 키로 트랜잭션 advisory 락을 잡아 직렬화한다.
   무작위 슬러그(newSlug) 생성은 충돌 확률이 무시할 만해 락을 잡지 않는다. */
export const SITE_SLUG_LOCK_KEY = 0x5e1f_51a6; // "site slug" — 고정 상수, 다른 advisory 키와 겹치지 않게

/** 트랜잭션 안에서 부른다 — 커밋/롤백 때 자동 해제(pg_advisory_xact_lock).
    반환 타입이 void 라 $queryRaw 가 아니라 $executeRaw(app/api/pair/approve 와 같은 이유). */
export async function lockSiteSlugs(tx: LockDb): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SITE_SLUG_LOCK_KEY}::bigint)`;
}

/** 다른 사이트가 이 슬러그를 현재 주소나 옛 주소로 갖고 있는가. siteId 의 것은 충돌이 아니다. */
export async function slugTaken(db: SlugDb, slug: string, siteId?: string): Promise<boolean> {
  const [site, alias] = await Promise.all([
    db.publishedSite.findUnique({ where: { slug }, select: { id: true } }),
    db.siteSlugAlias.findUnique({ where: { slug }, select: { siteId: true } }),
  ]);
  if (site && site.id !== siteId) return true;
  if (alias && alias.siteId !== siteId) return true;
  return false;
}

/** 슬러그 변경. 옛 슬러그는 별칭으로 남기고, 새 슬러그가 이 사이트의 별칭이었으면 그 별칭을 지운다.
    트랜잭션 클라이언트로 부른다 — 검사 전에 슬러그 락을 잡아 동시 변경·생성과 직렬화한다. */
export async function changeSiteSlug(
  db: SlugDb & LockDb,
  site: { id: string; slug: string },
  next: string,
): Promise<"same" | "taken" | "changed"> {
  if (next === site.slug) return "same";
  await lockSiteSlugs(db);
  if (await slugTaken(db, next, site.id)) return "taken";
  await db.siteSlugAlias.deleteMany({ where: { slug: next, siteId: site.id } });
  await db.publishedSite.update({ where: { id: site.id }, data: { slug: next } });
  await db.siteSlugAlias.create({ data: { slug: site.slug, siteId: site.id } });
  return "changed";
}

/** 동시에 같은 슬러그를 잡은 경우(유일 제약 위반) — 409 로 돌린다. */
export function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2002";
}
