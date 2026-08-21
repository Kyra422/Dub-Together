import { access, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const source = path.resolve("node_modules/ogv/dist");
const target = path.resolve("public/ogv");

try {
  await access(source);
} catch {
  throw new Error("OGV.js assets are missing. Run npm install/npm ci first.");
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
console.log("Synced OGV.js runtime assets to public/ogv.");
