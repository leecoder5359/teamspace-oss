import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 폰 등 내부망(예: tailscale)에서 dev 서버 접속 시 cross-origin 차단 방지
  // 예: ALLOWED_DEV_ORIGINS="100.64.0.1,my-host.example.ts.net"
  allowedDevOrigins:
    process.env.ALLOWED_DEV_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [],
  // curl 설치기 원라이너: /setup.sh, /setup/hooks/<name> 을 API 라우트로 매핑.
  async rewrites() {
    return [
      { source: "/setup.sh", destination: "/api/setup/script" },
      { source: "/setup/hooks/:name", destination: "/api/setup/hooks/:name" },
    ];
  },
};

export default nextConfig;
