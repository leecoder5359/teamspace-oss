import { describe, it, expect } from "vitest";
import { detectFormat, planImport, stripNotionHash } from "@/lib/importPlan";

const NOTION_HASH = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d"; // 32 hex

describe("detectFormat", () => {
  it("workspace.json + docs/ 가 있으면 우리 내보내기", () => {
    expect(detectFormat(["workspace.json", "README.md", "docs/설계.md", "boards/할일.csv"])).toBe("teamspace");
  });

  it("32자리 해시가 붙은 파일명이면 노션 export", () => {
    expect(detectFormat([`Export-x/할 일 ${NOTION_HASH}.md`])).toBe("notion");
  });

  it("그 외는 마크다운 폴더", () => {
    expect(detectFormat(["vault/a.md", "vault/b/c.md"])).toBe("markdown");
  });

  it("docs/ 만 있고 workspace.json 이 없으면 우리 내보내기로 보지 않는다", () => {
    expect(detectFormat(["docs/a.md"])).toBe("markdown");
  });
});

describe("stripNotionHash", () => {
  it("32자리 hex 꼬리를 뗀다", () => {
    expect(stripNotionHash(`회의록 ${NOTION_HASH}`)).toBe("회의록");
  });

  it("UUID 형태 꼬리도 뗀다", () => {
    expect(stripNotionHash("회의록 1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d")).toBe("회의록");
  });

  it("해시가 없으면 그대로 둔다", () => {
    expect(stripNotionHash("회의록")).toBe("회의록");
    expect(stripNotionHash("2026-08-09 회고")).toBe("2026-08-09 회고");
  });

  it("우연히 hex 처럼 보이는 짧은 단어는 건드리지 않는다", () => {
    expect(stripNotionHash("커밋 a0c2d6a")).toBe("커밋 a0c2d6a");
  });
});

describe("planImport — 우리 내보내기 zip 을 역방향으로 읽는다", () => {
  const plan = planImport([
    { path: "README.md", text: "# 내보내기\n설명" },
    { path: "workspace.json", text: "{}" },
    { path: "docs/TeamSpace 개발/설계 노트.md", text: "# 설계 노트\n\n본문\n" },
    { path: "docs/TeamSpace 개발/회의록.md", text: "# 회의록\n" },
    { path: "docs/미분류 문서.md", text: "# 미분류 문서\n" },
    { path: "boards/할 일.csv", text: "이름,상태\n" },
  ]);

  it("형식을 알아본다", () => {
    expect(plan.format).toBe("teamspace");
  });

  it("docs/<프로젝트>/<제목>.md 에서 프로젝트를 되살린다", () => {
    const doc = plan.documents.find((d) => d.title === "설계 노트")!;
    expect(doc.projectName).toBe("TeamSpace 개발");
    expect(doc.markdown).toBe("# 설계 노트\n\n본문\n");
  });

  it("docs 바로 아래 문서는 프로젝트가 없다", () => {
    expect(plan.documents.find((d) => d.title === "미분류 문서")!.projectName).toBeNull();
  });

  it("내보내기 메타(README·workspace.json)는 문서로 만들지 않는다", () => {
    expect(plan.documents.map((d) => d.title)).not.toContain("내보내기");
    expect(plan.skipped.map((s) => s.path)).toEqual(expect.arrayContaining(["README.md", "workspace.json"]));
  });

  it("보드 CSV 를 보드로 만든다 (격차 E2 후속)", () => {
    expect(plan.skipped.map((s) => s.path)).not.toContain("boards/할 일.csv");
    expect(plan.boards.map((b) => b.title)).toEqual(["할 일"]);
    // boards/ 한 겹은 프로젝트가 아니다(docs/ 와 같은 규칙)
    expect(plan.boards[0].projectName).toBeNull();
  });

  it("프로젝트 목록을 모아준다", () => {
    expect(plan.projects).toEqual(["TeamSpace 개발"]);
  });
});

