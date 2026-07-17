/**
 * 슬랙 컨펌 발송/수신 헬퍼.
 *
 * 사용자가 설정한 봇 토큰(AUTH_SLACK_BOT_TOKEN)으로 컨펌 요청을 슬랙에 보내고,
 * (옵션) 스레드 답글을 폴링해 결정을 파싱한다.
 *
 * 결정 프로토콜(사용자가 스레드에 답글):
 *   1                  → 승인
 *   2 <추가 요청 내용>  → 추가 요청
 *   3 <거부 사유>       → 거부
 *
 * 대상 채널 해석 우선순위:
 *   --channel <id>  >  AUTH_SLACK_DEFAULT_CHANNEL  >  AUTH_SLACK_CONFIRM_EMAIL 로 DM
 *   (봇이 채널에 없으면 DM 으로 폴백. 셋 다 없으면 에러로 종료.)
 *
 * Usage:
 *   pnpm exec tsx scripts/slack-confirm.ts --title "제목" --body-file path.md
 *   pnpm exec tsx scripts/slack-confirm.ts --title "제목" --body "본문" --wait --timeout 120
 *   pnpm exec tsx scripts/slack-confirm.ts --check <channel> <ts>   # 기존 컨펌 답글만 조회
 */

import "dotenv/config";
import { promises as fs } from "node:fs";

const SLACK = "https://slack.com/api";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function token(): string {
  const t = process.env.AUTH_SLACK_BOT_TOKEN?.trim();
  if (!t) throw new Error("AUTH_SLACK_BOT_TOKEN 미설정 — 슬랙 컨펌을 보낼 수 없습니다.");
  return t;
}

type SlackResp = {
  ok?: boolean;
  error?: string;
  user?: { id?: string };
  user_id?: string;
  channel?: string | { id?: string };
  ts?: string;
  messages?: { ts?: string; user?: string; text?: string }[];
};

async function api(method: string, body: Record<string, unknown>, get = false): Promise<SlackResp> {
  const t = token();
  if (get) {
    const qs = new URLSearchParams(body as Record<string, string>).toString();
    const res = await fetch(`${SLACK}/${method}?${qs}`, { headers: { Authorization: `Bearer ${t}` } });
    return res.json();
  }
  const res = await fetch(`${SLACK}/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  return res.json();
}

/** 컨펌을 보낼 채널 id 해석(채널 우선, 없으면 사용자 DM). */
async function resolveChannel(override?: string): Promise<string> {
  const explicit = override?.trim() || process.env.AUTH_SLACK_DEFAULT_CHANNEL?.trim();
  if (explicit) return explicit;

  const email = process.env.AUTH_SLACK_CONFIRM_EMAIL?.trim();
  if (!email) {
    throw new Error(
      "대상 채널을 정할 수 없습니다. --channel <id> 를 넘기거나 " +
        "AUTH_SLACK_DEFAULT_CHANNEL(채널 id) 또는 AUTH_SLACK_CONFIRM_EMAIL(DM 대상 이메일) " +
        "환경변수를 설정하세요.",
    );
  }
  const look = await api("users.lookupByEmail", { email }, true);
  if (!look.ok) {
    throw new Error(
      `대상 채널을 정할 수 없습니다. 봇을 채널에 초대(/invite @supporter)하고 ` +
        `AUTH_SLACK_DEFAULT_CHANNEL 을 설정하거나, 봇에 users:read.email 스코프를 부여하세요. ` +
        `(users.lookupByEmail: ${look.error})`,
    );
  }
  const open = await api("conversations.open", { users: look.user?.id });
  if (!open.ok) throw new Error(`DM 열기 실패: ${open.error}`);
  return chanId(open.channel);
}

/** Slack 응답의 channel(문자열 또는 {id}) → id 문자열. */
function chanId(channel: SlackResp["channel"]): string {
  return typeof channel === "string" ? channel : channel?.id ?? "";
}

const PROTOCOL =
  "\n\n━━━━━━━━━━━━━━━━━━━━\n*이 메시지에 스레드로 답글*해 컨펌해 주세요:\n" +
  "• `1` — 승인\n• `2 <추가 요청 내용>` — 추가 요청\n• `3 <거부 사유>` — 거부";

async function send(): Promise<void> {
  const title = arg("title") ?? "컨펌 요청";
  const bodyFile = arg("body-file");
  const body = bodyFile ? await fs.readFile(bodyFile, "utf8") : arg("body") ?? "";
  const channel = await resolveChannel(arg("channel"));

  const text = `*${title}*\n\n${body}${PROTOCOL}`;
  const sent = await api("chat.postMessage", { channel, text, unfurl_links: false });
  if (!sent.ok) throw new Error(`발송 실패: ${sent.error}`);
  const chId = chanId(sent.channel);
  const ts = sent.ts ?? "";
  console.log(JSON.stringify({ ok: true, channel: chId, ts }));

  if (flag("wait")) {
    const timeout = Number(arg("timeout") ?? "120");
    const decision = await pollReply(chId, ts, timeout);
    console.log(JSON.stringify({ decision }));
  } else {
    console.log(`\n답글 확인: pnpm exec tsx scripts/slack-confirm.ts --check ${chId} ${ts}`);
  }
}

type Decision = { status: "approved" | "additional" | "rejected" | "none"; text?: string; raw?: string };

function parseDecision(raw: string): Decision {
  const s = raw.trim();
  if (/^1\b/.test(s) || /^승인|approve/i.test(s)) return { status: "approved", raw: s };
  if (/^2\b/.test(s)) return { status: "additional", text: s.replace(/^2\s*/, ""), raw: s };
  if (/^3\b/.test(s)) return { status: "rejected", text: s.replace(/^3\s*/, ""), raw: s };
  return { status: "none", raw: s };
}

/** 스레드 답글에서 봇이 아닌 첫 사람 답글을 결정으로 해석. */
async function readReply(channel: string, ts: string): Promise<Decision> {
  const rep = await api("conversations.replies", { channel, ts, limit: "30" }, true);
  if (!rep.ok) throw new Error(`답글 조회 실패: ${rep.error}`);
  const me = (await api("auth.test", {})).user_id;
  const human = (rep.messages ?? []).find(
    (m) => m.ts !== ts && m.user && m.user !== me && (m.text ?? "").trim(),
  );
  return human ? parseDecision(human.text ?? "") : { status: "none" };
}

async function pollReply(channel: string, ts: string, timeoutSec: number): Promise<Decision> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const d = await readReply(channel, ts);
    if (d.status !== "none") return d;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return { status: "none" };
}

async function main() {
  if (flag("check")) {
    const i = process.argv.indexOf("--check");
    const channel = process.argv[i + 1];
    const ts = process.argv[i + 2];
    console.log(JSON.stringify(await readReply(channel, ts)));
    return;
  }
  await send();
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
