/* sync-oss 의 env 읽기 인식(순수) — 이식성 퇴행 검사가 "OSS 에는 있는데 private 에는 없는 env 참조" 를 셀 때 쓴다.
   `process.env.X` 만 보면 `const e = process.env; e.X`·`env["X"]`·`const { X } = process.env` 로 옮긴 읽기를
   '사라진 것'으로 오탐한다(예: ASK_CLAUDE_MODEL). 인식하는 형태:
     process.env.X · env.X · process.env["X"] · env['X'] · const { X, Y: y = 1 } = process.env (또는 env) */
const KEY = "[A-Z][A-Z0-9_]*";

export function envKeysOf(text) {
  const keys = new Set();
  for (const m of text.matchAll(new RegExp(`\\benv\\.(${KEY})\\b`, "g"))) keys.add(m[1]);
  for (const m of text.matchAll(new RegExp(`\\benv\\s*\\[\\s*["'\`](${KEY})["'\`]\\s*\\]`, "g"))) keys.add(m[1]);
  for (const m of text.matchAll(/\{([^{}]*)\}\s*=\s*(?:process\.)?env\b(?!\s*\.)/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/[:=\s]/)[0];
      if (new RegExp(`^${KEY}$`).test(name)) keys.add(name);
    }
  }
  return keys;
}

/** OSS 본문이 읽는데 private 본문이 더 이상 안 읽는 키를 가른다.
 *  lost = 레포 전체(privateEnvAll)에서도 사라짐(퇴행) · relocated = 다른 파일로 옮겨 읽음(이동). */
export function classifyEnvLoss(ossText, privText, privateEnvAll) {
  const priv = envKeysOf(privText);
  const gone = [...envKeysOf(ossText)].filter((k) => !priv.has(k));
  return { lost: gone.filter((k) => !privateEnvAll.has(k)), relocated: gone.filter((k) => privateEnvAll.has(k)) };
}
