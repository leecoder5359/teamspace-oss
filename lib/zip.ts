/* =====================================================================
   최소 ZIP 작성기 — 의존성 없이 Node 내장(zlib)만 쓴다.

   워크스페이스 내보내기(격차 E1)를 위해 필요한데, 이것 하나 때문에 jszip 을
   들이기보다 필요한 만큼만 만든다. ZIP 은 형식이 공개돼 있고 우리가 쓰는 범위
   (파일 여러 개를 deflate 로 담기)는 작다.

   구현 범위: deflate(방식 8) 또는 store(방식 0), UTF-8 파일명, ZIP64 미지원.
   4GB 이상이나 65535개 초과 엔트리는 다루지 않는다 — 문서 내보내기엔 충분하고,
   넘으면 명시적으로 던진다(조용히 깨진 zip 을 내놓지 않는다).
   ===================================================================== */

import { crc32, deflateRawSync } from "node:zlib";

export type ZipEntry = { path: string; data: Buffer | string };

const MAX_ENTRIES = 65535;
const MAX_BYTES = 0xffffffff;

/** DOS 형식 시각(ZIP 헤더용). 초는 2초 단위로 잘린다. */
function dosDateTime(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * 엔트리들을 하나의 zip 버퍼로 만든다.
 *
 * @param at 타임스탬프(결정적 출력이 필요하면 고정값을 넘긴다 — 테스트가 그렇게 쓴다)
 */
export function createZip(entries: ZipEntry[], at: Date = new Date()): Buffer {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`zip 엔트리가 너무 많습니다(${entries.length} > ${MAX_ENTRIES}). ZIP64 는 지원하지 않습니다.`);
  }
  const { time, date } = dosDateTime(at);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.path, "utf8");
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    if (raw.length > MAX_BYTES) throw new Error(`파일이 너무 큽니다: ${e.path}`);

    const deflated = deflateRawSync(raw);
    // 압축이 오히려 커지면 그대로 담는다(작은 텍스트에서 흔하다)
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const sum = crc32(raw);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 파일명
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field 없음
    nameBuf.copy(local, 30);

    locals.push(local, body);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0); // central directory header signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header 위치
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/** zip 안에서 쓸 수 있는 경로로 정리 — 경로 탈출·제어문자·중복 슬래시를 막는다. */
export function safeZipPath(raw: string): string {
  const cleaned = raw
    .split("/")
    .map((seg) => seg.replace(/[\x00-\x1f\\:*?"<>|]/g, "_").trim())
    // "." ".." 같은 점만 있는 세그먼트는 **버린다**. "_" 로 바꾸면 경로 탈출은
    // 막히지만 "_/_/etc/passwd" 같은 쓰레기 경로가 남는다.
    .filter((seg) => seg && !/^\.+$/.test(seg))
    .join("/");
  return cleaned || "untitled";
}
