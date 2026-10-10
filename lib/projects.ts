import { prisma } from "@/lib/prisma";
import type { ArchivedMode } from "@/lib/pagesList";

/* 프로젝트 카드용 집계 — projects 화면(서버 라우트)과 /api/projects(GET)가 공유.
   프로젝트에 소속된 database 페이지(태스크 보드)의 DbRow에서 지표를 파생한다.
   Project 엔티티는 있지만 태스크 자체는 generic DbRow라, 보드 템플릿의 속성을
   이름 휴리스틱으로 분류한다(상태=select 中 "상태/status", 담당=text/person 中 "담당", 마감=date). */

type SelectOption = { id: string; name: string; color: string };

export type StatusBucket = { name: string; color: string; count: number };

export type ProjectStat = {
  id: string;
  name: string;
  short: string | null;
  color: string;
  description: string | null;
  repoUrl: string | null;
  repoPath: string | null;
  repoBranch: string | null;
  docsDir: string | null;
  /** 보관 시각(ISO) — null=활성(F10). */
  archivedAt: string | null;
  lead: { id: string; name: string | null; image: string | null } | null;
  boardPageId: string | null; // 카드 클릭 시 이동할 첫 보드
  taskCount: number;
  openCount: number;
  doneCount: number;
  overdueCount: number;
  dueSoonCount: number; // 오늘~7일 내 마감(미완료)
  statusBuckets: StatusBucket[];
  participants: string[]; // 담당자 이름(고유)
  docCount: number;
};

type PropLite = { id: string; name: string; type: string; config: unknown };

/** buildProjectStats 입력 — prisma 페치 결과의 구조적 타입(테스트에서 직접 구성 가능). */
export type RawProject = {
  id: string;
  name: string;
  short: string | null;
  color: string;
  description: string | null;
  repoUrl?: string | null;
  repoPath?: string | null;
  repoBranch?: string | null;
  docsDir?: string | null;
  archivedAt?: Date | null;
  lead: { id: string; name: string | null; image: string | null } | null;
  pages: {
    id: string;
    kind: string;
    dbProperties: PropLite[];
    dbRows: { props: unknown }[];
  }[];
};

function optionsOf(config: unknown): SelectOption[] {
  if (config && typeof config === "object" && "options" in config) {
    const opts = (config as { options?: unknown }).options;
    if (Array.isArray(opts)) return opts as SelectOption[];
  }
  return [];
}

function personNames(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  return value
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function dayDiff(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const d = new Date(value.length <= 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const t = new Date(d);
  t.setHours(0, 0, 0, 0);
  return Math.round((t.getTime() - today.getTime()) / 86400000);
}

function isDoneName(name: string): boolean {
  return /완료|done|close|닫|해결|resolved/i.test(name);
}

/** archived: active(기본)=보관 제외 · only=보관함 · all=둘 다 (F10) */
export async function getProjectsWithStats(workspaceId: string, archived: ArchivedMode = "active"): Promise<ProjectStat[]> {
  const projects = await prisma.project.findMany({
    where: {
      workspaceId,
      ...(archived === "active" ? { archivedAt: null } : archived === "only" ? { archivedAt: { not: null } } : {}),
    },
    orderBy: { position: "asc" },
    include: {
      lead: { select: { id: true, name: true, image: true } },
      pages: {
        where: { deletedAt: null },
        select: {
          id: true,
          kind: true,
          dbProperties: { select: { id: true, name: true, type: true, config: true } },
          dbRows: { select: { props: true } },
        },
        orderBy: { position: "asc" },
      },
    },
  });

  return buildProjectStats(projects);
}

/** 순수 집계: raw 프로젝트(+페이지/행) → 카드용 ProjectStat[]. DB 비의존(테스트 가능). */
export function buildProjectStats(projects: RawProject[]): ProjectStat[] {
  return projects.map((p) => {
    const dbPages = p.pages.filter((pg) => pg.kind === "database");
    const docCount = p.pages.filter((pg) => pg.kind === "doc").length;
    const boardPageId = dbPages[0]?.id ?? p.pages[0]?.id ?? null;

    let taskCount = 0;
    let doneCount = 0;
    let overdueCount = 0;
    let dueSoonCount = 0;
    const statusByName = new Map<string, StatusBucket>();
    const participants = new Set<string>();

    for (const pg of dbPages) {
      const props = pg.dbProperties as PropLite[];
      const statusProp = props.find(
        (pr) => (pr.type === "select" || pr.type === "multiselect") && /상태|status|진행/.test(pr.name),
      );
      const personProp = props.find(
        (pr) => pr.type === "person" || (pr.type === "text" && /담당|assignee|owner|작성/.test(pr.name)),
      );
      const dateProp = props.find((pr) => pr.type === "date");
      const statusOpts = statusProp ? optionsOf(statusProp.config) : [];
      const lastOpt = statusOpts[statusOpts.length - 1];
      const doneIds = new Set(
        statusOpts.filter((o) => isDoneName(o.name) || o.id === lastOpt?.id).map((o) => o.id),
      );

      for (const row of pg.dbRows) {
        const rp = row.props as Record<string, unknown>;
        taskCount++;

        // 상태 집계
        if (statusProp) {
          const optId = rp[statusProp.id];
          const opt = statusOpts.find((o) => o.id === optId);
          if (opt) {
            const b = statusByName.get(opt.name) ?? { name: opt.name, color: opt.color, count: 0 };
            b.count++;
            statusByName.set(opt.name, b);
          }
        }
        const done = statusProp ? doneIds.has(rp[statusProp.id] as string) : false;
        if (done) doneCount++;

        // 마감 (미완료만)
        if (dateProp && !done) {
          const diff = dayDiff(rp[dateProp.id]);
          if (diff !== null) {
            if (diff < 0) overdueCount++;
            else if (diff <= 7) dueSoonCount++;
          }
        }

        // 참여자
        if (personProp) for (const n of personNames(rp[personProp.id])) participants.add(n);
      }
    }

    return {
      id: p.id,
      name: p.name,
      short: p.short,
      color: p.color,
      description: p.description,
      archivedAt: p.archivedAt ? p.archivedAt.toISOString() : null,
      repoUrl: p.repoUrl ?? null,
      repoPath: p.repoPath ?? null,
      repoBranch: p.repoBranch ?? null,
      docsDir: p.docsDir ?? null,
      lead: p.lead,
      boardPageId,
      taskCount,
      openCount: taskCount - doneCount,
      doneCount,
      overdueCount,
      dueSoonCount,
      statusBuckets: [...statusByName.values()],
      participants: [...participants],
      docCount,
    } satisfies ProjectStat;
  });
}
