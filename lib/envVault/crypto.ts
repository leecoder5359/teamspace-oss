import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

/* =====================================================================
   env 금고 암호화 (설계: env 금고(Env Vault) 설계 · 암호화 절).

   - 마스터 키 = 전용 ENV_VAULT_KEY(base64 32바이트). AUTH_SECRET 과 분리한다 —
     로그인 비밀이 새도 env 값까지 같이 열리지 않게.
   - AES-256-GCM, 봉인 형식 "v1:iv:tag:ct"(각 base64). AAD 로 행 좌표
     (workspaceId:projectId:env:key)를 묶어 암호문을 다른 행으로 옮겨 붙이면 열리지 않는다.
   - 키가 없거나 형식이 틀리면 null → 기능 비활성(503). 호출 시점에 env 를 읽는다(테스트 주입).
   - 어떤 에러 메시지에도 평문을 넣지 않는다.
   ===================================================================== */

const VERSION = "v1";
const DIGEST_SALT = Buffer.from("teamspace-env-vault-v1");
const DIGEST_INFO = Buffer.from("value-digest");

/** ENV_VAULT_KEY → 32바이트 키. 없거나 길이가 틀리면 null(기능 비활성). */
export function vaultKey(): Buffer | null {
  const raw = process.env.ENV_VAULT_KEY?.trim();
  if (!raw) return null;
  // base64 형식이 아니면 Buffer.from 이 조용히 일부만 해석하므로 문자 집합부터 본다.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

export function vaultEnabled(): boolean {
  return vaultKey() !== null;
}

function requireKey(): Buffer {
  const key = vaultKey();
  if (!key) throw new Error("env 금고가 꺼져 있습니다(ENV_VAULT_KEY).");
  return key;
}

/** 행 좌표 AAD. */
export function varAad(workspaceId: string, projectId: string, env: string, key: string): string {
  return `${workspaceId}:${projectId}:${env}:${key}`;
}

/** 평문 → "v1:iv:tag:ct". */
export function sealValue(plain: string, aad: string): string {
  const key = requireKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

/** "v1:iv:tag:ct" → 평문. 형식 불량·변조·AAD 불일치면 throw(메시지에 값 없음). */
export function openValue(sealed: string, aad: string): string {
  const parts = sealed.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("봉인 형식이 올바르지 않습니다.");
  const [, ivB64, tagB64, ctB64] = parts;
  const key = requireKey();
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("봉인을 열 수 없습니다(키·좌표 불일치 또는 변조).");
  }
}

/** 값 지문 — HMAC-SHA256(HKDF 파생 키). 평문 해시 사전공격을 막기 위해 금고 키에 묶는다(P2 드리프트 비교용). */
export function valueDigest(plain: string): string {
  const key = Buffer.from(hkdfSync("sha256", requireKey(), DIGEST_SALT, DIGEST_INFO, 32));
  return createHmac("sha256", key).update(plain, "utf8").digest("hex");
}
