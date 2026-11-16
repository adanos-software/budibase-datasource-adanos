import { build } from "esbuild"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises"
import { create } from "tar"

const pkg = JSON.parse(await readFile("package.json", "utf8"))
const schema = JSON.parse(await readFile("schema.json", "utf8"))
await mkdir("dist", { recursive: true })
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/plugin.min.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  minify: true,
  legalComments: "inline",
})
const bundle = await readFile("dist/plugin.min.js")
await writeFile("dist/schema.json", JSON.stringify({
  ...schema,
  hash: createHash("sha1").update(bundle).digest("hex"),
  version: pkg.version,
}, null, 2) + "\n")
await copyFile("package.json", "dist/package.json")
await copyFile("LICENSE", "dist/LICENSE")
await copyFile("README.md", "dist/README.md")
const archive = `${pkg.name}-${pkg.version}.tar.gz`
await create({ gzip: true, portable: true, cwd: "dist", file: `dist/${archive}` },
  ["plugin.min.js", "schema.json", "package.json", "LICENSE", "README.md"])
const checksum = createHash("sha256").update(await readFile(`dist/${archive}`)).digest("hex")
await writeFile(`dist/${archive}.sha256`, `${checksum}  ${archive}\n`)
