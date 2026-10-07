import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Repo ini memiliki lockfile stray di folder induk sehingga Turbopack salah
  // mendeteksi workspace root (muncul warning saat build). Pin root secara eksplisit.
  // https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
