import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next 16 dev trusts `localhost` by default and treats `127.0.0.1` as an
  // untrusted cross-origin dev request — which silently breaks the HMR
  // websocket, so pages served on 127.0.0.1 never hydrate (buttons stay dead).
  // Trust both so the dashboard works regardless of which host you open.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
