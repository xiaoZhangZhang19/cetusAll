/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 生产环境禁用错误覆盖层
  devIndicators: {
    buildActivity: true,
    buildActivityPosition: 'bottom-right',
  },
  // Webpack 配置：忽略特定错误
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // 客户端 webpack 配置
      config.ignoreWarnings = [
        /chrome-extension/,
        /tronlinkParams/,
        /injected\.js/,
      ];
    }
    return config;
  },
};

export default nextConfig;
