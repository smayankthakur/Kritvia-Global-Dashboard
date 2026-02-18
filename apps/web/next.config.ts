import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: ".next-build",
  output: "standalone",
  transpilePackages: ["@kritviya/shared"]
};

export default nextConfig;
