// Production server for abracast.xyz
// Serves the built Vite app from /dist and reproduces the dev-server proxies
// (GDELT + Google News block CORS, so the browser must hit a same-origin path).
import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(
  "/gdelt",
  createProxyMiddleware({
    target: "https://api.gdeltproject.org",
    changeOrigin: true,
    pathRewrite: { "^/gdelt": "" },
  })
);

app.use(
  "/googlenews",
  createProxyMiddleware({
    target: "https://news.google.com",
    changeOrigin: true,
    pathRewrite: { "^/googlenews": "" },
  })
);

const dist = path.join(__dirname, "dist");
app.use(express.static(dist));

// SPA fallback — send index.html for any non-asset route.
app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));

const port = process.env.PORT || 4173;
app.listen(port, "0.0.0.0", () => console.log(`abracast web listening on :${port}`));
