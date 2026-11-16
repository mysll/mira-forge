import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 开发期用 localhost 打开页面时，Next 的 dev 资源会被当成跨域请求；
  // 这里显式放行两个常见写法，避免 HMR/静态资源被拦。
  allowedDevOrigins: ["localhost", "127.0.0.1"],
};

export default nextConfig;
