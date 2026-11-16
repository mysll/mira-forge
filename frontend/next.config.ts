import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 开发期用 localhost 打开页面时，Next 的 dev 资源会被当成跨域请求；
  // 这里显式放行两个常见写法，避免 HMR/静态资源被拦。
  allowedDevOrigins: ["localhost", "127.0.0.1"],
  // Next 的调试指示器保持默认位置（左下角）——放到右下角会在窄窗口下压住创作框。
  // 侧边栏底部因此留了额外内边距，让版本号浮在它上方。想彻底关掉就改成 false。
  devIndicators: { position: "bottom-left" },
};

export default nextConfig;
