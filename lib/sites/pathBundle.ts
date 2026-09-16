import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { createZip } from "@/lib/zip";

/* CLI·MCP 공용: 로컬 경로 → 업로드할 파일 버퍼. 폴더는 zip 으로 묶는다.
   숨김 파일(.env 등)·node_modules 는 **절대 담지 않는다** — 퍼블리시는 외부 공개다. */
export function bundleFromPath(p: string): { filename: string; data: Buffer } {
  const st = statSync(p);
  if (st.isFile()) return { filename: basename(p), data: readFileSync(p) };
  const entries: { path: string; data: Buffer }[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else entries.push({ path: relative(p, full).split(sep).join("/"), data: readFileSync(full) });
    }
  };
  walk(p);
  return { filename: `${basename(p)}.zip`, data: createZip(entries) };
}
