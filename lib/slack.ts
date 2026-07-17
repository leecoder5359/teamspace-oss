import { prisma } from "@/lib/prisma";
import { decryptToken } from "@/lib/crypto";

// 서버 전용 슬랙 클라이언트. @slack/web-api 없이 fetch 로 Web API 직접 호출.
const SLACK_API = "https://slack.com/api";

export type SlackConfig = {
  source: "env" | "db";
  token: string;
  defaultChannelId: string | null;
};

/**
 * 워크스페이스의 유효 슬랙 설정을 해석한다.
 *   1) AUTH_SLACK_BOT_TOKEN 환경변수가 있으면 그것을 사용(DB 조회 없음, source=env).
 *      기본 채널은 AUTH_SLACK_DEFAULT_CHANNEL(선택).
 *   2) 없으면 SlackInstall(설정 화면에서 저장된 암호화 토큰)로 폴백(source=db).
 *   3) 둘 다 없으면 null(미연결).
 */
export async function getSlackConfig(workspaceId: string): Promise<SlackConfig | null> {
  const envToken = process.env.AUTH_SLACK_BOT_TOKEN?.trim();
  if (envToken) {
    // 기본 채널: env 우선, 없으면 DB(SlackInstall.defaultChannelId — 설정 화면/PATCH로 저장) 폴백.
    // env 토큰 모드에서도 기본 채널은 API 로 관리할 수 있게 한다(.env 수정 불필요).
    let dbDefault: string | null = null;
    if (!process.env.AUTH_SLACK_DEFAULT_CHANNEL?.trim()) {
      const install = await prisma.slackInstall
        .findUnique({ where: { workspaceId }, select: { defaultChannelId: true } })
        .catch(() => null);
      dbDefault = install?.defaultChannelId ?? null;
    }
    return {
      source: "env",
      token: envToken,
      defaultChannelId: process.env.AUTH_SLACK_DEFAULT_CHANNEL?.trim() || dbDefault,
    };
  }
  const install = await prisma.slackInstall.findUnique({ where: { workspaceId } });
  if (!install || !install.botTokenEnc) return null;
  return {
    source: "db",
    token: decryptToken(install.botTokenEnc),
    defaultChannelId: install.defaultChannelId,
  };
}

/** 명시 채널(트림) 우선, 없으면 기본 채널. 둘 다 없으면 throw. */
export function resolveChannel(
  explicit: string | null | undefined,
  fallback: string | null | undefined,
): string {
  const e = explicit?.trim();
  if (e) return e;
  const f = fallback?.trim();
  if (f) return f;
  throw new Error("No channel: 명시 채널도 기본 채널도 없습니다.");
}

/** auth.test 로 토큰 검증 + 팀/봇 정보 조회. */
export async function authTest(token: string): Promise<{
  ok: boolean;
  teamId?: string;
  teamName?: string;
  botUserId?: string;
  error?: string;
}> {
  const res = await fetch(`${SLACK_API}/auth.test`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
  });
  const data = (await res.json()) as {
    ok: boolean;
    team_id?: string;
    team?: string;
    user_id?: string;
    error?: string;
  };
  return data.ok
    ? { ok: true, teamId: data.team_id, teamName: data.team, botUserId: data.user_id }
    : { ok: false, error: data.error ?? "auth_failed" };
}

/** 워크스페이스의 유효 설정(env 우선 → DB 폴백)으로 chat.postMessage 발송. */
export async function postMessage(
  workspaceId: string,
  args: { channel?: string; text: string; kind?: string },
): Promise<{ ok: boolean; error?: string }> {
  const cfg = await getSlackConfig(workspaceId);
  if (!cfg) return { ok: false, error: "not_connected" };

  let channel: string;
  try {
    channel = resolveChannel(args.channel, cfg.defaultChannelId);
  } catch {
    return { ok: false, error: "no_channel" };
  }

  const res = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel, text: args.text }),
  });
  const data = (await res.json()) as { ok: boolean; error?: string };

  // 발송 내역 로그(실패 포함). 로그 실패는 발송 결과에 영향 주지 않음.
  await prisma.notifLog
    .create({
      data: {
        workspaceId,
        channel,
        text: args.text,
        kind: args.kind ?? "manual",
        state: data.ok ? "sent" : "failed",
        error: data.ok ? null : (data.error ?? "post_failed"),
      },
    })
    .catch(() => {});

  return data.ok ? { ok: true } : { ok: false, error: data.error ?? "post_failed" };
}

/** 공개 채널 목록(채널 피커용). channels:read 스코프 필요 — 없으면 ok:false. */
export async function listChannels(
  workspaceId: string,
): Promise<{ ok: boolean; channels?: { id: string; name: string }[]; error?: string }> {
  const cfg = await getSlackConfig(workspaceId);
  if (!cfg) return { ok: false, error: "not_connected" };
  const res = await fetch(`${SLACK_API}/conversations.list?types=public_channel&exclude_archived=true&limit=200`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  const data = (await res.json()) as { ok: boolean; error?: string; channels?: { id: string; name: string }[] };
  if (!data.ok) return { ok: false, error: data.error ?? "list_failed" };
  const channels = (data.channels ?? [])
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, channels };
}
