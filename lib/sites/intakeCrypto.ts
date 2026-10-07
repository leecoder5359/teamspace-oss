import { hkdfSync, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

/* =====================================================================
   인테이크(초대 게스트가 폼으로 보낸 계정 정보) 저장 암호화 — AES-256-GCM.

   키는 **AUTH_SECRET 이 아니라** 전용 env `SITE_INTAKE_KEY` 에서만 파생한다.
   세션·사이트 토큰 서명 키와 분리하는 이유: 그 비밀값이 새더라도 DB 에 쌓인
   남의 계정 비밀번호까지 함께 풀리지는 않게 하려는 것이다.

   키가 없으면 **암호화도 복호화도 하지 않는다**(fail closed) — 제출을 받아
   평문으로 남기느니 503 으로 거절하는 쪽이 맞다.

   **키는 난수여야 한다.** HKDF 는 스트레칭(KDF 반복)을 하지 않으므로, 사람이 고른
   32자 문구는 DB 덤프를 쥔 공격자에게 그대로 오프라인 사전공격 대상이 된다.
   그래서 base64 또는 hex 로 **32바이트 이상 디코드되는 값만** 받는다
   (`openssl rand -base64 32` 가 정확히 그 값이다).

   **AAD 로 행에 묶는다.** 암호문은 자기 사이트·제출자·항목명에 결속돼 있어서,
   DB 쓰기 권한을 쥔 자가 A 사이트의 암호문을 B 행으로 옮겨 붙여도 풀리지 않는다
   (값을 읽지는 못해도 '누가 무엇을 보냈는지' 를 조작해 오배정을 유도하는 공격).
   ===================================================================== */

export const INTAKE_KEY_ENV = "SITE_INTAKE_KEY";
/** 디코드 후 요구하는 최소 바이트 수. */
export const INTAKE_KEY_MIN_BYTES = 32;

const SALT = Buffer.from("teamspace-site-intake-v1");
const INFO = Buffer.from("site-intake-entry");
const PREFIX = "v1";
const HOWTO = "openssl rand -base64 32";

/** 이 행의 암호문을 묶을 값. 전부 DB 에 평문으로 있는 것들이라 복호화 때 그대로 재구성된다. */
export type IntakeAad = { siteId: string; submittedBy: string; service: string };

const aadBuffer = (a: IntakeAad): Buffer => Buffer.from(`${PREFIX}\n${a.siteId}\n${a.submittedBy}\n${a.service}`, "utf8");

/** 키 문자열 → 원시 바이트. base64(=url 변형 포함) 또는 hex 만. 형식이 아니면 null. */
function decodeKeyMaterial(raw: string): Buffer | null {
  if (/^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0) return Buffer.from(raw, "hex");
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) {
    const b = Buffer.from(raw, "base64");
    return b.length > 0 ? b : null;
  }
  return null;
}

/** 키 설정 상태. 정상이면 null, 아니면 **값을 담지 않은** 사람이 읽을 이유 문자열. */
export function intakeKeyError(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[INTAKE_KEY_ENV]?.trim();
  if (!raw) return `${INTAKE_KEY_ENV} 가 설정되지 않았습니다. 계정 정보를 평문으로 받지 않으려고 거절합니다. (만들기: ${HOWTO})`;
  const bytes = decodeKeyMaterial(raw);
  if (!bytes) return `${INTAKE_KEY_ENV} 는 base64 또는 hex 여야 합니다. 사람이 고른 문구는 받지 않습니다 — ${HOWTO} 로 만드세요.`;
  if (bytes.length < INTAKE_KEY_MIN_BYTES) {
    return `${INTAKE_KEY_ENV} 는 ${INTAKE_KEY_MIN_BYTES}바이트 이상의 난수여야 합니다(지금 ${bytes.length}바이트). ${HOWTO} 로 만드세요.`;
  }
  return null;
}

function deriveKey(env: NodeJS.ProcessEnv): Buffer {
  const err = intakeKeyError(env);
  if (err) throw new Error(err);
  const ikm = decodeKeyMaterial(env[INTAKE_KEY_ENV]!.trim())!;
  return Buffer.from(hkdfSync("sha256", ikm, SALT, INFO, 32));
}

/** 평문 → "v1:ivB64:tagB64:cipherB64". 키가 없으면 throw(평문 저장 금지). */
export function encryptIntake(plain: string, aad: IntakeAad, env: NodeJS.ProcessEnv = process.env): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(env), iv);
  cipher.setAAD(aadBuffer(aad));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [PREFIX, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

/** "v1:ivB64:tagB64:cipherB64" → 평문. 형식 불량·변조·키 불일치·**다른 행의 AAD** 는 throw. */
export function decryptIntake(enc: string, aad: IntakeAad, env: NodeJS.ProcessEnv = process.env): string {
  const [ver, ivB64, tagB64, ctB64] = enc.split(":");
  if (ver !== PREFIX || !ivB64 || !tagB64 || !ctB64) throw new Error("저장된 암호문 형식이 아닙니다.");
  const d = createDecipheriv("aes-256-gcm", deriveKey(env), Buffer.from(ivB64, "base64"));
  d.setAAD(aadBuffer(aad));
  d.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([d.update(Buffer.from(ctB64, "base64")), d.final()]).toString("utf8");
}
