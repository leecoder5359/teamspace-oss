import { hkdfSync, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

// 토큰 암호화 키는 새 비밀값 없이 기존 AUTH_SECRET 에서 HKDF 로 파생한다.
// (모듈 로드 시점이 아니라 호출 시점에 env 를 읽어 테스트가 주입 가능하도록 한다.)
const SALT = Buffer.from("teamspace-slack-v1");
const INFO = Buffer.from("slack-bot-token");

function deriveKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is required for token encryption.");
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret), SALT, INFO, 32));
}

/** 평문 토큰 → "ivB64:tagB64:cipherB64" (AES-256-GCM). */
export function encryptToken(plain: string): string {
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ct].map((b) => b.toString("base64")).join(":");
}

/** "ivB64:tagB64:cipherB64" → 평문 토큰. 형식 불량/변조 시 throw. */
export function decryptToken(enc: string): string {
  const [ivB64, tagB64, ctB64] = enc.split(":");
  if (!ivB64 || !tagB64 || !ctB64) throw new Error("Malformed ciphertext.");
  const key = deriveKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}
