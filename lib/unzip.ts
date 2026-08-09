/* =====================================================================
   최소 ZIP 판독기 — lib/zip.ts(작성기)의 짝. 의존성 없이 node:zlib 만 쓴다.

   가져오기(격차 E2)를 위해 필요하다. 내보내기가 만든 zip 을 되읽는 것은 물론
   **남이 만든 zip**(노션 export, Finder 압축, zip -r)도 읽어야 하므로 작성기의
   가정을 그대로 뒤집는 것으로는 부족하다. 실제로 다음이 우리 작성기엔 없지만
   바깥 zip 엔 흔하다:
     - 디렉터리 엔트리("folder/", 크기 0)
     - 데이터 디스크립터(flag bit 3 — local header 의 크기 필드가 0)
     - local header 와 central directory 의 extra field 길이가 다름
     - 아카이브 주석(EOCD 뒤에 꼬리가 붙는다)
   그래서 **중앙 디렉터리를 진실 원천으로** 삼아 읽는다(크기·CRC·오프셋 전부).

   지원 범위: 압축방식 0(store)·8(deflate), ZIP64 미지원, 암호화 미지원.
   신뢰할 수 없는 입력을 받는 자리이므로 엔트리 수·해제 총량 상한을 강제하고
   CRC 를 검증한다 — 조용히 깨진 데이터를 문서로 만들지 않는다.
   ===================================================================== */

import { crc32, inflateRawSync } from "node:zlib";

export type ZipReadEntry = { path: string; data: Buffer };

export type ReadZipOptions = {
  /** 읽을 엔트리 최대 개수 */
  maxEntries?: number;
  /** 압축 해제 후 총 바이트 상한(zip bomb 방어) */
  maxTotalBytes?: number;
};

const DEFAULT_MAX_ENTRIES = 20_000;
const DEFAULT_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const ZIP64_MARKER = 0xffffffff;

/** EOCD(end of central directory)를 뒤에서부터 찾는다 — 주석이 붙어 있을 수 있다. */
function findEocd(buf: Buffer): number {
  // 주석 최대 65535 + EOCD 22
  const from = Math.max(0, buf.length - 65_557);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error("zip 파일이 아니거나 손상되었습니다(EOCD 를 찾을 수 없습니다).");
}

/**
 * zip 버퍼에서 파일 엔트리들을 읽는다. 디렉터리 엔트리는 제외한다.
 * 순서는 중앙 디렉터리 기재 순서(=대개 기록 순서)를 따른다.
 */
export function readZip(buf: Buffer, opts: ReadZipOptions = {}): ZipReadEntry[] {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

  if (buf.length < 22) throw new Error("zip 파일이 아니거나 손상되었습니다(너무 짧습니다).");

  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  const centralOffset = buf.readUInt32LE(eocd + 16);

  if (centralOffset === ZIP64_MARKER || count === 0xffff) {
    throw new Error("ZIP64 형식은 지원하지 않습니다.");
  }
  if (count > maxEntries) {
    throw new Error(`zip 엔트리가 너무 많습니다(${count} > ${maxEntries}).`);
  }
  if (centralOffset + centralSize > buf.length) {
    throw new Error("zip 이 손상되었습니다(중앙 디렉터리가 파일 범위를 벗어납니다).");
  }

  const entries: ZipReadEntry[] = [];
  let total = 0;
  let p = centralOffset;

  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) {
      throw new Error("zip 이 손상되었습니다(중앙 디렉터리 헤더가 잘렸습니다).");
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const sum = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;

    // bit 0 = 암호화. 우리가 복호할 수 없으니 명시적으로 거절한다.
    if (flags & 0x0001) throw new Error(`암호가 걸린 zip 은 지원하지 않습니다: ${name}`);
    if (compSize === ZIP64_MARKER || rawSize === ZIP64_MARKER) {
      throw new Error(`ZIP64 형식은 지원하지 않습니다: ${name}`);
    }
    // 디렉터리 엔트리 — 이름이 "/" 로 끝나고 내용이 없다.
    if (name.endsWith("/")) continue;

    total += rawSize;
    if (total > maxTotalBytes) {
      throw new Error(`압축을 풀면 너무 큽니다(상한 ${maxTotalBytes} 바이트).`);
    }

    // 본문 위치는 **local header 를 다시 읽어** 계산한다. local 과 central 의
    // extra field 길이가 다른 zip 이 흔해서, central 값으로 건너뛰면 어긋난다.
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error(`zip 이 손상되었습니다(로컬 헤더를 찾을 수 없습니다): ${name}`);
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    if (start + compSize > buf.length) {
      throw new Error(`zip 이 손상되었습니다(본문이 잘렸습니다): ${name}`);
    }
    const body = buf.subarray(start, start + compSize);

    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(body);
    } else if (method === 8) {
      try {
        data = inflateRawSync(body);
      } catch {
        throw new Error(`zip 본문이 손상되었습니다(압축 해제 실패): ${name}`);
      }
    } else {
      throw new Error(`지원하지 않는 압축 방식(${method})입니다: ${name}`);
    }

    if (data.length !== rawSize || crc32(data) !== sum) {
      throw new Error(`zip 본문이 손상되었습니다(CRC 불일치): ${name}`);
    }
    entries.push({ path: name, data });
  }

  return entries;
}
