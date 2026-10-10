// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrorScreen, ErrorHomeLink } from "./ErrorScreen";

describe("ErrorScreen", () => {
  it("제목·본문·액션을 그린다", () => {
    const html = renderToStaticMarkup(
      <ErrorScreen title="페이지를 찾을 수 없어요" body="주소가 바뀌었거나 삭제된 문서일 수 있어요." actions={<ErrorHomeLink />} />,
    );
    expect(html).toContain("페이지를 찾을 수 없어요");
    expect(html).toContain("주소가 바뀌었거나 삭제된 문서일 수 있어요.");
    expect(html).toContain('href="/"');
    expect(html).toContain("홈으로");
  });
  it("digest 가 있으면 오류 코드를 작은 글씨로 보인다", () => {
    const html = renderToStaticMarkup(<ErrorScreen title="t" body="b" digest="abc123" />);
    expect(html).toContain("오류 코드: abc123");
  });
  it("digest 가 없으면 오류 코드 줄이 없다", () => {
    const html = renderToStaticMarkup(<ErrorScreen title="t" body="b" />);
    expect(html).not.toContain("오류 코드");
  });
});
