import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const repoRoot = dirname(import.meta.dir);
const stateDir = join(repoRoot, ".codex-linux");
const downloadDir = join(stateDir, "downloads");
const extractDir = join(stateDir, "upstream");
const runtimeDir = join(stateDir, "runtime");
const electronDistDir = join(runtimeDir, "node_modules", "electron", "dist");
const runtimeResourcesDir = join(runtimeDir, "node_modules", "electron", "dist", "resources");
const tmpDir = join(stateDir, "tmp");
const bunCacheDir = join(stateDir, "bun-cache");
const dmgPath = join(downloadDir, "Codex.dmg");
const downloadMetadataPath = join(downloadDir, "Codex.dmg.metadata.json");
const metadataPath = join(stateDir, "metadata.json");
const defaultDmgUrl = "https://persistent.oaistatic.com/codex-app-prod/Codex.dmg";
const rebuildVersion = "4.0.3";
const linuxPatchVersion = 5;

type InstallMetadata = {
  appVersion: string;
  betterSqlite3Version: string;
  dmgUrl: string;
  electronVersion: string;
  etag: string | null;
  lastModified: string | null;
  linuxPatchVersion: number;
  nodePtyVersion: string;
};

type DownloadMetadata = {
  dmgUrl: string;
  etag: string | null;
  lastModified: string | null;
};

type AsarEntry = {
  files?: Record<string, AsarEntry>;
  offset?: string;
  size?: number;
  unpacked?: boolean;
};

type TextPatchRule = {
  name: string;
  replace: string | RegExp;
  with: string;
  required?: boolean;
};

