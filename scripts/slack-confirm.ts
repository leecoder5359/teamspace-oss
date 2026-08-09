/**
 * 슬랙 컨펌 발송/수신 헬퍼 — TeamSpace approvals API 래퍼.
 *
 * 과거엔 봇 토큰으로 chat.postMessage(플레인 텍스트)를 직접 보내고 스레드 답글(1/2/3)을
 * 폴링했지만, 지금은 POST /api/approvals 를 호출한다 — 디자인시스템 카드(승인/거부 버튼)로
 * 발송되고, 버튼 결정이 서버(/api/slack/interactions)에 기록되므로 status 필드만 폴링하면 된다.
 *
 * 인증: WS_TOKEN/WS_BASE env > ~/.claude/teamspace.json {base, token} (pnpm ws 와 동일 체인).
 * 채널: --channel 미지정 시 #workspace-confirm(C000WORKSPACE) — env 기본 채널(#workspace-noti)
 *       폴백에 기대지 않는다(컨펌이 알림 채널로 새는 함정 방지).
 *
 * Usage:
 *   pnpm exec tsx scripts/slack-confirm.ts --title "제목" --body "본문" [--kind deploy] [--high] \
 *     [--channel <id>] [--project <projectId>] [--wait] [--timeout 3600]
 *   pnpm exec tsx scripts/slack-confirm.ts --title "제목" --body-file path.md --wait
 *   pnpm exec tsx scripts/slack-confirm.ts --check <approvalId>   # 상태만 조회
 *
 * 종료 코드(--wait/--check): approved=0 · additional=2 · rejected=3 · pending/타임아웃=124.
 */

import "dotenv/config";
import { promises as fs, readFileSync } from "node:fs";
import { homedir } from "node:os";

const CONFIRM_CHANNEL = "C000WORKSPACE"; // #workspace-confirm

// 토큰 체인: env > ~/.claude/teamspace.json (pnpm ws 와 동일)
function fileCfg(): { base?: string; token?: string } {
  try {
    return JSON.parse(readFileSync(`${homedir()}/.claude/teamspace.json`, "utf8"));
  } catch {
    return {};
  }
}
const CFG = fileCfg();
const BASE = process.env.WS_BASE ?? CFG.base ?? "http://localhost:3002";
const TOKEN = process.env.WS_TOKEN ?? CFG.token;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function api(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!TOKEN) throw new Error("에이전트 토큰이 없습니다 — WS_TOKEN 또는 ~/.claude/teamspace.json 을 설정하세요(pnpm ws token add).");
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "x-ws-token": TOKEN, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

type Approval = { id: string; status: string; responseText?: string | null; title?: string };

async function findApproval(id: string): Promise<Approval | undefined> {
  const list = (await api("GET", "/api/approvals")) as { approvals?: Approval[] };
  return (list.approvals ?? []).find((a) => a.id === id);
}

const EXIT: Record<string, number> = { approved: 0, additional: 2, rejected: 3 };

function finish(a: Approval | undefined, id: string): never {
  const status = a?.status ?? "notfound";
  console.log(JSON.stringify({ id, status, responseText: a?.responseText ?? null }));
  process.exit(EXIT[status] ?? 124);
}

/** status 가 pending 을 벗어날 때까지 폴링(15초 간격). */
async function pollStatus(id: string, timeoutSec: number): Promise<never> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const a = await findApproval(id);
    if (a && a.status !== "pending") finish(a, id);
    await new Promise((r) => setTimeout(r, 15_000));
  }
  finish(await findApproval(id), id); // pending 인 채 타임아웃 → 124
}

async function send(): Promise<void> {
  const title = arg("title") ?? "컨펌 요청";
  const bodyFile = arg("body-file");
  const body = bodyFile ? await fs.readFile(bodyFile, "utf8") : arg("body") ?? "";

  const created = (await api("POST", "/api/approvals", {
    title,
    body,
    kind: arg("kind") ?? "general",
    highRisk: flag("high"),
    channel: arg("channel") ?? CONFIRM_CHANNEL,
    projectId: arg("project"),
  })) as { id?: string; sent?: boolean };
  if (!created.id) throw new Error(`발송 실패: ${JSON.stringify(created)}`);
  console.log(JSON.stringify({ id: created.id, sent: created.sent ?? null }));

  // 슬랙에 실제로 못 갔으면 아무도 볼 수 없는 승인을 1시간 기다리는 셈이다.
  // 종전엔 sent:false 를 무시하고 폴링에 들어가 timeout(124) 으로 끝났고, 그때서야
  // "왜 아무도 안 눌렀지" 를 알게 됐다(전수조사 D20).
  if (created.sent === false) {
    console.error(
      "⚠️  승인은 만들어졌지만 슬랙 발송에 실패했습니다 — 아무도 이 카드를 볼 수 없습니다.\n" +
        "    채널 id · 봇 토큰(AUTH_SLACK_BOT_TOKEN) · 봇의 채널 초대 여부를 확인하세요.\n" +
        `    승인 id: ${created.id}`,
    );
    process.exit(1);
  }

  if (flag("wait")) {
    await pollStatus(created.id, Number(arg("timeout") ?? "3600"));
  } else {
    console.log(`\n상태 확인: pnpm exec tsx scripts/slack-confirm.ts --check ${created.id}`);
  }
}

async function main() {
  if (flag("check")) {
    const id = arg("check");
    if (!id) throw new Error("--check <approvalId> 가 필요합니다.");
    finish(await findApproval(id), id);
  }
  await send();
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
