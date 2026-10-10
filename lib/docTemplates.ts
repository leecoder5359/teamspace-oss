import type { DocType } from "@/lib/docOrganize";

// 문서 템플릿 — 에이전트·사람이 설계/계획/리포트/핸드오프 문서를 같은 뼈대로 시작하게 한다(F9).
export type TemplateName = "design" | "plan" | "report" | "handoff";

type Template = { label: string; docType: DocType; body: (title: string) => string };

export const TEMPLATES: Record<TemplateName, Template> = {
  design: {
    label: "설계",
    docType: "design",
    body: (title) => `# ${title}

## 배경

## 목표 / 비목표

- 목표:
- 비목표:

## 설계

\`\`\`mermaid
flowchart LR
  %% 흐름을 여기에 그리세요
  A[입력] --> B[처리] --> C[출력]
\`\`\`

## 데이터

## API

## 리스크

## 결정

## 미결
`,
  },
  plan: {
    label: "계획",
    docType: "plan",
    body: (title) => `# ${title}

## 목표

## 범위

- 포함:
- 제외:

## 태스크

| 태스크 | 담당 | 검증 |
| --- | --- | --- |
| (태스크) |  |  |

## 일정

## 롤백
`,
  },
  report: {
    label: "리포트",
    docType: "report",
    body: (title) => `# ${title}

## 한 줄 요약

## 한 것

## 검증

## 미검증

## 후속

## 결정 필요
`,
  },
  handoff: {
    label: "핸드오프",
    docType: "handoff",
    body: (title) => `# ${title}

## 상태

- (진행 중 / 막힘 / 완료 대기 중 하나로 적기)

## 어디까지 했나

## 어떻게 이어가나

## 함정

## 연락처 / 문서 링크
`,
  },
};

export const TEMPLATE_NAMES = Object.keys(TEMPLATES) as [TemplateName, ...TemplateName[]];

export function isTemplateName(x: unknown): x is TemplateName {
  return typeof x === "string" && Object.prototype.hasOwnProperty.call(TEMPLATES, x);
}

/** 제목 줄 바로 아래에 `> 템플릿: <name> · <date>` 줄을 끼워 렌더한다. */
export function renderTemplate(name: TemplateName, title: string, date: string): string {
  const body = TEMPLATES[name].body(title);
  const nl = body.indexOf("\n");
  return `${body.slice(0, nl)}\n\n> 템플릿: ${name} · ${date}${body.slice(nl)}`;
}
