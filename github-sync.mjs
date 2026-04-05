// ══════════════════════════════════════════════════════════════════════════════
// ── GitHub-Backed Data Persistence for MindMappr ────────────────────────────
// ── Syncs data/ directory and SQLite DB to a private GitHub repo ────────────
// ══════════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, relative, dirname } from "path";

const GITHUB_API = "https://api.github.com";
const REPO_OWNER = "midnghtsapphire";
const REPO_NAME = "mindmappr-data";
const REPO_FULL = `${REPO_OWNER}/${REPO_NAME}`;
const BRANCH = "main";
const SYNC_INTERVAL_MS = 30_000; // 30 seconds
const DB_FILENAME = "mindmappr.db";
const DB_GITHUB_PATH = "mindmappr.db.b64"; // stored as base64 text on GitHub

let GITHUB_PAT = "";
let DATA_DIR = "";
let DB_PATH = "";
let dirtyFiles = new Set();
let dbDirty = false;
let syncTimer = null;
let isSyncing = false;
let lastSyncTime = null;
let syncStats = { restored: 0, synced: 0, errors: 0 };

// File SHA cache — GitHub requires SHA for updates
const shaCache = new Map();

// ── Logging ─────────────────────────────────────────────────────────────────
function log(msg) { console.log(`[DataSync] ${msg}`); }
function logError(msg) { console.error(`[DataSync] ERROR: ${msg}`); }

// ── GitHub API helpers ──────────────────────────────────────────────────────
async function ghFetch(endpoint, options = {}) {
  const url = endpoint.startsWith("http") ? endpoint : `${GITHUB_API}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `Bearer ${GITHUB_PAT}`,
      "Accept": "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });
  return res;
}

async function ghJSON(endpoint, options = {}) {
  const res = await ghFetch(endpoint, options);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// ── Repo management ─────────────────────────────────────────────────────────
async function repoExists() {
  try {
    const res = await ghFetch(`/repos/${REPO_FULL}`);
    return res.ok;
  } catch {
    return false;
  }
}

async function createRepo() {
  log(`Creating private repo ${REPO_FULL}...`);
  try {
    await ghJSON("/user/repos", {
      method: "POST",
      body: JSON.stringify({
        name: REPO_NAME,
        description: "MindMappr persistent data backup — auto-managed, do not edit manually",
        private: true,
        auto_init: true, // creates main branch with README
      }),
    });
    log(`Created repo ${REPO_FULL}`);
    // Small delay for GitHub to propagate
    await new Promise(r => setTimeout(r, 2000));
    return true;
  } catch (err) {
    logError(`Failed to create repo: ${err.message}`);
    return false;
  }
}

async function ensureRepo() {
  if (await repoExists()) {
    log(`Repo ${REPO_FULL} exists`);
    return true;
  }
  return await createRepo();
}

// ── File operations on GitHub ───────────────────────────────────────────────

/**
 * Get a file from GitHub. Returns { content, sha } or null if not found.
 */
async function getGitHubFile(path) {
  try {
    const res = await ghFetch(`/repos/${REPO_FULL}/contents/${path}?ref=${BRANCH}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    // GitHub returns base64-encoded content
    const content = Buffer.from(data.content, "base64");
    shaCache.set(path, data.sha);
    return { content, sha: data.sha };
  } catch (err) {
    if (err.message.includes("404")) return null;
    throw err;
  }
}

/**
 * Put a file to GitHub (create or update).
 */
