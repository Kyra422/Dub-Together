import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";

const sources = [
  [".source-bundles/route.ts.gz.b64", "app/api/game/route.ts", 2],
  [".source-bundles/globals.css.gz.b64", "app/globals.css", 2],
  [".source-bundles/DubTogetherApp.tsx.gz.b64", "components/DubTogetherApp.tsx", 5],
];

for (const [bundle, target, partCount] of sources) {
  let encoded = "";
  for (let part = 1; part <= partCount; part += 1) {
    encoded += await readFile(`${bundle}.part${part}`, "utf8");
  }
  const restored = gunzipSync(Buffer.from(encoded.trim(), "base64"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, restored);
}

console.log("Restored bundled Dub Together sources.");
