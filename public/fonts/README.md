# public/fonts — 디스플레이 폰트 드롭인

앱의 디스플레이 폰트는 **Moneygraphy Rounded**(토스 / Viva Republica)다. `app/saebit.css`
의 `@font-face` 가 아래 경로를 가리키도록 이미 배선돼 있으나, **폰트 바이너리는 이 레포에
커밋하지 않는다** — Moneygraphy 라이선스가 *수정·재배포 금지*이기 때문이다.
파일이 없으면 `var(--font-display)` 의 **Pretendard 폴백**이 그대로 쓰여 화면은 정상 동작한다.

## 활성화 방법 (선택)

1. 공식 배포처에서 웹폰트 키트를 받는다: https://toss.im/moneygraphy-font
2. 아래 파일명으로 이 디렉터리에 둔다:
   - `Moneygraphy-Rounded.woff2` (권장)
   - `Moneygraphy-Rounded.woff`
3. 빌드/새로고침하면 제목·헤딩(`.ws-db-title`, `.ws-drawer` 헤더 등)에 자동 적용된다.

> 팀 디자인 시스템(DesignSync `_ds/.../assets/fonts/`)에 이미 동일 woff 가 있으면 그걸 복사해도 된다.
> 단, 공개 레포라면 라이선스상 커밋(재배포)은 피하고 self-host 범위로만 둘 것.
