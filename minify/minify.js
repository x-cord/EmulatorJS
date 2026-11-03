import path from "path";
import { promises as fs } from "fs";
import { fileURLToPath } from "url";

import { rollup } from "rollup";
import terser from "@rollup/plugin-terser";
import { nodeResolve } from "@rollup/plugin-node-resolve";

import { minify } from "@node-minify/core";
import { cleanCss } from "@node-minify/clean-css";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootPath = path.resolve(__dirname, "../");

async function doMinify() {
    try {
        const bundle = await rollup({
            input: path.join(rootPath, "data/src/emulator.js"),
            context: "window",
            plugins: [nodeResolve({ browser: true }), terser({ maxWorkers: 2 })]
        });

        const output = await bundle.write({
            file: path.join(rootPath, "data/emulator.min.js"),
            format: "es",
            sourcemap: true
        });
        if (!output.output.some(chunk => chunk.type === "chunk" && chunk.isEntry && chunk.exports.includes("default"))) {
            throw new Error("The loader requires an ES-module default export");
        }
        await fs.mkdir(path.join(rootPath, "data/licenses"), { recursive: true });
        await fs.copyFile(path.join(rootPath, "node_modules/@zip.js/zip.js/LICENSE"), path.join(rootPath, "data/licenses/zip.js.txt"));
        console.log("Bundled and Minified JS");

        await minify({
            compressor: cleanCss,
            input: path.join(rootPath, "data/emulator.css"),
            output: path.join(rootPath, "data/emulator.min.css"),
        });
        console.log("Minified CSS");
    } catch(e) {
        console.error(e);
        process.exitCode = 1;
    }
}

console.log("Minifying");
(async () => {
    await doMinify();
    console.log("Minifying Done!");
})();
