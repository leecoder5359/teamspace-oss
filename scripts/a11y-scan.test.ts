import { describe, expect, it } from "vitest";
import { scanIconButtons, scanRepo } from "./a11y-scan";

const scan = (src: string) => scanIconButtons(["x.tsx"], () => src);

describe("scanIconButtons", () => {
  it.each([
    ["Icon only", `const a = <button onClick={f}><Icon name="x" /></button>;`],
    ["emoji only text", `const a = <button onClick={f}>✕</button>;`],
    ["self-closing", `const a = <button onClick={f} />;`],
    ["svg only", `const a = <button><svg /></button>;`],
    ["img without alt", `const a = <button><img src="a" /></button>;`],
    ["empty aria-label", `const a = <button aria-label=""><Icon name="x" /></button>;`],
    ["empty aria-labelledby", `const a = <button aria-labelledby="">✕</button>;`],
    ["empty title expr", `const a = <button title={""}>✕</button>;`],
    ["empty {} child", `const a = <button>{}</button>;`],
    ["comment-only child", `const a = <button>{/* x */}</button>;`],
    ["fragment of icons", `const a = <button><><Icon name="x" /></></button>;`],
    ["role=button div with icon", `const a = <div role="button" onClick={f}><Icon name="x" /></div>;`],
    ["role={'button'} span empty", `const a = <span role={"button"} tabIndex={0} />;`],
    ["<a> with only an icon", `const a = <a href="/x"><Icon name="link" /></a>;`],
    ["<Link> with only an svg", `const a = <Link href="/x"><svg /></Link>;`],
    ["wrapper Btn without label", `const a = <FilterBtn active onClick={f} />;`],
    ["wrapper Button without label", `const a = <ApproveButton code={c} />;`],
    ["wrapper with empty label", `const a = <FilterBtn label="" />;`],
    ["Menu trigger of only an icon", `const a = <Menu trigger={<Icon name="more" />}>{(c) => <i />}</Menu>;`],
    ["Menu trigger fragment of icons", `const a = <Menu trigger={<><Icon name="a" /><svg /></>}>{x}</Menu>;`],
    ["nested decorative component", `const a = <button><Dot color="gray" /></button>;`],
  ])("flags %s", (_n, src) => {
    const r = scan(src);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ file: "x.tsx", line: 1 });
  });

  it.each([
    ["aria-label", `const a = <button aria-label="닫기"><Icon name="x" /></button>;`],
    ["unknown expr nested in span", `const a = <button><span>{label}</span></button>;`],
    ["img expression alt", `const a = <button><img src="a" alt={altText} /></button>;`],
    ["aria-label expr", `const a = <button aria-label={t}>✕</button>;`],
    ["aria-labelledby", `const a = <button aria-labelledby="h">✕</button>;`],
    ["title", `const a = <button title="닫기">✕</button>;`],
    ["Korean text", `const a = <button>저장</button>;`],
    ["identifier child", `const a = <button>{label}</button>;`],
    ["conditional child", `const a = <button>{open ? <Icon name="a" /> : <Icon name="b" />}</button>;`],
    ["img alt", `const a = <button><img alt="닫기" /></button>;`],
    ["nested span", `const a = <button><Icon name="x" /><span>저장</span></button>;`],
    ["string literal expr", `const a = <button>{"저장"}</button>;`],
    ["template literal expr", "const a = <button>{`저장`}</button>;"],
    ["nested unknown expr deep", `const a = <button><div><span><b>{name}</b></span></div></button>;`],
    ["nested component with label", `const a = <button><StatusPill label={s} /><Icon name="x" /></button>;`],
    ["img alt expr nested in span", `const a = <a href="/"><span><img alt={t("logo")} /></span></a>;`],
    ["role=button with text", `const a = <div role="button" tabIndex={0}>{doc.title}</div>;`],
    ["other role not checked", `const a = <div role="menu"><Icon name="x" /></div>;`],
    ["<a> with text", `const a = <a href="/x"><Icon name="x" />문서</a>;`],
    ["<Link> aria-label", `const a = <Link href="/x" aria-label="홈"><Icon name="home" /></Link>;`],
    ["wrapper with label prop", `const a = <FilterBtn active onClick={f} label="전체" />;`],
    ["wrapper with text children", `const a = <IconButton onClick={f}>닫기</IconButton>;`],
    ["wrapper with aria-label", `const a = <IconButton aria-label="닫기" icon="x" />;`],
    ["Menu trigger with unknown display", `const a = <Menu trigger={<>{display}<Icon name="c" /></>}>{x}</Menu>;`],
    ["Menu trigger with text", `const a = <Menu trigger={<span>상태 없음</span>}>{x}</Menu>;`],
    ["spread props may carry a name", `const a = <button {...props}><Icon name="x" /></button>;`],
    ["spread props on wrapper", `const a = <IconButton {...rest} icon="x" />;`],
    ["Menu trigger identifier", `const a = <Menu trigger={node}>{x}</Menu>;`],
  ])("does not flag %s", (_n, src) => {
    expect(scan(src)).toEqual([]);
  });

  it("reports the line of the button", () => {
    const r = scan(`const a = (\n  <div>\n    <button>\n      <Icon name="x" />\n    </button>\n  </div>\n);`);
    expect(r[0].line).toBe(3);
  });
});

describe("repo guard", () => {
  it("has no icon-only buttons without an accessible name", () => {
    const found = scanRepo(process.cwd());
    expect(found.map((f) => `${f.file}:${f.line}`)).toEqual([]);
  });
});
