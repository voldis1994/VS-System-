/**
 * Optional Cloudflare *quick* tunnel → local web UI (:3000).
 *
 * Quick tunnels ALWAYS get a NEW random https://….trycloudflare.com URL
 * each time you start them. That is Cloudflare's free mode — not a VS bug.
 *
 * Prefer the stable LAN URL from START-VS-SYSTEM.bat / client-url.txt:
 *   http://PC-LAN-IP:3000/client
 *
 * Use this only when clients are off your Wi‑Fi (see START-REMOTE-TUNNEL.bat).
 * For one permanent remote hostname you need a Cloudflare *named* tunnel.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const toolsDir = join(root, "tools");
const bin = join(toolsDir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
const outFile = join(root, "remote-client-url.txt");

const CF_WIN =
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";
const CF_LINUX =
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";

function download(url, dest) {
  return new Promise((resolve, reject) => {
    mkdirSync(dirname(dest), { recursive: true });
    const file = createWriteStream(dest, { mode: 0o755 });
    const get = (u, redirects = 0) => {
      https
        .get(u, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (redirects > 8) {
              reject(new Error("Too many redirects"));
              return;
            }
            get(res.headers.location, redirects + 1);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`Download failed HTTP ${res.statusCode}`));
            return;
          }
          res.pipe(file);
          file.on("finish", () => file.close(() => resolve()));
        })
        .on("error", reject);
    };
    get(url);
  });
}

async function ensureBinary() {
  if (existsSync(bin)) return bin;
  console.log("Downloading cloudflared (one-time)...");
  const url = process.platform === "win32" ? CF_WIN : CF_LINUX;
  await download(url, bin);
  console.log("cloudflared ready:", bin);
  return bin;
}

function saveUrl(url) {
  const client = url.replace(/\/$/, "") + "/client";
  writeFileSync(outFile, `${client}\n`, "utf8");
  console.log("");
  console.log("========================================");
  console.log("  REMOTE CLIENT LINK (sūti klientam):");
  console.log(`  ${client}`);
  console.log("  Saglabāts: remote-client-url.txt");
  console.log("  PC lai paliek ieslēgts + VS System skrien.");
  console.log("========================================");
  console.log("");
}

async function main() {
  const exe = await ensureBinary();
  console.log("Starting Cloudflare QUICK tunnel → http://127.0.0.1:3000 ...");
  console.log("NOTE: free quick tunnel = NEW random URL every start.");
  console.log("Stable option: same Wi-Fi → client-url.txt (LAN /client)");
  console.log("(Keep this window open while remote clients are connected)");

  const child = spawn(exe, ["tunnel", "--url", "http://127.0.0.1:3000"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let found = false;
  const onChunk = (buf) => {
    const text = buf.toString();
    process.stdout.write(text);
    const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (m && !found) {
      found = true;
      saveUrl(m[0]);
    }
  };

  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);

  child.on("exit", (code) => {
    console.error("Tunnel exited:", code);
    process.exit(code ?? 1);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
