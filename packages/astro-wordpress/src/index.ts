import {
  mkdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { AstroIntegration } from "astro";
import glob from "fast-glob";
import respModifier from "resp-modifier";

import { rewriteLinksMiddleware } from "./utils";

interface Options {
  outDir?: string;
  devProxyTarget?: string;
}

export default function createIntegration({
  outDir = "./theme/",
  devProxyTarget,
}: Options = {}): AstroIntegration {
  let addr: AddressInfo;
  let srcDir: string;
  let pubDir: string;

  async function createDevTemplate(f: string) {
    const fname = basename(f);
    const themePath = join(outDir, fname);

    const tempPhp = `<?php
$__getDev = function() {
  $context = stream_context_create([
    "http" => [
      "method" => "GET",
      "header" => "by-pass-proxy: 1\\r\\n"
    ]
  ]);

  $base = 'http://${addr.address}:${addr.port}';
  $path = '/${fname}';

  return file_get_contents($base . $path, false, $context);
};

eval('?>'. $__getDev() . '<?php');`;

    await writeFile(themePath, tempPhp, "utf8");
  }

  async function createDevTemplates() {
    const phpAstroFiles = await glob(join(srcDir, "pages/**/*.php.astro"));
    const templates = phpAstroFiles.map((f) => basename(f).slice(0, -6));

    const promises = templates.map(async (f) => {
      await createDevTemplate(f);
    });

    const pubFiles = await glob(join(pubDir, "*"), { onlyFiles: false });
    pubFiles.forEach((f) => {
      const themePath = join(outDir, basename(f));
      promises.push(symlink(f, themePath));
    });

    await Promise.all(promises);
  }

  return {
    name: "astro-wordpress",
    hooks: {
      "astro:config:setup": ({ updateConfig }) => {
        updateConfig({
          output: "static",
          build: {
            assetsPrefix: join("/wp-content/themes", outDir),
            format: "file",
          },
        });
      },
      "astro:config:done": ({ setAdapter, config }) => {
        srcDir = fileURLToPath(config.srcDir);
        pubDir = fileURLToPath(config.publicDir);
        setAdapter({
          name: "astro-wordpress-adapter",
          supportedAstroFeatures: {
            staticOutput: "stable",
            serverOutput: "unsupported",
            hybridOutput: "unsupported",
            assets: {
              isSharpCompatible: false,
              isSquooshCompatible: false,
            },
          },
        });
      },
      "astro:server:setup": async ({ server, logger }) => {
        if (!devProxyTarget) {
          logger.warn(
            "astro-wordpress requires the `devProxyTarget` option for development mode. Skipping.",
          );
          return;
        }

        const config = server.config;

        config.server.proxy = config.server.proxy || {};
        config.server.proxy["/"] = {
          target: devProxyTarget,
          changeOrigin: true,
          autoRewrite: true,
          secure: false,
          bypass(req) {
            const url = req.url;

            if (!url) {
              return;
            }

            if (
              req.headers["by-pass-proxy"] ||
              url.startsWith("/src") ||
              url.startsWith("/@") ||
              url.startsWith("/node_modules")
            ) {
              return url;
            }
          },
        };

        const modifier = respModifier.create({
          rules: [rewriteLinksMiddleware(new URL(devProxyTarget))],
        });

        server.middlewares.use(modifier.middleware);

        await rm(outDir, { recursive: true, force: true });
        await mkdir(outDir, { recursive: true });

        server.watcher.on("all", async (event, entry) => {
          // check if file is .php.astro and inside src/pages/
          if (
            entry.endsWith(".php.astro") &&
            relative(join(srcDir, "pages"), entry) === basename(entry)
          ) {
            const phpPath = entry.slice(0, -6);

            if (event === "add") {
              await createDevTemplate(phpPath);
            } else if (event === "unlink") {
              await rm(join(outDir, basename(phpPath)), { force: true });
            }
          } else if (
            // check if entry is inside public dir
            relative(pubDir, entry) === basename(entry)
          ) {
            const themePath = join(outDir, basename(entry));
            if (event === "add" || event === "addDir") {
              await symlink(entry, themePath);
            } else if (event === "unlink" || event === "unlinkDir") {
              await unlink(themePath);
            }
          }
        });
      },
      "astro:server:start": async ({ address }) => {
        addr = address;

        await createDevTemplates();
      },
      "astro:build:done": async ({ dir: _dir, routes }) => {
        const dir = fileURLToPath(_dir);

        await rm(outDir, { recursive: true, force: true });
        await rename(dir, outDir);

        for (const route of routes) {
          const dist = route.distURL;

          if (!dist) {
            continue;
          }

          const path = fileURLToPath(dist);

          if (route.type !== "page" || !path.endsWith(".php.html")) {
            continue;
          }

          const themePath = join(outDir, relative(dir, path));
          const finalName = themePath.slice(0, -5);

          await rename(themePath, finalName);
        }
      },
    },
  };
}
