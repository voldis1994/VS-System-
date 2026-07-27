import { mkdirSync, writeFileSync, cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const www = join(root, "www");
mkdirSync(www, { recursive: true });

const serverUrl = (process.env.CLIENT_APP_URL || "").replace(/\/$/, "");
const target = serverUrl ? `${serverUrl}/client` : "";

const html = `<!DOCTYPE html>
<html lang="lv">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1" />
  <meta name="theme-color" content="#07090c" />
  <title>VS Client</title>
  <style>
    html, body { margin:0; height:100%; background:#07090c; color:#f4f7f6; font-family: system-ui, sans-serif; }
    .wrap { min-height:100%; display:grid; place-items:center; padding:24px; text-align:center; gap:12px; }
    a.btn { display:inline-block; margin-top:12px; padding:14px 22px; border-radius:999px; background:#00ffc2; color:#031410; font-weight:800; text-decoration:none; }
    code { background:rgba(255,255,255,.08); padding:2px 6px; border-radius:6px; }
  </style>
  ${target ? `<meta http-equiv="refresh" content="0;url=${target}" />` : ""}
</head>
<body>
  <div class="wrap">
    <img src="./icon-192.png" width="84" height="84" alt="" style="border-radius:20px" />
    <h1 style="margin:0">VS Client</h1>
    ${
      target
        ? `<p>Atver aplikāciju…</p><a class="btn" href="${target}">Atvērt</a>`
        : `<p>Iestatiet <code>CLIENT_APP_URL</code> (HTTPS) un palaidiet <code>pnpm cap:sync</code>.</p>
           <p>Bez native build: Safari → <code>/client</code> → Add to Home Screen.</p>`
    }
  </div>
</body>
</html>
`;

writeFileSync(join(www, "index.html"), html);

const iconSrc = join(root, "../../apps/web/public/client-icons/icon-192.png");
if (existsSync(iconSrc)) {
  cpSync(iconSrc, join(www, "icon-192.png"));
}

console.log(
  target
    ? `www ready → ${target}`
    : "www ready (set CLIENT_APP_URL for remote WebView)",
);
