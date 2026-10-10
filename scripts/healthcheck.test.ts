import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// scripts/healthcheck.sh 판정 로직 — 가짜 curl/docker/launchctl 을 PATH 앞에 두고 실제 스크립트를 돌린다.
const SCRIPT = resolve(__dirname, "healthcheck.sh");
const root = mkdtempSync(join(tmpdir(), "healthcheck-"));
const bin = join(root, "bin");
const callsFile = join(root, "calls.log");
let state: string;

function fake(name: string, body: string) {
  const p = join(bin, name);
  writeFileSync(p, `#!/bin/bash\necho "${name} $*" >> "${callsFile}"\n${body}\n`);
  chmodSync(p, 0o755);
}
mkdirSync(bin);
fake("curl", `case "$*" in *-w*) printf '%s' "$FAKE_CODE" ;; *) printf '%s' "$FAKE_BODY" ;; esac`);
fake("launchctl", `if [ "$1" = list ]; then printf '%s\\t0\\tcom.teamspace.web\\n' "$FAKE_WEB_PID"; fi; exit 0`);
fake("docker", `case "$1" in inspect) echo "$FAKE_RUNNING" ;; exec) exit "\${FAKE_READY_RC:-0}" ;; esac; exit 0`);

afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  state = mkdtempSync(join(root, "state-"));
  rmSync(callsFile, { force: true });
});

const DOWN = { FAKE_CODE: "503", FAKE_BODY: '{"ok":false,"db":false,"worker":false}' };
function run(env: Record<string, string>) {
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, TEAMSPACE_HEALTH_STATE_DIR: state, FAKE_WEB_PID: "-", FAKE_RUNNING: "true", ...env } as unknown as NodeJS.ProcessEnv,
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