describe("planImport — 우리 내보내기의 workspace.json 색인을 쓴다", () => {
  // 내보내기는 파일명을 제목으로 쓰되 "/" 같은 문자를 "_" 로 바꾸고 충돌 시 " (2)" 를
  // 붙인다. 그래서 파일명·본문 h1 만으로는 원래 제목을 되살릴 수 없다.
  // workspace.json 의 documents[] 가 id ↔ 파일 ↔ 제목 대응표라 그걸 진실 원천으로 삼는다.
  const manifest = JSON.stringify({
    documents: [
      { id: "p1", title: "설계: File-First 문서", project: "TeamSpace 개발", file: "docs/TeamSpace 개발/설계_ File-First 문서.md" },
      { id: "p2", title: "회고", project: null, file: "docs/회고.md" },
    ],
  });

  it("파일명이 아니라 색인의 제목·프로젝트를 되살린다", () => {
    const plan = planImport([
      { path: "workspace.json", text: manifest },
      { path: "docs/TeamSpace 개발/설계_ File-First 문서.md", text: "# 다른 제목이 본문에 있다\n" },
      { path: "docs/회고.md", text: "본문만" },
    ]);
    expect(plan.documents.map((d) => [d.title, d.projectName])).toEqual([
      ["설계: File-First 문서", "TeamSpace 개발"],
      ["회고", null],
    ]);
  });

  it("색인에 없는 파일은 기존 규칙(경로·본문)으로 처리한다", () => {
    const plan = planImport([
      { path: "workspace.json", text: manifest },
      { path: "docs/나중에 추가된 폴더/새 문서.md", text: "# 새 문서\n" },
    ]);
    expect(plan.documents[0]).toMatchObject({ title: "새 문서", projectName: "나중에 추가된 폴더" });
  });

  it("색인이 깨져 있으면 경고하고 경로 규칙으로 넘어간다", () => {
    const plan = planImport([
      { path: "workspace.json", text: "{ 이건 JSON 이 아니다" },
      { path: "docs/A/문서.md", text: "# 문서\n" },
    ]);
    expect(plan.documents[0]).toMatchObject({ title: "문서", projectName: "A" });
    expect(plan.warnings.join(" ")).toMatch(/workspace.json/);
  });
});

describe("planImport — 노션 export", () => {
  const plan = planImport([
    { path: `Export-93ab/기획 ${NOTION_HASH}/스펙 ${NOTION_HASH}.md`, text: "# 스펙\n\n내용" },
    { path: `Export-93ab/할 일 ${NOTION_HASH}.csv`, text: "Name,Status\n" },
    { path: `Export-93ab/이미지 ${NOTION_HASH}.png`, text: "" },
  ]);

  it("형식을 알아본다", () => {
    expect(plan.format).toBe("notion");
  });

  it("공통 루트 폴더(Export-…)를 벗겨낸다", () => {
    expect(plan.documents[0].projectName).toBe("기획");
  });

  it("제목·폴더명에서 해시를 뗀다", () => {
    expect(plan.documents[0].title).toBe("스펙");
  });

  it("CSV 는 보드가 되고 미참조 이미지만 건너뛴다", () => {
    expect(plan.documents).toHaveLength(1);
    expect(plan.boards.map((b) => b.title)).toEqual(["할 일"]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped.find((s) => s.path.endsWith(".png"))!.reason).toMatch(/첨부|이미지/);
  });
});

describe("planImport — 마크다운 폴더", () => {
  it("첫 폴더가 프로젝트가 된다", () => {
    const plan = planImport([
      { path: "노트/일지.md", text: "# 일지" },
      { path: "루트.md", text: "# 루트" },
    ]);
    expect(plan.format).toBe("markdown");
    expect(plan.documents.find((d) => d.title === "일지")!.projectName).toBe("노트");
    expect(plan.documents.find((d) => d.title === "루트")!.projectName).toBeNull();
  });

  it("공통 루트가 하나뿐이면 벗기고, 그 사실을 경고로 남긴다", () => {
    const plan = planImport([
      { path: "MyVault/a.md", text: "# a" },
      { path: "MyVault/폴더/b.md", text: "# b" },
    ]);
    expect(plan.documents.find((d) => d.title === "a")!.projectName).toBeNull();
    expect(plan.documents.find((d) => d.title === "b")!.projectName).toBe("폴더");
    expect(plan.warnings.join(" ")).toContain("MyVault");
  });

  it("루트가 여럿이면 벗기지 않는다", () => {
    const plan = planImport([
      { path: "A/a.md", text: "# a" },
      { path: "B/b.md", text: "# b" },
    ]);
    expect(plan.projects).toEqual(["A", "B"]);
  });

  it("두 단계보다 깊은 폴더는 첫 폴더로 접고 경고한다", () => {
    const plan = planImport([
      { path: "A/B/C/깊은 문서.md", text: "# 깊은 문서" },
      { path: "A/얕은 문서.md", text: "# 얕은 문서" },
      // 루트 파일이 하나 있어야 "공통 루트 벗기기" 가 끼어들지 않는다(그건 위 케이스가 덮는다)
      { path: "루트.md", text: "# 루트" },
    ]);
    expect(plan.documents.find((d) => d.title === "깊은 문서")!.projectName).toBe("A");
    expect(plan.warnings.join(" ")).toMatch(/중첩|폴더/);
  });

  it(".markdown 확장자도 받는다", () => {
    expect(planImport([{ path: "a.markdown", text: "# a" }]).documents).toHaveLength(1);
  });
});