async function putGitHubFile(path, contentBuffer, message) {
  const base64Content = contentBuffer.toString("base64");
  const body = {
    message: message || `[DataSync] Update ${path}`,
    content: base64Content,
    branch: BRANCH,
  };

  // Include SHA if we have it (required for updates)
  const cachedSha = shaCache.get(path);
  if (cachedSha) {
    body.sha = cachedSha;
  } else {
    // Try to get current SHA
    try {
      const existing = await getGitHubFile(path);
      if (existing) {
        body.sha = existing.sha;
      }
    } catch { /* file doesn't exist yet, that's fine */ }
  }

  const res = await ghFetch(`/repos/${REPO_FULL}/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    // If SHA mismatch (409), refresh SHA and retry once
    if (res.status === 409 || res.status === 422) {
      log(`SHA conflict for ${path}, refreshing and retrying...`);
      try {
        const fresh = await getGitHubFile(path);
        if (fresh) {
          body.sha = fresh.sha;
          const retry = await ghFetch(`/repos/${REPO_FULL}/contents/${path}`, {
            method: "PUT",
            body: JSON.stringify(body),
          });
          if (retry.ok) {
            const retryData = await retry.json();
            shaCache.set(path, retryData.content.sha);
            return true;
          }
        }
      } catch {}
    }
    throw new Error(`PUT ${path} failed ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await res.json();
  shaCache.set(path, data.content.sha);
  return true;
}

/**
 * List all files in the GitHub repo (recursive).
 */
async function listGitHubFiles(path = "") {
  const files = [];
  try {
    const res = await ghFetch(`/repos/${REPO_FULL}/contents/${path}?ref=${BRANCH}`);
    if (!res.ok) return files;
    const items = await res.json();
    if (!Array.isArray(items)) return files;

    for (const item of items) {
      if (item.type === "file") {
        files.push({ path: item.path, sha: item.sha, size: item.size });
        shaCache.set(item.path, item.sha);
      } else if (item.type === "dir") {
        const subFiles = await listGitHubFiles(item.path);
        files.push(...subFiles);
      }
    }
  } catch (err) {
    logError(`List files error for ${path}: ${err.message}`);
  }
  return files;
}

// ── Local file scanning ─────────────────────────────────────────────────────

/**
 * Recursively scan local data directory for all files.
 */
function scanLocalFiles(dir = DATA_DIR, base = DATA_DIR) {
  const files = [];
  if (!existsSync(dir)) return files;
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          files.push(...scanLocalFiles(fullPath, base));
        } else if (stat.isFile()) {
          const relPath = relative(base, fullPath);
          // Skip the DB file — handled separately
          if (entry === DB_FILENAME) continue;
          // Skip WAL and SHM files
          if (entry.endsWith("-wal") || entry.endsWith("-shm")) continue;
          files.push({ localPath: fullPath, githubPath: `data/${relPath}` });
        }
      } catch {}
    }
  } catch {}
  return files;
}

// ── Restore from GitHub ─────────────────────────────────────────────────────

/**
 * Restore all data from GitHub repo on startup.
 * Must be called BEFORE DB initialization and catalog seed.
 */
export async function restoreFromGitHub(dataDirPath, dbPath, pat) {
  GITHUB_PAT = pat;
  DATA_DIR = dataDirPath;
  DB_PATH = dbPath;

  if (!GITHUB_PAT) {
    log("No GITHUB_PAT set — data persistence disabled");
    return false;
  }

  log("Starting restore from GitHub...");

  try {
    // Ensure repo exists
    const exists = await ensureRepo();
    if (!exists) {
      logError("Could not ensure data repo exists");
      return false;
    }

    // List all files in the repo
    const ghFiles = await listGitHubFiles();
    if (ghFiles.length === 0) {
      log("No backup files found in GitHub repo — fresh start");
      return true;
    }

    let restoredCount = 0;

    // Restore the SQLite DB first (if it exists)
    const dbFile = ghFiles.find(f => f.path === DB_GITHUB_PATH);
    if (dbFile) {
      try {
        const result = await getGitHubFile(DB_GITHUB_PATH);
        if (result) {
          // The content is the base64-encoded DB file, stored as text
          // So result.content is Buffer of the base64 text, we need to decode it
          const dbBuffer = Buffer.from(result.content.toString("utf8"), "base64");
          // Ensure data dir exists
          mkdirSync(dirname(dbPath), { recursive: true });
          writeFileSync(dbPath, dbBuffer);
          log(`Restored SQLite DB (${(dbBuffer.length / 1024).toFixed(1)} KB)`);
          restoredCount++;
        }
      } catch (err) {
        logError(`Failed to restore DB: ${err.message}`);
      }
    }

    // Restore all other data files
    for (const ghFile of ghFiles) {
      // Skip the DB blob and README
      if (ghFile.path === DB_GITHUB_PATH || ghFile.path === "README.md") continue;

      try {
        const result = await getGitHubFile(ghFile.path);
        if (result) {
          // Map GitHub path back to local path
          // GitHub paths are like "data/MEMORY.md", "data/memory/2024-01-01.md"
          let localPath;
          if (ghFile.path.startsWith("data/")) {
            localPath = join(DATA_DIR, ghFile.path.slice(5)); // remove "data/" prefix
          } else {
            localPath = join(DATA_DIR, ghFile.path);
          }

          // Ensure directory exists
          mkdirSync(dirname(localPath), { recursive: true });
          writeFileSync(localPath, result.content);
          restoredCount++;
        }
      } catch (err) {
        logError(`Failed to restore ${ghFile.path}: ${err.message}`);
      }
    }

    syncStats.restored = restoredCount;
    log(`Restored ${restoredCount} files from GitHub`);
    return true;
  } catch (err) {
    logError(`Restore failed: ${err.message}`);
    return false;
  }
}

