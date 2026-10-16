import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// scripts/healthcheck.sh 판정 로직 — 가짜 curl/docker/launchctl 을 PATH 앞에 두고 실제 스크립트를 돌린다.
const SCRIPT = resolve(__dirname, "healthcheck.sh");
// 테스트마다 bash 를 2~4번 띄운다 — 전체 스위트가 병렬로 돌 때 기본 5초를 넘겨 타임아웃이 났다.
vi.setConfig({ testTimeout: 30_000 });
const root = mkdtempSync(join(tmpdir(), "healthcheck-"));
const bin = join(root, "bin");
const callsFile = join(root, "calls.log");
let state: string;
let repo: string; // TEAMSPACE_REPO_DIR — 실제 레포의 .env 를 읽지 않도록 빈 임시 디렉터리

function fake(name: string, body: string) {
  const p = join(bin, name);
  writeFileSync(p, `#!/bin/bash\necho "${name} $*" >> "${callsFile}"\n${body}\n`);
  chmodSync(p, 0o755);
}
mkdirSync(bin);
// 슬랙 호출은 stdin(Authorization 헤더)을 slack-stdin 파일에 남기고, 공개 주소(pub.example.test)는 FAKE_PUBLIC_CODE 로 답한다.
fake(
  "curl",
  `case "$*" in *chat.postMessage*) cat >> "${root}/slack-stdin" ;; *pub.example.test*) printf '%s' "\${FAKE_PUBLIC_CODE:-200}" ;; *-w*) printf '%s' "$FAKE_CODE" ;; *) printf '%s' "$FAKE_BODY" ;; esac`,
);
fake("launchctl", `if [ "$1" = list ]; then printf '%s\\t0\\tcom.teamspace.web\\n' "$FAKE_WEB_PID"; fi; exit 0`);
fake("docker", `case "$1" in inspect) echo "$FAKE_RUNNING" ;; exec) exit "\${FAKE_READY_RC:-0}" ;; esac; exit 0`);

afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  state = mkdtempSync(join(root, "state-"));
  repo = mkdtempSync(join(root, "repo-"));
  rmSync(callsFile, { force: true });
  rmSync(join(root, "slack-stdin"), { force: true });
});

const DOWN = { FAKE_CODE: "503", FAKE_BODY: '{"ok":false,"db":false,"worker":false}' };
function run(env: Record<string, string>) {
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, TEAMSPACE_HEALTH_STATE_DIR: state, TEAMSPACE_REPO_DIR: repo, FAKE_WEB_PID: "-", FAKE_RUNNING: "true", ...env } as unknown as NodeJS.ProcessEnv,
  });
  const calls = existsSync(callsFile) ? readFileSync(callsFile, "utf8") : "";
  rmSync(callsFile, { force: true });
  return { out: r.stdout + r.stderr, status: r.status, calls };
}

