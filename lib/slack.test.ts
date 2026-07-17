import { describe, it, expect, afterEach } from "vitest";
import { resolveChannel, getSlackConfig } from "@/lib/slack";

describe("resolveChannel", () => {
  it("explicit 우선(트림)", () => {
    expect(resolveChannel("  C123  ", "C999")).toBe("C123");
  });
  it("explicit 없으면 fallback", () => {
    expect(resolveChannel("", "C999")).toBe("C999");
    expect(resolveChannel(null, "C999")).toBe("C999");
    expect(resolveChannel(undefined, "C999")).toBe("C999");
  });
  it("둘 다 없으면 throw", () => {
    expect(() => resolveChannel("", null)).toThrow(/channel/i);
  });
});

describe("getSlackConfig env 우선", () => {
  afterEach(() => {
    delete process.env.AUTH_SLACK_BOT_TOKEN;
    delete process.env.AUTH_SLACK_DEFAULT_CHANNEL;
  });

  it("AUTH_SLACK_BOT_TOKEN 이 있으면 DB 조회 없이 source=env", async () => {
    process.env.AUTH_SLACK_BOT_TOKEN = "xoxb-env";
    process.env.AUTH_SLACK_DEFAULT_CHANNEL = "C-ENV";
    expect(await getSlackConfig("ws-irrelevant")).toEqual({
      source: "env",
      token: "xoxb-env",
      defaultChannelId: "C-ENV",
    });
  });

  it("env 토큰만 있고 채널 env 없으면 defaultChannelId=null", async () => {
    process.env.AUTH_SLACK_BOT_TOKEN = "xoxb-env";
    expect(await getSlackConfig("ws-irrelevant")).toEqual({
      source: "env",
      token: "xoxb-env",
      defaultChannelId: null,
    });
  });
});