async function main() {
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(downloadDir, { recursive: true });
  mkdirSync(extractDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(bunCacheDir, { recursive: true });

  await ensureCommand("curl");
  await ensureCommand("7z");
  await ensureCommand("bun");

  const dmgUrl = await resolveLatestDmgUrl();
  const remoteMetadata = await getRemoteMetadata(dmgUrl);
  const localDownloadMetadata = readDownloadMetadata();
  const hasRemoteFreshnessMarkers = remoteMetadata.etag !== null || remoteMetadata.lastModified !== null;
  const shouldDownload =
    !existsSync(dmgPath) ||
    !localDownloadMetadata ||
    localDownloadMetadata.dmgUrl !== dmgUrl ||
    (hasRemoteFreshnessMarkers &&
      (localDownloadMetadata.etag !== remoteMetadata.etag ||
        localDownloadMetadata.lastModified !== remoteMetadata.lastModified));

  if (shouldDownload) {
    console.log(`Downloading Codex from ${dmgUrl}`);
    await downloadFile(dmgUrl, dmgPath);
    writeDownloadMetadata({
      dmgUrl,
      etag: remoteMetadata.etag,
      lastModified: remoteMetadata.lastModified
    });
  } else {
    console.log(`Reusing cached download at ${relativeToRepo(dmgPath)}`);
  }

  if (
    !shouldDownload &&
    isRuntimeCurrent({
      dmgUrl,
      etag: remoteMetadata.etag,
      lastModified: remoteMetadata.lastModified
    })
  ) {
    console.log("Codex Linux runtime is already up to date.");
    return;
  }

  console.log("Extracting app resources from the macOS bundle");
  await run(
    [
      "7z",
      "x",
      "-y",
      `-o${extractDir}`,
      dmgPath,
      "Codex Installer/Codex.app/Contents/Info.plist",
      "Codex Installer/Codex.app/Contents/Resources/app.asar",
      "Codex Installer/Codex.app/Contents/Resources/app.asar.unpacked/*"
    ],
    repoRoot
  );

  const infoPlistPath = join(extractDir, "Codex Installer", "Codex.app", "Contents", "Info.plist");
  const appAsarPath = join(extractDir, "Codex Installer", "Codex.app", "Contents", "Resources", "app.asar");
  const unpackedDir = join(extractDir, "Codex Installer", "Codex.app", "Contents", "Resources", "app.asar.unpacked");

  const appVersion = extractPlistValue(readFileSync(infoPlistPath, "utf8"), "CFBundleShortVersionString");
  const appPackageJson = JSON.parse(readAsarText(appAsarPath, "/package.json"));
  const electronVersion = normalizeVersion(appPackageJson.devDependencies.electron);
  const betterSqlite3Version = readJsonFromAsar(appAsarPath, "/node_modules/better-sqlite3/package.json").version;
  const nodePtyVersion = readJsonFromAsar(appAsarPath, "/node_modules/node-pty/package.json").version;

  console.log(`Preparing Electron ${electronVersion} with Codex ${appVersion}`);
  await ensureRuntimeDependencies({
    electronVersion,
    betterSqlite3Version,
    nodePtyVersion
  });

  console.log("Syncing the Linux runtime layout");
  syncRuntime(appAsarPath, unpackedDir);
  patchRuntimeAppAsar();

  const installMetadata: InstallMetadata = {
    appVersion,
    betterSqlite3Version,
    dmgUrl,
    electronVersion,
    etag: remoteMetadata.etag,
    lastModified: remoteMetadata.lastModified,
    linuxPatchVersion,
    nodePtyVersion
  };
  writeFileSync(metadataPath, `${JSON.stringify(installMetadata, null, 2)}\n`);

  console.log("Codex Linux runtime is ready.");
  console.log(`Launch with ./launch-codex-linux.sh`);
}

async function ensureRuntimeDependencies(versions: {
  electronVersion: string;
  betterSqlite3Version: string;
  nodePtyVersion: string;
}) {
  mkdirSync(runtimeDir, { recursive: true });
  ensureRuntimeManifest();

  const installedElectronVersion = readInstalledVersion(join(runtimeDir, "node_modules", "electron", "package.json"));
  const installedBetterSqlite3Version = readInstalledVersion(
    join(runtimeDir, "node_modules", "better-sqlite3", "package.json")
  );
  const installedNodePtyVersion = readInstalledVersion(join(runtimeDir, "node_modules", "node-pty", "package.json"));
  const needsInstall =
    installedElectronVersion !== versions.electronVersion ||
    installedBetterSqlite3Version !== versions.betterSqlite3Version ||
    installedNodePtyVersion !== versions.nodePtyVersion;

  if (needsInstall) {
    console.log("Installing Electron runtime dependencies with Bun");
    await run(
      [
        process.execPath,
        "add",
        "--exact",
        `electron@${versions.electronVersion}`,
        `better-sqlite3@${versions.betterSqlite3Version}`,
        `node-pty@${versions.nodePtyVersion}`,
        `@electron/rebuild@${rebuildVersion}`
      ],
      runtimeDir
    );

    console.log("Rebuilding native modules against Electron");
    await run(
      [process.execPath, "x", "electron-rebuild", "-f", "-o", "better-sqlite3,node-pty", "-v", versions.electronVersion],
      runtimeDir
    );
  } else {
    console.log("Reusing existing Electron runtime dependencies");
  }
}

function syncRuntime(appAsarPath: string, unpackedDir: string) {
  mkdirSync(runtimeResourcesDir, { recursive: true });

  cpSync(appAsarPath, join(runtimeResourcesDir, "app.asar"));
  rmSync(join(runtimeResourcesDir, "app.asar.unpacked"), { recursive: true, force: true });
  cpSync(unpackedDir, join(runtimeResourcesDir, "app.asar.unpacked"), { recursive: true });

  overlayPackage("better-sqlite3");
  overlayPackage("node-pty");

  writeWrapper("codex");
  writeWrapper("rg");
}

function patchRuntimeAppAsar() {
  const appAsarPath = join(runtimeResourcesDir, "app.asar");
  const patchRules: TextPatchRule[] = [
    {
      name: "opaque-theme-defaults",
      replace: "opaqueWindows:!1",
      with: "opaqueWindows:!0"
    },
    {
      name: "linux-electron-opaque-class",
      replace:
        /if\((\w+)\.opaqueWindows&&!(\w+)\(\)\)\{e\.classList\.add\(`electron-opaque`\);return\}e\.classList\.remove\(`electron-opaque`\)/g,
      with: "if(($1.opaqueWindows||document.documentElement.dataset.codexOs===`linux`)&&!$2()){e.classList.add(`electron-opaque`);return}e.classList.remove(`electron-opaque`)"
    },
    {
      name: "linux-electron-background-opacity",
      replace: "background:color-mix(in srgb,var(--color-token-editor-background)55%,transparent)",
      with: "background:var(--color-token-editor-background)"
    }
  ];
  const matchCounts = new Map<string, number>();

  rewriteAsarTextFiles(appAsarPath, (entryPath, text) => {
    if (!isTextEntryPath(entryPath)) {
      return null;
    }

    let nextText = text;

    for (const rule of patchRules) {
      const patched = replaceAllWithCount(nextText, rule.replace, rule.with);
      if (patched.count > 0) {
        nextText = patched.text;
        matchCounts.set(rule.name, (matchCounts.get(rule.name) ?? 0) + patched.count);
      }
    }

    return nextText === text ? null : nextText;
  });

  const missingRules = [...new Set(patchRules.map((rule) => rule.name))]
    .filter((name) => patchRules.some((rule) => rule.name === name && rule.required !== false))
    .filter((name) => (matchCounts.get(name) ?? 0) === 0);
  if (missingRules.length > 0) {
    throw new Error(`Could not apply Linux bundle patches: ${missingRules.map((rule) => rule.name).join(", ")}`);
  }

  const summary = [...new Set(patchRules.map((rule) => rule.name))]
    .filter((name) => (matchCounts.get(name) ?? 0) > 0)
    .map((name) => `${name} x${matchCounts.get(name)}`)
    .join(", ");
  console.log(`Applied Linux UI patches (${summary})`);
}

function overlayPackage(name: string) {
  const from = join(runtimeDir, "node_modules", name);
  const to = join(runtimeResourcesDir, "app.asar.unpacked", "node_modules", name);
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
}

function writeWrapper(name: "codex" | "rg") {
  const wrapperPath = join(runtimeResourcesDir, name);
  writeFileSync(
    wrapperPath,
    [
      "#!/usr/bin/env sh",
      "set -eu",
      "",
      `if ! command -v ${name} >/dev/null 2>&1; then`,
      `  echo \"${name} is not on PATH. Install it first, then relaunch Codex.\" >&2`,
      "  exit 127",
      "fi",
      "",
      `exec ${name} \"$@\"`
    ].join("\n")
  );
  chmodSync(wrapperPath, 0o755);
}

function ensureRuntimeManifest() {
  const manifestPath = join(runtimeDir, "package.json");
  if (!existsSync(manifestPath)) {
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          name: "codex-desktop-linux-runtime",
          private: true
        },
        null,
        2
      )}\n`
    );
  }
}

async function resolveLatestDmgUrl() {
  try {
    const response = await fetch("https://chatgpt.com/features/codex-get-started");
    if (response.ok) {
      const html = await response.text();
      const match = html.match(/https:\/\/persistent\.oaistatic\.com\/[^"'\\\s>]*Codex\.dmg/);
      if (match) {
        return match[0];
      }
    }
  } catch (error) {
    console.warn(`Falling back to the default Codex download URL: ${formatError(error)}`);
  }

  return defaultDmgUrl;
}

async function getRemoteMetadata(url: string) {
  try {
    const response = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (response.ok) {
      return {
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified")
      };
    }
  } catch (error) {
    console.warn(`Could not fetch remote metadata for ${url}: ${formatError(error)}`);
  }

  return {
    etag: null,
    lastModified: null
  };
}

async function downloadFile(url: string, destination: string) {
  await run(["curl", "-L", "-o", destination, url], repoRoot);
}

function readDownloadMetadata(): DownloadMetadata | null {
  if (!existsSync(downloadMetadataPath)) {
    return null;
  }

  return readJson(downloadMetadataPath) as DownloadMetadata;
}

function writeDownloadMetadata(metadata: DownloadMetadata) {
  writeFileSync(downloadMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

function readInstallMetadata(): InstallMetadata | null {
  if (!existsSync(metadataPath)) {
    return null;
  }

  return readJson(metadataPath) as InstallMetadata;
}

function isRuntimeCurrent(expected: DownloadMetadata) {
  const installMetadata = readInstallMetadata();
  if (!installMetadata) {
    return false;
  }

  return (
    installMetadata.linuxPatchVersion === linuxPatchVersion &&
    installMetadata.dmgUrl === expected.dmgUrl &&
    installMetadata.etag === expected.etag &&
    installMetadata.lastModified === expected.lastModified &&
    existsSync(join(electronDistDir, "electron")) &&
    existsSync(join(runtimeResourcesDir, "app.asar")) &&
    existsSync(join(runtimeResourcesDir, "app.asar.unpacked")) &&
    existsSync(join(runtimeResourcesDir, "codex")) &&
    existsSync(join(runtimeResourcesDir, "rg"))
  );
}

function readInstalledVersion(path: string) {
  if (!existsSync(path)) {
    return null;
  }

  return readJson(path).version as string;
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonFromAsar(asarPath: string, targetPath: string) {
  return JSON.parse(readAsarText(asarPath, targetPath));
}

function extractPlistValue(xml: string, key: string) {
  const match = xml.match(new RegExp(`<key>${escapeRegExp(key)}</key>\\s*<string>([^<]+)</string>`));
  if (!match) {
    throw new Error(`Could not find ${key} in Info.plist`);
  }

  return match[1];
}

function readAsarText(asarPath: string, targetPath: string) {
  const bytes = readFileSync(asarPath);
  const { dataOffset, header } = readAsarHeader(bytes);
  const entry = getAsarEntry(header, targetPath);

  if (entry.unpacked) {
    throw new Error(`${targetPath} is unpacked and should be read from app.asar.unpacked`);
  }

  if (entry.offset == null || entry.size == null) {
    throw new Error(`Could not resolve ${targetPath} inside ${asarPath}`);
  }

  const dataStart = dataOffset + Number(entry.offset);
  const dataEnd = dataStart + entry.size;
  return new TextDecoder().decode(bytes.subarray(dataStart, dataEnd));
}

function getAsarEntry(header: AsarEntry, targetPath: string) {
  const parts = targetPath.split("/").filter(Boolean);
  let current = header;

  for (const part of parts) {
    current = current.files?.[part] as AsarEntry;
    if (!current) {
      throw new Error(`Missing ${targetPath} in ASAR header`);
    }
  }

  return current;
}

function readAsarHeader(bytes: Uint8Array) {
  const headerSize = readUint32LE(bytes, 12);
  const dataOffset = 8 + readUint32LE(bytes, 4);
  const headerText = new TextDecoder().decode(bytes.subarray(16, 16 + headerSize));
  return {
    dataOffset,
    header: JSON.parse(headerText) as AsarEntry,
    headerSize
  };
}

function rewriteAsarTextFiles(
  asarPath: string,
  transform: (entryPath: string, text: string) => string | null
) {
  const bytes = readFileSync(asarPath);
  const { dataOffset: inputDataOffset, header } = readAsarHeader(bytes);
  const files: Array<{ bytes: Uint8Array; entry: AsarEntry }> = [];
  const encoder = new TextEncoder();

  walkAsarFiles(header, "", (entryPath, entry) => {
    if (entry.unpacked) {
      return;
    }

    if (entry.offset == null || entry.size == null) {
      throw new Error(`Could not resolve ${entryPath} inside ${asarPath}`);
    }

    const dataStart = inputDataOffset + Number(entry.offset);
    const dataEnd = dataStart + entry.size;
    const originalBytes = bytes.subarray(dataStart, dataEnd);
    let nextBytes = Uint8Array.from(originalBytes);

    if (isTextEntryPath(entryPath)) {
      const originalText = new TextDecoder().decode(originalBytes);
      const nextText = transform(entryPath, originalText);
      if (nextText !== null && nextText !== originalText) {
        nextBytes = encoder.encode(nextText);
      }
    }

    files.push({ bytes: nextBytes, entry });
  });

  let outputSize = 0;
  for (const file of files) {
    file.entry.offset = String(outputSize);
    file.entry.size = file.bytes.byteLength;
    outputSize += file.bytes.byteLength;
  }

  const headerBytes = encoder.encode(JSON.stringify(header));
  const alignedHeaderPayloadSize = alignTo4(4 + headerBytes.byteLength);
  const outputDataOffset = 8 + 4 + alignedHeaderPayloadSize;
  const output = new Uint8Array(outputDataOffset + outputSize);
  writeUint32LE(output, 0, 4);
  writeUint32LE(output, 4, 4 + alignedHeaderPayloadSize);
  writeUint32LE(output, 8, alignedHeaderPayloadSize);
  writeUint32LE(output, 12, headerBytes.byteLength);
  output.set(headerBytes, 16);

  let outputOffset = outputDataOffset;
  for (const file of files) {
    output.set(file.bytes, outputOffset);
    outputOffset += file.bytes.byteLength;
  }

  writeFileSync(asarPath, output);
}

function walkAsarFiles(
  entry: AsarEntry,
  prefix: string,
  visit: (entryPath: string, child: AsarEntry) => void
) {
  for (const [name, child] of Object.entries(entry.files ?? {})) {
    const entryPath = `${prefix}/${name}`;
    if (child.files) {
      walkAsarFiles(child, entryPath, visit);
      continue;
    }

    visit(entryPath, child);
  }
}

function isTextEntryPath(entryPath: string) {
  return entryPath.endsWith(".css") || entryPath.endsWith(".js") || entryPath.endsWith(".json");
}

function replaceAllWithCount(text: string, search: string | RegExp, replacement: string) {
  if (search instanceof RegExp) {
    const globalSearch = search.global ? search : new RegExp(search.source, `${search.flags}g`);
    const matches = Array.from(text.matchAll(globalSearch)).length;
    return {
      count: matches,
      text: matches === 0 ? text : text.replace(globalSearch, replacement)
    };
  }

  const parts = text.split(search);
  return {
    count: parts.length - 1,
    text: parts.join(replacement)
  };
}

function readUint32LE(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
}

function writeUint32LE(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function alignTo4(value: number) {
  return (value + 3) & ~3;
}

function normalizeVersion(version: string) {
  return version.replace(/^[^\d]*/, "");
}

async function ensureCommand(command: string) {
  if (!Bun.which(command)) {
    throw new Error(`${command} is required but was not found`);
  }
}

async function run(command: string[], cwd: string) {
  const executable = command[0].startsWith("/") ? command[0] : Bun.which(command[0]) ?? command[0];
  const proc = Bun.spawn([executable, ...command.slice(1)], {
    cwd,
    env: {
      ...process.env,
      BUN_INSTALL_CACHE_DIR: process.env.BUN_INSTALL_CACHE_DIR ?? bunCacheDir,
      BUN_TMPDIR: process.env.BUN_TMPDIR ?? tmpDir,
      TMPDIR: process.env.TMPDIR ?? tmpDir
    },
    stdout: "inherit",
    stderr: "inherit"
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${command.join(" ")}`);
  }
}

function relativeToRepo(path: string) {
  return path.startsWith(`${repoRoot}/`) ? path.slice(repoRoot.length + 1) : path;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

await main();