// ── Sync to GitHub ──────────────────────────────────────────────────────────

/**
 * Mark a file as dirty (needs syncing).
 * Call this after any data write operation.
 */
export function markDirty(filePath) {
  if (!GITHUB_PAT) return;
  if (filePath === DB_PATH || filePath.endsWith(DB_FILENAME)) {
    dbDirty = true;
  } else {
    dirtyFiles.add(filePath);
  }
}

/**
 * Mark the DB as dirty.
 */
export function markDbDirty() {
  if (!GITHUB_PAT) return;
  dbDirty = true;
}

/**
 * Perform the actual sync of dirty files to GitHub.
 */
export async function syncToGitHub(force = false) {
  if (!GITHUB_PAT) return { synced: 0, errors: 0 };
  if (isSyncing && !force) return { synced: 0, errors: 0, skipped: true };

  const filesToSync = new Set(dirtyFiles);
  const syncDb = dbDirty;

  if (filesToSync.size === 0 && !syncDb && !force) {
    return { synced: 0, errors: 0 };
  }

  isSyncing = true;
  dirtyFiles.clear();
  dbDirty = false;

  let synced = 0;
  let errors = 0;

  try {
    // Sync individual data files
    for (const localPath of filesToSync) {
      try {
        if (!existsSync(localPath)) continue;
        const content = readFileSync(localPath);
        const relPath = relative(DATA_DIR, localPath);
        const ghPath = `data/${relPath}`;
        await putGitHubFile(ghPath, content, `[DataSync] Update ${relPath}`);
        synced++;
      } catch (err) {
        logError(`Sync file ${localPath}: ${err.message}`);
        errors++;
        // Re-mark as dirty for next attempt
        dirtyFiles.add(localPath);
      }
    }

    // Sync the SQLite DB
    if (syncDb || force) {
      try {
        if (existsSync(DB_PATH)) {
          const dbContent = readFileSync(DB_PATH);
          // Store as base64 text so it's a valid UTF-8 file on GitHub
          const b64Content = Buffer.from(dbContent.toString("base64"), "utf8");
          await putGitHubFile(DB_GITHUB_PATH, b64Content, `[DataSync] Update SQLite DB`);
          synced++;
          log(`Synced SQLite DB (${(dbContent.length / 1024).toFixed(1)} KB)`);
        }
      } catch (err) {
        logError(`Sync DB: ${err.message}`);
        errors++;
        dbDirty = true; // retry next cycle
      }
    }

    if (synced > 0) {
      log(`Synced ${synced} file(s) to GitHub${errors > 0 ? ` (${errors} errors)` : ""}`);
    }

    lastSyncTime = new Date().toISOString();
    syncStats.synced += synced;
    syncStats.errors += errors;
  } finally {
    isSyncing = false;
  }

  return { synced, errors };
}

/**
 * Force a full sync — scan all local files and push everything.
 */
export async function fullSync() {
  if (!GITHUB_PAT) return { synced: 0, errors: 0 };

  log("Starting full sync...");

  // Scan all local data files
  const localFiles = scanLocalFiles();
  for (const f of localFiles) {
    dirtyFiles.add(f.localPath);
  }
  dbDirty = true;

  return await syncToGitHub(true);
}

// ── Debounced sync timer ────────────────────────────────────────────────────

/**
 * Start the periodic sync timer.
 */
export function startSyncTimer() {
  if (!GITHUB_PAT) {
    log("No GITHUB_PAT — sync timer not started");
    return;
  }

  if (syncTimer) clearInterval(syncTimer);

  syncTimer = setInterval(async () => {
    try {
      await syncToGitHub();
    } catch (err) {
      logError(`Periodic sync error: ${err.message}`);
    }
  }, SYNC_INTERVAL_MS);

  log(`Sync timer started (every ${SYNC_INTERVAL_MS / 1000}s)`);
}

/**
 * Stop the sync timer and do a final sync.
 */
export async function stopSyncTimer() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  // Final sync
  await syncToGitHub(true);
  log("Sync timer stopped, final sync complete");
}

// ── Status ──────────────────────────────────────────────────────────────────

export function getSyncStatus() {
  return {
    enabled: !!GITHUB_PAT,
    repo: REPO_FULL,
    lastSync: lastSyncTime,
    pendingFiles: dirtyFiles.size,
    dbDirty,
    isSyncing,
    stats: { ...syncStats },
  };
}

// ── Default export ──────────────────────────────────────────────────────────
export default {
  restoreFromGitHub,
  markDirty,
  markDbDirty,
  syncToGitHub,
  fullSync,
  startSyncTimer,
  stopSyncTimer,
  getSyncStatus,
};
