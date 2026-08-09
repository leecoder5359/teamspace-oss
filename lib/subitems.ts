/* =====================================================================
   서브아이템 (격차 C6) — 순수 함수.

   행을 행 아래에 넣는다. 별도 계층 테이블 없이 `DbRow.parentRowId` 자기참조
   하나로 두었고(추가만 하는 마이그레이션), 여기서 그 트리를 다룬다.

   방어가 요점이다. 자기참조 계층은 **순환**과 **고아**가 반드시 생긴다:
   - 순환: A 를 B 아래로, B 를 A 아래로. 저장 시 막고, 그래도 데이터에 있으면
     화면 계산이 무한루프에 빠지지 않아야 한다.
   - 고아: 필터·검색으로 부모만 목록에서 빠지면 자식이 갈 곳을 잃는다.
     **행을 없애지 않고 최상위로 올린다** — 필터 때문에 행이 사라지면 안 된다.
   ===================================================================== */

export type TreeRow = { id: string; parentRowId?: string | null; position?: number };
export type LaidOutRow<T> = T & { depth: number; hasChildren: boolean };

const MAX_DEPTH = 50; // 깨진 데이터에서 무한루프 방지용 안전판

/**
 * `rowId` 를 `newParentId` 아래로 옮기면 순환이 생기나.
 * 새 부모에서 위로 올라가다 자기 자신을 만나면 순환이다.
 */
export function wouldCycle(rowId: string, newParentId: string | null, parentOf: Map<string, string | null>): boolean {
  if (!newParentId) return false;
  if (newParentId === rowId) return true;
  let cur: string | null | undefined = newParentId;
  const seen = new Set<string>();
  for (let i = 0; i < MAX_DEPTH && cur; i++) {
    if (cur === rowId) return true;
    if (seen.has(cur)) return false; // 이미 깨진 순환 — 여기서 멈춘다(내 문제는 아니다)
    seen.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return false;
}

/**
 * 표에 그릴 순서로 편다: 부모 바로 뒤에 자식이 오고 depth 가 붙는다.
 *
 * @param collapsed 접힌 부모 id — 그 자손은 결과에서 빠진다.
 */
export function buildRowTree<T extends TreeRow>(rows: T[], collapsed?: Set<string>): LaidOutRow<T>[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const children = new Map<string, T[]>();
  const roots: T[] = [];

  for (const r of rows) {
    // 부모가 이 목록에 없으면(필터로 잘림·삭제됨) 최상위로 올린다 — 행이 사라지면 안 된다.
    const pid = r.parentRowId && byId.has(r.parentRowId) && r.parentRowId !== r.id ? r.parentRowId : null;
    if (pid) {
      const list = children.get(pid);
      if (list) list.push(r);
      else children.set(pid, [r]);
    } else {
      roots.push(r);
    }
  }

  const byPos = (a: T, b: T) => (a.position ?? 0) - (b.position ?? 0);
  roots.sort(byPos);
  for (const list of children.values()) list.sort(byPos);

  const out: LaidOutRow<T>[] = [];
  const visited = new Set<string>();

  /** 접힌 가지는 **내지 않되 '처리됨'으로 표시**한다 — 아래 복구 루프가 다시 끌어내면 접기가 무의미해진다. */
  const markHidden = (row: T, depth: number) => {
    if (visited.has(row.id) || depth > MAX_DEPTH) return;
    visited.add(row.id);
    for (const k of children.get(row.id) ?? []) markHidden(k, depth + 1);
  };

  const walk = (row: T, depth: number) => {
    if (visited.has(row.id) || depth > MAX_DEPTH) return;
    visited.add(row.id);
    const kids = children.get(row.id) ?? [];
    out.push({ ...row, depth, hasChildren: kids.length > 0 });
    if (collapsed?.has(row.id)) {
      for (const k of kids) markHidden(k, depth + 1);
      return;
    }
    for (const k of kids) walk(k, depth + 1);
  };
  for (const r of roots) walk(r, 0);

  // 순환에 갇혀 한 번도 안 나온 행이 있으면 최상위로 끌어낸다(조용히 사라지지 않게).
  for (const r of rows) {
    if (!visited.has(r.id)) {
      visited.add(r.id);
      out.push({ ...r, depth: 0, hasChildren: (children.get(r.id) ?? []).length > 0 });
    }
  }
  return out;
}

/** 이 행의 모든 자손 id(삭제 확인·일괄 처리에 쓴다). */
export function descendantIds(rowId: string, rows: TreeRow[]): string[] {
  const children = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.parentRowId) continue;
    const list = children.get(r.parentRowId);
    if (list) list.push(r.id);
    else children.set(r.parentRowId, [r.id]);
  }
  const out: string[] = [];
  const seen = new Set<string>([rowId]);
  const stack = [...(children.get(rowId) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    stack.push(...(children.get(id) ?? []));
  }
  return out;
}