describe("planImport — 제목 결정", () => {
  it("프론트매터 title 이 가장 세다", () => {
    const plan = planImport([{ path: "파일명.md", text: "---\ntitle: 진짜 제목\n---\n\n# 다른 제목\n" }]);
    expect(plan.documents[0].title).toBe("진짜 제목");
  });

  it("프론트매터는 본문에 그대로 남는다(무손실)", () => {
    // 에디터(PageEditor)가 프론트매터를 보존하므로 떼어낼 이유가 없다.
    const src = "---\ntitle: 진짜 제목\ntags: [a, b]\n---\n\n본문\n";
    expect(planImport([{ path: "x.md", text: src }]).documents[0].markdown).toBe(src);
  });

  it("프론트매터가 없으면 첫 h1", () => {
    expect(planImport([{ path: "파일명.md", text: "\n\n# 첫 제목\n\n# 둘째\n" }])[
      "documents"
    ][0].title).toBe("첫 제목");
  });

  it("h1 이 없으면 파일명", () => {
    expect(planImport([{ path: "폴더/내 문서.md", text: "본문만 있다" }]).documents[0].title).toBe("내 문서");
  });

  it("제목이 전부 비면 파일명으로도 안 되면 Untitled", () => {
    expect(planImport([{ path: "____.md", text: "" }]).documents[0].title).toBe("Untitled");
  });

  it("같은 프로젝트 안에서 제목이 겹치면 번호를 붙인다", () => {
    const plan = planImport([
      { path: "A/1.md", text: "# 같은 제목" },
      { path: "A/2.md", text: "# 같은 제목" },
      { path: "A/3.md", text: "# 같은 제목" },
    ]);
    expect(plan.documents.map((d) => d.title)).toEqual(["같은 제목", "같은 제목 (2)", "같은 제목 (3)"]);
  });

  it("프로젝트가 다르면 같은 제목을 그대로 둔다", () => {
    const plan = planImport([
      { path: "A/x.md", text: "# 같은 제목" },
      { path: "B/x.md", text: "# 같은 제목" },
    ]);
    expect(plan.documents.map((d) => d.title)).toEqual(["같은 제목", "같은 제목"]);
  });

  it("CRLF 는 LF 로 정규화한다", () => {
    expect(planImport([{ path: "a.md", text: "# 제목\r\n본문\r\n" }]).documents[0].markdown).toBe("# 제목\n본문\n");
  });
});

