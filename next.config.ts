import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 폰 등 내부망(예: tailscale)에서 dev 서버 접속 시 cross-origin 차단 방지.
  // **호스트를 코드에 박지 않는다** — 배포마다 다른 값이고, 박아 두면 이 레포를
  // 그대로 쓰는 사람이 남의 호스트를 허용 목록에 갖게 된다.
  // 예: ALLOWED_DEV_ORIGINS="100.64.0.1,my-host.example.ts.net"
  allowedDevOrigins:
    process.env.ALLOWED_DEV_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [],
  // curl 설치기 원라이너: /setup.sh, /setup/hooks/<name> 을 API 라우트로 매핑.
  async rewrites() {
    return {
      /* beforeFiles: **정적 파일 검사보다 먼저** 적용된다.
         `/uploads/*` 를 라우트로 돌리는 데 이게 꼭 필요하다 — 기본(afterFiles)이면
         `public/uploads/` 에 이미 있는 파일이 정적 서빙으로 먼저 나가서 인증
         게이트를 지나치기 때문이다(OSS 후속). 본문에 저장된 링크는
         `/uploads/<ws>/<파일>` 그대로 두고 여기서 갈아 끼운다. */
      beforeFiles: [{ source: "/uploads/:path*", destination: "/api/uploads/:path*" }],
      afterFiles: [
        { source: "/setup.sh", destination: "/api/setup/script" },
        { source: "/setup/hooks/:name", destination: "/api/setup/hooks/:name" },
      ],
    };
  },
};

export default nextConfig;
