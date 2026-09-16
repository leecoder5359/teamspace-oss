---
name: teamspace-publish
description: HTML 페이지·데모·견적표·리포트를 TeamSpace 에 퍼블리시(게시)해 초대한 사람만 보는 링크로 공유할 때 사용. "팀스페이스에 퍼블리싱/퍼블리시/게시해줘", "이 HTML 팀스페이스에 올려", "링크로 공유할 수 있게 올려줘", "대표님(외부인)도 볼 수 있게", "퍼블리시한 거 새 버전으로 갱신", "초대 추가/회수" 요청.
---

# TeamSpace HTML 퍼블리시

HTML 파일·폴더·zip 을 올리면 `/s/<slug>` 링크가 생기고 **초대한 이메일로 Google 로그인한 사람만** 본다(게스트는 워크스페이스 멤버가 아님). 엔드포인트·보안 설계 전체는 `teamspace` 스킬의 「HTML 퍼블리시」 절이 원본이다 — 이 스킬은 **실행 순서와 함정**만 담는다.

## 1. 올리기 전 점검

| 점검 | 이유 · 처리 |
|---|---|
| **`<!doctype html>` 이 있는가** | Claude Artifact 용으로 쓴 HTML 은 doctype·`<html>`·`<head>`·`<body>` 없이 `<title>`·`<style>` 부터 시작한다. 그대로 올리면 쿼크 모드로 렌더된다 → 아래 "감싸기" 로 정식 문서로 만든다 |
| **루트 기준 경로(`/assets/x.js`) 가 없는가** | 샌드박스 경로에서 로드되지 않는다. 상대경로로 빌드(`vite build --base=./`) |
| **폴더·zip 이면 `index.html` 이 있는가** | 필수. 최상위 폴더 한 겹은 자동으로 벗긴다. 20MB·해제 50MB·파일 500개 |
| **비밀값·개인정보가 없는가** | 초대 게스트 전용이어도 링크가 전달되는 순간 밖으로 나간 것이다 |

**감싸기** (doctype 없는 Artifact HTML → 정식 문서, 원본은 건드리지 않고 사본을 만든다):

```bash
python3 - "$SRC" "$OUT" <<'PY'
import sys; src, out = sys.argv[1], sys.argv[2]
t = open(src).read()
if t.lstrip().lower().startswith("<!doctype"):
    open(out, "w").write(t)
else:
    i = t.index("</style>") + len("</style>")   # 머리(title·link·style) / 본문 경계
    open(out, "w").write('<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
        + t[:i] + '\n</head>\n<body>\n' + t[i:] + '\n</body>\n</html>\n')
PY
```

## 2. 샌드박스에서 되는 것 / 안 되는 것

페이지는 `sandbox` iframe 안에서 돈다(`lib/sites/headers.SITE_SANDBOX`: `allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads`, **allow-same-origin 없음**). 올리기 전에 페이지 코드가 아래에 대비돼 있는지 본다.

| 기능 | 동작 | 페이지가 해야 할 일 |
|---|---|---|
| 스크립트·외부 CDN(Google Fonts, cdnjs 등) | ✅ | — |
| 파일 다운로드(`Blob` + `<a download>`) | ✅ `allow-downloads` | — |
| `alert`/`confirm`, 새 창 열기 | ✅ | — |
| **localStorage / sessionStorage / IndexedDB** | ❌ opaque origin 이라 **접근 시 예외** | `try/catch` 로 감싸고 저장 없이도 동작. 새로고침하면 상태가 초기화된다고 안내 |
| **클립보드 자동 복사** | ❌ 셸 iframe 에 `clipboard-write` 권한 없음 | 실패 시 내용을 textarea 에 띄워 직접 복사하게 하는 폴백 |
| **Claude Artifact 전용 `window.claude.use(...)`** (db·downloads·sample 등) | ❌ `window.claude` 자체가 없음 | `window.claude?.use` 로 확인하고 없으면 기능 숨김 또는 일반 방식으로 폴백 |
| 상위 페이지 이동(`top.location`) | ❌ | 링크는 `target="_blank"` 로 |

### 페이지에서 로컬 서버 API 쓰기 (API 프록시)

페이지가 맥미니에서 도는 로컬 서버(예: 에이전트 서버 `127.0.0.1:4717`)를 부르게 할 수 있다. 설계·보안 모델은 `teamspace` 스킬 「HTML 퍼블리시」 절의 **API 프록시** 항목.