describe("planImport — 첨부(E4)", () => {
  it("우리 export 의 상대경로 첨부를 끌고 온다", () => {
    const plan = planImport([
      { path: "workspace.json", text: "{}" },
      { path: "docs/프로젝트/노트.md", text: "![그림](../../attachments/1234-a.png)\n" },
      { path: "attachments/1234-a.png", text: "PNG" },
    ]);
    expect(plan.documents[0].assets).toEqual([{ href: "../../attachments/1234-a.png", zipPath: "attachments/1234-a.png" }]);
    expect(plan.assets).toEqual(["attachments/1234-a.png"]);
    // 참조된 첨부는 '건너뜀' 이 아니다
    expect(plan.skipped.map((s) => s.path)).not.toContain("attachments/1234-a.png");
  });

  it("노션처럼 md 옆에 놓인 그림도 같은 규칙으로 걸린다", () => {
    const plan = planImport([
      { path: `Export-x/스펙 ${NOTION_HASH}.md`, text: `![](스펙%20${NOTION_HASH}/그림.png)\n` },
      { path: `Export-x/스펙 ${NOTION_HASH}/그림.png`, text: "PNG" },
    ]);
    expect(plan.documents[0].assets).toHaveLength(1);
    expect(plan.assets).toEqual([`스펙 ${NOTION_HASH}/그림.png`]);
  });

  it("여러 문서가 같은 그림을 참조해도 한 번만 복원한다", () => {
    const plan = planImport([
      { path: "a.md", text: "![](img/x.png)" },
      { path: "b.md", text: "![](img/x.png)" },
      { path: "img/x.png", text: "PNG" },
    ]);
    expect(plan.assets).toEqual(["img/x.png"]);
    expect(plan.documents.map((d) => d.assets.length)).toEqual([1, 1]);
  });

  it("아무도 참조하지 않는 그림은 이유와 함께 버린다", () => {
    const plan = planImport([
      { path: "a.md", text: "본문뿐" },
      { path: "img/외톨이.png", text: "PNG" },
    ]);
    expect(plan.assets).toEqual([]);
    expect(plan.skipped.find((s) => s.path === "img/외톨이.png")!.reason).toMatch(/참조하지 않는/);
  });

  it("zip 밖(외부 URL·서버 절대경로)은 첨부가 아니다", () => {
    const plan = planImport([
      { path: "a.md", text: "![](https://x.com/a.png)\n![](/uploads/other/b.png)\n![](../../../etc/passwd)" },
    ]);
    expect(plan.documents[0].assets).toEqual([]);
    expect(plan.assets).toEqual([]);
  });

  it("코드블록 안의 링크는 첨부로 오해하지 않는다", () => {
    const plan = planImport([
      { path: "a.md", text: "```md\n![](img/x.png)\n```\n" },
      { path: "img/x.png", text: "PNG" },
    ]);
    expect(plan.assets).toEqual([]);
  });
});

describe("planImport — 안전·잡음 처리", () => {
  it("경로 탈출은 문서로 만들지 않는다", () => {
    const plan = planImport([
      { path: "../../etc/passwd.md", text: "# 나쁨" },
      { path: "a/../../b.md", text: "# 나쁨" },
      { path: "/절대/경로.md", text: "# 나쁨" },
    ]);
    expect(plan.documents).toHaveLength(0);
    expect(plan.skipped).toHaveLength(3);
    for (const s of plan.skipped) expect(s.reason).toMatch(/경로/);
  });

  it("맥 압축 잡음과 숨김파일은 건너뛴다", () => {
    const plan = planImport([
      { path: "__MACOSX/._a.md", text: "" },
      { path: ".DS_Store", text: "" },
      { path: ".obsidian/workspace.json", text: "{}" },
      { path: "정상.md", text: "# 정상" },
    ]);
    expect(plan.documents.map((d) => d.title)).toEqual(["정상"]);
    expect(plan.skipped).toHaveLength(3);
  });

  it("빈 입력은 빈 계획", () => {
    const plan = planImport([]);
    expect(plan).toMatchObject({ documents: [], skipped: [], projects: [], format: "markdown" });
  });

  it("문서가 하나도 없으면 경고한다", () => {
    const plan = planImport([{ path: "a.txt", text: "x" }]);
    expect(plan.warnings.join(" ")).toMatch(/문서/);
  });
});

