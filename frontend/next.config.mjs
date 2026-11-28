/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    // SVG never goes through the image optimizer: an optimizer that serves SVG is a script-
    // injection surface. Brand SVGs are served directly from /public (next/image `unoptimized`).
    dangerouslyAllowSVG: false,
    // No remote image hosts. Add a first-party host here, explicitly, when one is needed.
    remotePatterns: [],
  },
};

export default nextConfig;