- **상대경로로 fetch 한다**: `fetch('api/generate', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(...)})`. `/api/generate`(루트 경로)는 TeamSpace 자체 API 로 가서 401 이 난다. 하위 폴더 페이지(`sub/page.html`)에서는 `../api/...` 로 맞춘다 — 프록시는 `/pub/<token>/api/*` 만 받는다. `credentials` 옵션은 쓰지 않는다.
- **연결**: 사이트를 올린 뒤 `pnpm ws site api <siteId> http://127.0.0.1:<port>` (해제 `--off`). 루프백 주소만 된다. `site ls` 마지막 열·`site show` 의 `site.apiUpstream` 으로 확인.
- **upstream 이 받는 것**: 경로 `/api/...`·원 쿼리·본문, 헤더는 `content-type`·`accept` 와 `x-teamspace-site-id`·`x-teamspace-viewer`(로그인 이메일)·`x-teamspace-member`(워크스페이스 멤버면 `true`). 쿠키·authorization 은 오지 않는다. upstream 은 루프백에서만 리슨하게 두고, 사용자별 제한이 필요하면 `x-teamspace-viewer` 로 한다.
- **상한**: 요청 본문 1MB · 응답 5MB · 기본 10분(`SITE_API_TIMEOUT_MS`). JSON in/out 기준이고 스트리밍(SSE)은 안 된다 — 응답을 다 모아서 돌려준다.
- **토큰 1시간 만료**: 페이지를 1시간 넘게 열어 두면 호출이 **403** 을 받는다. 페이지 코드에서 403 이면 "새로고침해 주세요" 를 띄운다(502 = 서버 꺼짐, 504 = 시간 초과도 문구를 나눠 두면 좋다).
- **주의 — 초대받은 사람은 upstream 을 호출할 수 있다.** 링크를 받은 게스트 모두가 그 서버의 `/api/*` 를 부를 수 있다는 뜻이다. 호출당 비용(LLM 토큰)·권한(파일 쓰기·외부 발송)이 있는 서버면 upstream 쪽에서 횟수 제한·허용 이메일 확인을 두고, 초대 대상을 좁힌다.

## 3. 실행

레포 루트(`/Users/ljun/dev/ljun/teamspace`)에서, **`pnpm ws` 는 다른 레포 `cd` 체인에 섞지 말고 별도 호출**로 실행한다.

```bash
# 새로 올리기 — 프로젝트에 연결하고, 외부인이면 초대 이메일 포함
pnpm ws site publish <file.html|dir|file.zip> --title "<페이지 이름>" --project <projectId> [--invite a@gmail.com,b@gmail.com]

# 같은 링크로 새 버전 — 링크를 이미 공유했다면 반드시 이쪽
pnpm ws site publish <path> --site <siteId>

pnpm ws site ls                          # 목록 (id · 제목 · 버전 · 초대 수 · 상태 · 링크)
pnpm ws site show <siteId>               # 상세 · 버전 · 초대 목록
pnpm ws site invite <siteId> <email...>  # 초대 추가
pnpm ws site uninvite <siteId> <email...>
pnpm ws site rollback <siteId> <v>       # 이전 버전으로
pnpm ws site disable|enable <siteId>     # 일시 비공개
pnpm ws site api <siteId> http://127.0.0.1:<port>   # 페이지의 fetch('api/..') 를 로컬 서버로 (해제 --off)
```

MCP 가 연결돼 있으면 `site_publish {path,title?,siteId?,invites?}` · `site_list` 도 된다.

**같은 내용을 고쳐 다시 올릴 때 새 사이트를 만들지 않는다.** 먼저 `site ls` 로 기존 siteId 를 찾고 `--site` 로 버전만 올린다 — 새로 만들면 이미 전달한 링크가 옛 내용에 머문다.

## 4. 확인

1. `pnpm ws site ls` 에 새 행(또는 올라간 버전)이 보이는지.
2. 비로그인 요청이 로그인으로 넘어가는지 — 게이트가 살아 있다는 확인:
   ```bash
   curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}\n" https://teamspace.example.com/s/<slug>
   # 307 -> .../login?callbackUrl=%2Fs%2F<slug> 이면 정상
   ```
3. 화면이 실제로 뜨는지는 로그인 세션이 있어야 볼 수 있다. 확인하지 않았다면 **확인하지 않았다고 말한다.**

## 5. 사용자에게 안내할 것

- **링크는 외부 주소로 바꿔서 준다.** CLI 는 `http://localhost:3002/s/<slug>` 를 출력하지만(웹 서비스 plist 에 `PUBLIC_BASE_URL` 이 없음) 사람에게는 `https://teamspace.example.com/s/<slug>` 를 준다.
- **초대 메일은 자동으로 가지 않는다.** 링크를 직접 전달해야 하고, 받는 사람은 **초대한 그 이메일의 Google 계정으로 로그인**해야 열린다.
- 초대 0명이면 워크스페이스 멤버만 볼 수 있다 — 외부인에게 보여줄 거면 이메일을 받아 `site invite`.
- 2번 표에서 막히는 기능(저장 유지·자동 복사 등)이 페이지에 있으면 어떻게 동작하는지 한 줄로 알린다.
- 토큰 TTL 이 1시간이라, 페이지를 오래 열어 두면 늦게 불러오는 자원이 실패할 수 있다 — 새로고침하면 복구된다.