describe("planImport — 문서 계층 유지 (E2 후속)", () => {
  it("중간 폴더가 부모 문서로 만들어진다", () => {
    const plan = planImport([
      { path: "프로젝트/설계/API/스펙.md", text: "# 스펙" },
      { path: "프로젝트/루트문서.md", text: "# 루트문서" },
      // 최상위 파일이 하나 있어야 '공통 루트 벗기기'가 끼어들지 않는다
      { path: "메모.md", text: "# 메모" },
    ]);
    expect(plan.documents.find((d) => d.title === "스펙")!.folderPath).toBe("설계/API");
    expect(plan.documents.find((d) => d.title === "루트문서")!.folderPath).toBeNull();
    expect(plan.folders.map((f) => f.path)).toEqual(["설계", "설계/API"]);
    expect(plan.folders[1].parentPath).toBe("설계");
  });

  it("부모가 항상 먼저 온다(깊이 순)", () => {
    const plan = planImport([
      { path: "P/a/b/c/깊은.md", text: "# 깊은" },
      { path: "P/a/얕은.md", text: "# 얕은" },
    ]);
    const depths = plan.folders.map((f) => f.path.split("/").length);
    expect(depths).toEqual([...depths].sort((x, y) => x - y));
  });

  it("노션의 `스펙.md` + `스펙/하위.md` 는 빈 폴더를 만들지 않고 그 문서를 부모로 쓴다", () => {
    const plan = planImport([
      { path: `Export-x/기획/스펙 ${NOTION_HASH}.md`, text: "# 스펙" },
      { path: `Export-x/기획/스펙 ${NOTION_HASH}/하위 ${NOTION_HASH}.md`, text: "# 하위" },
    ]);
    const f = plan.folders.find((x) => x.path === "스펙");
    expect(f).toBeTruthy();
    expect(f!.docPath).toContain("스펙"); // 폴더 자리에 있는 문서를 가리킨다
    expect(plan.documents.find((d) => d.title === "하위")!.folderPath).toBe("스펙");
  });

  it("계층이 없으면 폴더도 없다", () => {
    const plan = planImport([{ path: "P/문서.md", text: "# 문서" }, { path: "루트.md", text: "# 루트" }]);
    expect(plan.folders).toEqual([]);
  });

  it("우리 내보내기(docs/<프로젝트>/<제목>.md)도 폴더를 만들지 않는다", () => {
    const plan = planImport([
      { path: "workspace.json", text: "{}" },
      { path: "docs/프로젝트/문서.md", text: "# 문서" },
    ]);
    expect(plan.folders).toEqual([]);
    expect(plan.documents[0].folderPath).toBeNull();
  });

  it("같은 폴더를 여러 문서가 써도 한 번만 만든다", () => {
    const plan = planImport([
      { path: "P/공통/하나.md", text: "# 하나" },
      { path: "P/공통/둘.md", text: "# 둘" },
      { path: "메모.md", text: "# 메모" },
    ]);
    expect(plan.folders.map((f) => f.path)).toEqual(["공통"]);
  });

  it("프로젝트가 다르면 같은 이름 폴더도 따로 만든다", () => {
    const plan = planImport([
      { path: "A/공통/x.md", text: "# x" },
      { path: "B/공통/y.md", text: "# y" },
      { path: "루트.md", text: "# 루트" },
    ]);
    expect(plan.folders).toHaveLength(2);
    expect(plan.folders.map((f) => f.projectName).sort()).toEqual(["A", "B"]);
  });
});

