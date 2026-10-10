/* env 금고 P3b — syncGroup 일관성 계산(순수 함수). 지문은 서버(service.syncGroups)가 만들어 넘기고, 결과에는 싣지 않는다. */

export type SyncGroupMember = { projectId: string; projectName: string; env: string; key: string; varId: string };
export type SyncGroupRow = { name: string; members: SyncGroupMember[]; consistent: boolean };

/** 같은 이름의 묶음 안에서 지문이 모두 같은가. 멤버 순서는 프로젝트·env·키. */
export function computeSyncGroups(rows: (SyncGroupMember & { syncGroup: string; digest: string })[]): SyncGroupRow[] {
  const by = new Map<string, (SyncGroupMember & { digest: string })[]>();
  for (const { syncGroup, ...m } of rows) by.set(syncGroup, [...(by.get(syncGroup) ?? []), m]);
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...by.entries()]
    .sort(([a], [b]) => cmp(a, b))
    .map(([name, ms]) => ({
      name,
      consistent: new Set(ms.map((m) => m.digest)).size <= 1,
      members: ms
        .sort((a, b) => cmp(a.projectName, b.projectName) || cmp(a.env, b.env) || cmp(a.key, b.key))
        .map((m) => ({ projectId: m.projectId, projectName: m.projectName, env: m.env, key: m.key, varId: m.varId })),
    }));
}

