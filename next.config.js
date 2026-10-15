// Κουρείο Αλέξη (Πακέτο 2, Autopilot) -- demo website on its own (e.g. on Vercel).
// The address "/" opens the site at /alexi. Links to the VGS page (/vgs…)
// go to VGS_SITE_URL when it is set, otherwise back to this site.
const vgs = (process.env.VGS_SITE_URL || "").replace(/\/$/, "");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  turbopack: { root: __dirname },
  poweredByHeader: false,
  images: { formats: ["image/avif", "image/webp"] },
  async redirects() {
    return [
      { source: "/", destination: "/alexi", permanent: false },
      { source: "/vgs", destination: vgs || "/alexi", permanent: false },
      { source: "/vgs/:path*", destination: vgs ? `${vgs}/vgs/:path*` : "/alexi", permanent: false },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