describe("planImport — 보드(CSV) (격차 E2 후속)", () => {
  it("우리 내보내기: workspace.json 의 boards 색인으로 제목·프로젝트·열 타입을 되살린다", () => {
    const manifest = JSON.stringify({
      documents: [],
      boards: [
        {
          id: "b1",
          title: "할 일: 8월",
          project: "TeamSpace 개발",
          file: "boards/할 일_ 8월.csv",
          properties: [
            { name: "이름", type: "text" },
            { name: "상태", type: "select", options: ["할 일", "진행 중", "완료"] },
            { name: "마감일", type: "date" },
          ],
        },
      ],
    });
    const plan = planImport([
      { path: "workspace.json", text: manifest },
      { path: "docs/문서.md", text: "# 문서" },
      { path: "boards/할 일_ 8월.csv", text: "이름,상태,마감일\n로그인,진행 중,2026-08-09\n" },
    ]);
    expect(plan.boards).toHaveLength(1);
    const b = plan.boards[0];
    // 파일명은 "할 일_ 8월" 이지만 색인이 원래 제목을 안다
    expect(b.title).toBe("할 일: 8월");
    expect(b.projectName).toBe("TeamSpace 개발");
    expect(b.columns.map((c) => c.type)).toEqual(["text", "select", "date"]);
    // 행이 한 개라 추론만으로는 select 가 아니지만 색인이 있어 옵션까지 복원된다
    expect(b.columns[1].options).toEqual(["할 일", "진행 중", "완료"]);
    expect(b.rows[0].cells).toEqual(["로그인", "진행 중", "2026-08-09"]);
    expect(plan.projects).toContain("TeamSpace 개발");
  });

  it("노션: 데이터베이스 CSV 와 행 문서를 한 보드로 잇는다", () => {
    const plan = planImport([
      { path: `Export-x/Tasks ${NOTION_HASH}.csv`, text: "Name,Status\n로그인 수정,In progress\n회원가입,Todo\n비번,In progress\n" },
      { path: `Export-x/Tasks ${NOTION_HASH}/로그인 수정 ${NOTION_HASH}.md`, text: "# 로그인 수정\n\n본문" },
      { path: `Export-x/메모 ${NOTION_HASH}.md`, text: "# 메모" },
    ]);
    const b = plan.boards[0];
    expect(b.title).toBe("Tasks");
    expect(b.projectName).toBeNull();
    expect(b.columns.map((c) => c.type)).toEqual(["text", "select"]);
    // 행 문서는 그 행의 본문이 된다
    expect(b.rows[0].contentDocPath).toContain("로그인 수정");
    expect(b.rows[1].contentDocPath).toBeNull();
    // 같은 이름의 빈 폴더를 만들지 않고 보드를 부모로 쓴다
    const folder = plan.folders.find((f) => f.path === "Tasks")!;
    expect(folder.boardPath).toContain("Tasks");
    expect(folder.docPath).toBeNull();
  });

  it("노션의 _all.csv 가 있으면 필터된 뷰 CSV 는 건너뛴다", () => {
    const plan = planImport([
      { path: `Export-x/Tasks ${NOTION_HASH}.csv`, text: "Name\n하나\n" },
      { path: `Export-x/Tasks ${NOTION_HASH}_all.csv`, text: "Name\n하나\n둘\n" },
      { path: `Export-x/메모 ${NOTION_HASH}.md`, text: "# 메모" },
    ]);
    expect(plan.boards).toHaveLength(1);
    expect(plan.boards[0].title).toBe("Tasks");
    expect(plan.boards[0].rows).toHaveLength(2);
    expect(plan.skipped.find((x) => x.path.endsWith(`${NOTION_HASH}.csv`))!.reason).toMatch(/_all/);
  });

  it("문서가 링크로 가리키는 CSV 도 첨부가 아니라 보드로 만든다", () => {
    const plan = planImport([
      { path: "P/페이지.md", text: "# 페이지\n\n[표](표.csv)\n" },
      { path: "P/표.csv", text: "이름,수\n가,1\n" },
      { path: "루트.md", text: "# 루트" },
    ]);
    expect(plan.boards.map((b) => b.title)).toEqual(["표"]);
    expect(plan.assets).toEqual([]);
    expect(plan.documents.find((d) => d.title === "페이지")!.assets).toEqual([]);
  });

  it("마크다운 폴더: 첫 폴더가 보드의 프로젝트가 된다", () => {
    const plan = planImport([
      { path: "프로젝트/할 일.csv", text: "이름,상태\n가,진행 중\n나,완료\n다,진행 중\n" },
      { path: "루트.md", text: "# 루트" },
    ]);
    expect(plan.boards[0]).toMatchObject({ title: "할 일", projectName: "프로젝트", folderPath: null });
    expect(plan.projects).toContain("프로젝트");
  });

  it("보드만 든 zip 도 가져올 게 있다고 본다", () => {
    const plan = planImport([{ path: "표.csv", text: "이름,수\n가,1\n" }]);
    expect(plan.documents).toEqual([]);
    expect(plan.boards).toHaveLength(1);
    expect(plan.warnings.join(" ")).not.toMatch(/가져올 문서·보드가 없습니다/);
  });

  it("빈 CSV 는 이유와 함께 건너뛴다", () => {
    const plan = planImport([{ path: "빈.csv", text: "" }, { path: "루트.md", text: "# 루트" }]);
    expect(plan.boards).toEqual([]);
    expect(plan.skipped.find((s) => s.path === "빈.csv")!.reason).toMatch(/빈 CSV/);
  });

  it("보드 안의 열 경고는 보드 이름을 달고 계획 경고로 올라온다", () => {
    const plan = planImport([
      { path: "표.csv", text: '이름,태그\n가,"버그, 프론트"\n나,"버그, 프론트"\n' },
      { path: "루트.md", text: "# 루트" },
    ]);
    expect(plan.warnings.some((w) => w.startsWith("[표]") && w.includes("태그"))).toBe(true);
  });
});

describe("planImport — 행↔문서 잇기의 안전장치", () => {
  it("제목이 같은 행이 둘이면 문서는 먼저 나온 행만 가져간다(contentPageId 는 unique)", () => {
    const plan = planImport([
      { path: `Export-x/Tasks ${NOTION_HASH}.csv`, text: "Name,Status\n같은 제목,A\n같은 제목,B\n" },
      { path: `Export-x/Tasks ${NOTION_HASH}/같은 제목 ${NOTION_HASH}.md`, text: "# 같은 제목" },
      { path: `Export-x/메모 ${NOTION_HASH}.md`, text: "# 메모" },
    ]);
    const rows = plan.boards[0].rows;
    expect(rows[0].contentDocPath).toBeTruthy();
    expect(rows[1].contentDocPath).toBeNull();
  });
});