describe("healthcheck.sh DB 복구", () => {
  it("db:false 1회는 대기, 2회째 컨테이너 ready 면 docker restart 하고 web 은 안 건드린다", () => {
    const first = run(DOWN);
    expect(first.calls).not.toMatch(/docker (restart|start)/);
    expect(first.out).toMatch(/db_fails=1/);
    const second = run(DOWN);
    expect(second.status).toBe(0);
    expect(second.calls).toMatch(/docker exec teamspace-postgres pg_isready -q/);
    expect(second.calls).toMatch(/docker restart teamspace-postgres/);
    expect(second.calls).not.toMatch(/kickstart/);
    expect(readFileSync(join(state, "db-fails"), "utf8").trim()).toBe("0");
    expect(Number(readFileSync(join(state, "db-restart-at"), "utf8"))).toBeGreaterThan(0);
  });

  it("컨테이너 이름은 TEAMSPACE_PG_CONTAINER 로 바꿀 수 있다", () => {
    run({ ...DOWN, TEAMSPACE_PG_CONTAINER: "pg-x" });
    expect(run({ ...DOWN, TEAMSPACE_PG_CONTAINER: "pg-x" }).calls).toMatch(/docker restart pg-x/);
  });

  it("컨테이너가 안 떠 있으면 docker start", () => {
    run({ ...DOWN, FAKE_RUNNING: "false" });
    const r = run({ ...DOWN, FAKE_RUNNING: "false" });
    expect(r.calls).toMatch(/docker start teamspace-postgres/);
    expect(r.calls).not.toMatch(/docker restart/);
  });

  it("컨테이너 안 pg_isready 실패(복구 중)면 재시작하지 않는다", () => {
    run({ ...DOWN, FAKE_READY_RC: "1" });
    const r = run({ ...DOWN, FAKE_READY_RC: "1" });
    expect(r.calls).not.toMatch(/docker (restart|start)/);
    expect(r.out).toMatch(/pg_isready 실패/);
  });

  it("쿨다운(15분) 안이면 다시 재시작하지 않는다", () => {
    writeFileSync(join(state, "db-restart-at"), String(Math.floor(Date.now() / 1000) - 60));
    run(DOWN);
    const r = run(DOWN);
    expect(r.calls).not.toMatch(/docker (restart|start)/);
    expect(r.out).toMatch(/쿨다운/);
  });

  it("쿨다운이 지나면 다시 재시작한다", () => {
    writeFileSync(join(state, "db-restart-at"), String(Math.floor(Date.now() / 1000) - 1000));
    run(DOWN);
    expect(run(DOWN).calls).toMatch(/docker restart/);
  });

  it("정상 응답이면 db-fails 를 리셋한다", () => {
    run(DOWN);
    const ok = run({ FAKE_CODE: "200", FAKE_BODY: '{"ok":true,"db":true,"worker":true}' });
    expect(ok.out).toMatch(/ ok/);
    expect(readFileSync(join(state, "db-fails"), "utf8").trim()).toBe("0");
    expect(run(DOWN).calls).not.toMatch(/docker (restart|start)/); // 연속이 끊겼으니 다시 1회째
  });

  it("db 와 무관한 실패(000)는 기존 web 로직대로 kickstart", () => {
    const r = run({ FAKE_CODE: "000", FAKE_BODY: "" });
    expect(r.calls).toMatch(/launchctl kickstart -k gui\/\d+\/com\.teamspace\.web/);
    expect(r.calls).not.toMatch(/docker/);
  });
});

