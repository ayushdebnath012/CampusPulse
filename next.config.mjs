/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  distDir: "dist",
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