describe("healthcheck.sh 공개 주소(엣지/중계) 감시", () => {
  const OK = { FAKE_CODE: "200", FAKE_BODY: '{"ok":true,"db":true,"worker":true}' };
  const SLACK = { AUTH_SLACK_BOT_TOKEN: "xoxb-test-token", TEAMSPACE_HEALTH_SLACK_CHANNEL: "CTEST" };
  const PUB = { PUBLIC_BASE_URL: "https://pub.example.test/", ...SLACK };
  const slackPosts = (calls: string) => calls.split("\n").filter((l) => l.includes("chat.postMessage"));

  it("PUBLIC_BASE_URL 이 없으면 공개 주소를 확인하지 않는다", () => {
    const r = run({ ...OK, ...SLACK });
    expect(r.calls).not.toMatch(/pub\.example\.test/);
    expect(slackPosts(r.calls)).toHaveLength(0);
  });

  it("로컬 정상·공개 실패 1회는 대기, 2회째 엣지 알림 — 토큰은 argv 에 싣지 않는다", () => {
    const first = run({ ...OK, ...PUB, FAKE_PUBLIC_CODE: "502" });
    expect(first.calls).toMatch(/https:\/\/pub\.example\.test\/login/); // 끝 슬래시 정리
    expect(first.out).toMatch(/public_fails=1/);
    expect(slackPosts(first.calls)).toHaveLength(0);

    const second = run({ ...OK, ...PUB, FAKE_PUBLIC_CODE: "502" });
    const posts = slackPosts(second.calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatch(/"channel":"CTEST"/);
    expect(posts[0]).toMatch(/로컬은 정상.*→ 502.*엣지\/중계/);
    expect(second.calls).not.toMatch(/xoxb-test-token/);
    expect(readFileSync(join(root, "slack-stdin"), "utf8")).toMatch(/Authorization: Bearer xoxb-test-token/);
    expect(second.calls).not.toMatch(/kickstart/); // 엣지 문제로 로컬 서비스를 건드리지 않는다
  });

  it("같은 엣지 알림은 쿨다운 안에서 반복하지 않고, 지나면 다시 보낸다", () => {
    run({ ...OK, ...PUB, FAKE_PUBLIC_CODE: "000" });
    expect(slackPosts(run({ ...OK, ...PUB, FAKE_PUBLIC_CODE: "000" }).calls)).toHaveLength(1);
    const third = run({ ...OK, ...PUB, FAKE_PUBLIC_CODE: "000" });
    expect(slackPosts(third.calls)).toHaveLength(0);
    expect(third.out).toMatch(/쿨다운 중\(edge/);
    writeFileSync(join(state, "alert-edge-at"), String(Math.floor(Date.now() / 1000) - 4000));
    expect(slackPosts(run({ ...OK, ...PUB, FAKE_PUBLIC_CODE: "000" }).calls)).toHaveLength(1);
  });

  it("공개 주소가 돌아오면 복구 알림 1번, 그다음엔 조용하다", () => {
    run({ ...OK, ...PUB, FAKE_PUBLIC_CODE: "502" });
    run({ ...OK, ...PUB, FAKE_PUBLIC_CODE: "502" });
    const back = run({ ...OK, ...PUB, FAKE_PUBLIC_CODE: "200" });
    expect(slackPosts(back.calls)).toHaveLength(1);
    expect(slackPosts(back.calls)[0]).toMatch(/공개 주소 복구/);
    expect(readFileSync(join(state, "public-fails"), "utf8").trim()).toBe("0");
    expect(slackPosts(run({ ...OK, ...PUB, FAKE_PUBLIC_CODE: "200" }).calls)).toHaveLength(0);
  });

  it("로컬 다운이면 공개 주소는 보지 않고, kickstart 할 때 로컬 다운 알림(엣지 알림 아님)", () => {
    const r = run({ FAKE_CODE: "000", FAKE_BODY: "", ...PUB, FAKE_PUBLIC_CODE: "502" });
    expect(r.calls).not.toMatch(/pub\.example\.test/);
    expect(r.calls).toMatch(/kickstart -k gui\/\d+\/com\.teamspace\.web/);
    const posts = slackPosts(r.calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatch(/로컬 서버 다운.*엣지 문제 아님/);
    expect(existsSync(join(state, "alert-edge-at"))).toBe(false);
    // 로컬이 돌아오면 로컬 복구 알림
    const back = run({ ...OK, ...PUB });
    expect(slackPosts(back.calls).join("\n")).toMatch(/로컬 서버 복구/);
  });

  it("값은 레포의 env 파일에서도 읽는다(.env.local 이 .env 보다 우선, 따옴표·주석 정리)", () => {
    writeFileSync(join(repo, ".env"), 'PUBLIC_BASE_URL="https://wrong.example.test"\nAUTH_SLACK_BOT_TOKEN=xoxb-file\n');
    writeFileSync(
      join(repo, ".env.local"),
      "export PUBLIC_BASE_URL=https://pub.example.test # 공개 주소\nAUTH_SLACK_DEFAULT_CHANNEL='CFILE'\n",
    );
    run({ ...OK, FAKE_PUBLIC_CODE: "503" });
    const r = run({ ...OK, FAKE_PUBLIC_CODE: "503" });
    expect(r.calls).toMatch(/curl .*https:\/\/pub\.example\.test\/login/);
    expect(r.calls).not.toMatch(/wrong\.example\.test/);
    expect(slackPosts(r.calls)[0]).toMatch(/"channel":"CFILE"/);
    expect(readFileSync(join(root, "slack-stdin"), "utf8")).toMatch(/Bearer xoxb-file/);
  });

  it("슬랙 토큰·채널이 없으면 발송 없이 로그만 남긴다", () => {
    run({ ...OK, PUBLIC_BASE_URL: "https://pub.example.test", FAKE_PUBLIC_CODE: "502" });
    const r = run({ ...OK, PUBLIC_BASE_URL: "https://pub.example.test", FAKE_PUBLIC_CODE: "502" });
    expect(slackPosts(r.calls)).toHaveLength(0);
    expect(r.out).toMatch(/슬랙 미설정/);
  });
});
