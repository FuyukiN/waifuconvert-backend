const express = require("express")
const cors = require("cors")
const { spawn } = require("child_process")
const fs = require("fs")
const path = require("path")
const rateLimit = require("express-rate-limit")
const helmet = require("helmet")
const validator = require("validator")
const crypto = require("crypto")

const app = express()

// Trust Railway's reverse proxy for accurate rate limiting
app.set("trust proxy", true)

// --- Constants ---
const PORT = process.env.PORT || 8080
const MAX_CONCURRENT_DOWNLOADS = 4
const MAX_FILE_SIZE = 512 * 1024 * 1024 // 512MB
const MAX_DURATION = 7200 // 2 hours in seconds
const DOWNLOADS = path.join(__dirname, "downloads")
const COOKIES_DIR = path.join(__dirname, "cookies")
const ytDlpPath = "yt-dlp"

// Interval handles (stored so they can be cleared on shutdown)
let memoryCleanupInterval = null
let fileCleanupInterval = null
let ytDlpUpdateInterval = null

let activeDownloads = 0
let lastActivity = Date.now()

// --- Allowed domains whitelist ---
const ALLOWED_DOMAINS = [
  "tiktok.com", "vm.tiktok.com", "vt.tiktok.com", "m.tiktok.com", "www.tiktok.com",
  "twitter.com", "x.com", "t.co", "mobile.twitter.com", "www.twitter.com", "www.x.com",
  "instagram.com", "www.instagram.com", "m.instagram.com",
  "youtube.com", "youtu.be", "www.youtube.com", "m.youtube.com", "music.youtube.com",
  "reddit.com", "www.reddit.com", "old.reddit.com", "m.reddit.com", "new.reddit.com",
  "facebook.com", "fb.watch", "www.facebook.com", "m.facebook.com", "web.facebook.com",
  "twitch.tv", "clips.twitch.tv", "www.twitch.tv",
  "soundcloud.com", "www.soundcloud.com", "m.soundcloud.com",
  "vimeo.com", "www.vimeo.com", "player.vimeo.com",
  "dailymotion.com", "www.dailymotion.com",
  "streamable.com", "www.streamable.com",
]

// Rotate through these user agents to reduce bot detection
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/120.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0",
]

// --- Cookie pools (loaded from env vars on startup) ---
let googleCookiePool = []
let instagramCookiePool = []
let twitterCookiePool = []
let generalCookiePool = []

// In-memory map of download keys → file paths (avoids exposing real paths to clients)
const fileMap = new Map()

// ============================================================
// MEMORY MANAGEMENT
// YouTube token algorithms change every 2-4 weeks, so we keep
// memory lean to avoid OOM restarts on Railway's limited RAM.
// ============================================================

function forceGarbageCollection() {
  try {
    if (typeof global.gc === "function") {
      const before = process.memoryUsage().heapUsed
      global.gc()
      const freed = Math.round((before - process.memoryUsage().heapUsed) / 1024 / 1024)
      console.log(`[GC] Native GC freed ${freed}MB`)
      return freed
    }

    // Fallback: create memory pressure to hint the V8 GC
    const dummy = new Array(1000000).fill("x")
    dummy.length = 0
    console.log("[GC] Native GC unavailable - used manual pressure hint")
    return 0
  } catch (err) {
    console.error("[GC] Error during garbage collection:", err.message)
    return 0
  }
}

function runMemoryCleanup() {
  const before = process.memoryUsage()
  forceGarbageCollection()

  // Clear non-essential require cache entries
  if (require.cache) {
    const essential = ["express", "cors", "helmet", "validator", "child_process", "fs", "path", "rate-limit", "crypto", "v8"]
    let cleared = 0
    for (const key of Object.keys(require.cache)) {
      if (!essential.some((m) => key.includes(m)) && !key.includes("node_modules") && key.startsWith(process.cwd())) {
        try { delete require.cache[key]; cleared++ } catch (_) {}
      }
    }
    if (cleared > 0) console.log(`[GC] Cleared ${cleared} require cache entries`)
  }

  const freed = Math.round((before.heapUsed - process.memoryUsage().heapUsed) / 1024 / 1024)
  console.log(`[GC] Cleanup complete. Freed ~${freed}MB. Heap: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`)
}

function logMemoryUsage() {
  const used = process.memoryUsage()
  const mb = (b) => Math.round(b / 1024 / 1024)
  console.log(`[MEM] Heap: ${mb(used.heapUsed)}MB / RSS: ${mb(used.rss)}MB / External: ${mb(used.external)}MB`)

  if (used.heapUsed > 200 * 1024 * 1024) {
    console.warn("[MEM] High memory usage detected - triggering cleanup")
    runMemoryCleanup()
  }

  return { heapUsed: mb(used.heapUsed), rss: mb(used.rss), external: mb(used.external) }
}

// ============================================================
// YT-DLP AUTO UPDATE
// YouTube breaks yt-dlp every 2-4 weeks by changing their
// token-signing algorithm (nsig/sig). Keeping yt-dlp updated
// automatically prevents the need for manual redeploys.
// ============================================================

async function ensureYtDlpUpdated() {
  try {
    console.log("[YT-DLP] Checking for updates...")
    await executeSecureCommand("pip", ["install", "--upgrade", "yt-dlp[default]"], { timeout: 60000 })
    const { stdout } = await executeSecureCommand("yt-dlp", ["--version"], { timeout: 10000 })
    console.log(`[YT-DLP] Updated successfully. Version: ${stdout.trim()}`)
    return true
  } catch (err) {
    console.warn("[YT-DLP] Update failed (will use current version):", err.message)
    return false
  }
}

// ============================================================
// COOKIE MANAGEMENT
// Cookies are stored as Railway environment variables and
// written to disk as Netscape-format .txt files on startup.
// ============================================================

// Validates Netscape cookie file format (tab-separated, 6+ fields)
function validateCookieFormat(cookieContent) {
  if (!cookieContent || cookieContent.length < 10) return { valid: false, reason: "Too short or empty", validLines: 0 }

  let validLines = 0
  const issues = []

  for (const [i, rawLine] of cookieContent.split("\n").entries()) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue

    const fields = line.split("\t")
    if (fields.length >= 6) {
      validLines++
      if (!fields[0].includes(".")) issues.push(`Line ${i + 1}: suspicious domain "${fields[0]}"`)
      const exp = Number.parseInt(fields[4])
      if (exp && exp < Date.now() / 1000) issues.push(`Line ${i + 1}: expired cookie "${fields[5]}"`)
    } else {
      issues.push(`Line ${i + 1}: invalid format (${fields.length} fields, need >= 6)`)
    }
  }

  return { valid: validLines > 0, validLines, issues, reason: validLines === 0 ? "No valid lines found" : null }
}

// Checks that Twitter-specific required cookies are present
function validateTwitterCookies(cookieContent) {
  const found = new Set()
  for (const line of cookieContent.split("\n")) {
    const fields = line.trim().split("\t")
    if (fields.length >= 6) found.add(fields[5])
  }

  const criticalMissing = ["auth_token", "ct0"].filter((c) => !found.has(c))
  return {
    valid: criticalMissing.length === 0,
    nsfwReady: criticalMissing.length === 0,
    criticalMissing,
    foundCookies: Array.from(found),
  }
}

// Reads cookie env vars, writes them to disk, and populates cookie pools
function createSecureCookieFiles() {
  if (!fs.existsSync(COOKIES_DIR)) fs.mkdirSync(COOKIES_DIR, { recursive: true, mode: 0o700 })

  let created = 0
  const writeIfValid = (envVar, filename) => {
    const content = process.env[envVar]
    if (!content || content.length <= 100) return

    const filepath = path.join(COOKIES_DIR, filename)
    const validation = validateCookieFormat(content)
    fs.writeFileSync(filepath, content, { mode: 0o600 })
    console.log(`[COOKIES] Written ${filename} (${validation.validLines} valid lines${validation.valid ? "" : " - WARNING: format issues"})`)
    created++
  }

  for (let i = 1; i <= 10; i++) writeIfValid(`GOOGLE_COOKIE_${String(i).padStart(2, "0")}`, `google_conta${String(i).padStart(2, "0")}.txt`)
  for (let i = 1; i <= 8; i++) writeIfValid(`INSTAGRAM_COOKIE_${String(i).padStart(2, "0")}`, `instagram_conta${String(i).padStart(2, "0")}.txt`)
  for (let i = 1; i <= 5; i++) {
    const envVar = `TWITTER_COOKIE_${String(i).padStart(2, "0")}`
    const content = process.env[envVar]
    if (content && content.length > 100) {
      const filename = `twitter_conta${String(i).padStart(2, "0")}.txt`
      fs.writeFileSync(path.join(COOKIES_DIR, filename), content, { mode: 0o600 })
      const tw = validateTwitterCookies(content)
      console.log(`[COOKIES] Written ${filename} - NSFW ready: ${tw.nsfwReady}${tw.criticalMissing.length ? " (missing: " + tw.criticalMissing.join(", ") + ")" : ""}`)
      created++
    }
  }

  console.log(`[COOKIES] Total cookie files created: ${created}`)
  return created
}

function loadCookiePool() {
  if (!fs.existsSync(COOKIES_DIR)) { fs.mkdirSync(COOKIES_DIR, { recursive: true }); return }

  const files = fs.readdirSync(COOKIES_DIR).filter((f) => f.endsWith(".txt"))
  googleCookiePool = files.filter((f) => f.startsWith("google_")).map((f) => path.join(COOKIES_DIR, f))
  instagramCookiePool = files.filter((f) => f.startsWith("instagram_")).map((f) => path.join(COOKIES_DIR, f))
  twitterCookiePool = files.filter((f) => f.startsWith("twitter_")).map((f) => path.join(COOKIES_DIR, f))
  generalCookiePool = files.map((f) => path.join(COOKIES_DIR, f))

  console.log(`[COOKIES] Pools loaded - Google: ${googleCookiePool.length}, Instagram: ${instagramCookiePool.length}, Twitter: ${twitterCookiePool.length}, Total: ${generalCookiePool.length}`)
}

// Returns the best cookie file for the given platform
function getSmartCookie(platform) {
  const poolMap = {
    youtube: googleCookiePool,
    reddit: googleCookiePool,
    twitter: twitterCookiePool.length > 0 ? twitterCookiePool : googleCookiePool,
    x: twitterCookiePool.length > 0 ? twitterCookiePool : googleCookiePool,
    instagram: instagramCookiePool,
  }
  const pool = poolMap[platform] || generalCookiePool
  if (!pool.length) { console.log(`[COOKIES] No cookie available for platform: ${platform}`); return null }

  const selected = pool[Math.floor(Math.random() * pool.length)]
  console.log(`[COOKIES] Selected for ${platform}: ${path.basename(selected)}`)
  return selected
}

// ============================================================
// COMMAND EXECUTION
// ============================================================

// Runs a child process safely and resolves with stdout/stderr.
// yt-dlp often exits with code 1 even on partial success (e.g. subtitle
// download failed), so we only reject if there is no usable output.
function executeSecureCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || 600000
    console.log(`[EXEC] ${command} ${args.slice(0, 4).join(" ")} ...`)

    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], killSignal: "SIGKILL" })
    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (d) => { stdout += d.toString() })
    child.stderr.on("data", (d) => { stderr += d.toString() })

    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Command timed out")) }, timeout)

    child.on("close", (code) => {
      clearTimeout(timer)
      // Resolve if: success, OR has output (partial success with warnings), OR stderr has no real "error" keyword
      if (code === 0 || stdout.length > 0 || (stderr && !stderr.toLowerCase().includes("error"))) {
        resolve({ stdout, stderr })
      } else {
        reject(new Error(`Command failed (exit ${code}): ${stderr.substring(0, 500)}`))
      }
    })

    child.on("error", reject)
  })
}

// ============================================================
// FORMAT SELECTION
// yt-dlp format strings that respect the requested quality.
// Falls back progressively to avoid "format not available" errors.
// ============================================================

function getFormatSelector(format, quality, platform) {
  if (format === "mp3") return "bestaudio/best"

  const h = Number.parseInt(quality)

  if (platform === "youtube") {
    if (h && !isNaN(h)) {
      return (
        `bestvideo[vcodec^=avc1][height<=${h}]+bestaudio[acodec^=mp4a]` +
        `/bestvideo[vcodec^=avc1][height<=${h}]+bestaudio` +
        `/bestvideo[height<=${h}]+bestaudio` +
        `/best[height<=${h}]` +
        `/bestvideo+bestaudio/best`
      )
    }
    return "bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo[vcodec^=avc1]+bestaudio/bestvideo+bestaudio/best"
  }

  if (h && !isNaN(h)) return `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`
  return "best"
}

// Simplified fallback format selector used when the primary one fails
function getSimpleFormatSelector(format, quality) {
  if (format === "mp3") return "bestaudio[ext=m4a]/bestaudio/best"
  const h = Number.parseInt(quality)
  return h && !isNaN(h) ? `best[height<=${h}]/best` : "best"
}

// ============================================================
// YT-DLP ARGUMENT BUILDERS
// ============================================================

// Base args applied to all platforms
function buildSecureCommand(userAgent, cookieFile, platform) {
  const args = [
    "--user-agent", userAgent,
    "--no-playlist",
    "--no-check-certificates",
    "--extractor-retries", "3",
    "--fragment-retries", "3",
    "--retry-sleep", "2",
    "--geo-bypass",
    "--socket-timeout", "30",
    "--no-warnings",
    "--ignore-errors",
    "--ignore-no-formats-error",
  ]

  if (platform === "tiktok") args.push("--no-part", "--concurrent-fragments", "1")
  if (platform === "instagram") args.push("--sleep-interval", "1", "--max-sleep-interval", "2")
  if (platform === "twitter") args.push("--sleep-interval", "1")

  // YouTube requires a JS runtime to solve token challenges (yt-dlp 2025+)
  if (platform === "youtube") args.push("--js-runtimes", "node", "--no-abort-on-error", "--ignore-no-formats-error")

  if (cookieFile) args.push("--cookies", cookieFile)
  return args
}

// Three increasingly lenient strategies for bypassing YouTube bot detection
class YouTubeBypassStrategies {
  static strategy1(userAgent, cookieFile) {
    const args = [
      "--user-agent", userAgent,
      "--js-runtimes", "node",
      "--referer", "https://www.youtube.com/",
      "--add-header", "Accept-Language:en-US,en;q=0.9",
      "--add-header", "Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "--sleep-interval", "1",
      "--max-sleep-interval", "3",
      "--extractor-retries", "5",
      "--fragment-retries", "5",
      "--retry-sleep", "2",
      "--no-warnings", "--no-playlist", "--geo-bypass", "--ignore-errors",
    ]
    if (cookieFile) args.push("--cookies", cookieFile)
    return args
  }

  static strategy2(userAgent) {
    return [
      "--user-agent", userAgent,
      "--js-runtimes", "node",
      "--referer", "https://www.youtube.com/",
      "--add-header", "Accept-Language:en-US,en;q=0.9",
      "--add-header", "Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "--sleep-interval", "2",
      "--max-sleep-interval", "5",
      "--extractor-retries", "3",
      "--fragment-retries", "3",
      "--retry-sleep", "3",
      "--no-warnings", "--no-playlist", "--geo-bypass", "--ignore-errors", "--no-check-certificates",
    ]
  }

  static strategy3(userAgent, cookieFile) {
    const args = [
      "--user-agent", userAgent,
      "--js-runtimes", "node",
      "--referer", "https://www.youtube.com/",
      "--add-header", "Accept-Language:en-US,en;q=0.9",
      "--sleep-interval", "3",
      "--max-sleep-interval", "7",
      "--extractor-retries", "2",
      "--fragment-retries", "2",
      "--retry-sleep", "5",
      "--no-warnings", "--no-playlist", "--geo-bypass", "--ignore-errors", "--compat-options", "all",
    ]
    if (cookieFile) args.push("--cookies", cookieFile)
    return args
  }
}

// ============================================================
// ERROR CLASSIFICATION
// ============================================================

function isYouTubeCriticalError(msg) {
  const patterns = [
    "did not get any data blocks",
    "unable to download video data",
    "this video is unavailable",
    "video unavailable",
    "this video has been removed",
    "this video is private",
  ]
  return patterns.some((p) => msg.toLowerCase().includes(p))
}

function isFormatNotAvailableError(msg) {
  return msg.toLowerCase().includes("requested format is not available")
}

function isYouTubeEmptyFileError(msg) {
  return ["did not get any data blocks", "no data blocks received", "failed to download any fragments",
    "unable to download webpage", "file is too short"].some((p) => msg.toLowerCase().includes(p))
}

function isAuthenticationError(msg) {
  return ["requires authentication", "requiring login", "nsfw tweet", "private video", "private account",
    "login required", "sign in to confirm", "use --cookies", "not a bot", "captcha", "verification",
    "blocked", "rate limit", "requested content is not available", "rate-limit reached",
    "general metadata extraction failed", "unable to extract shared data",
    "the following content is not available on this app", "watch on the latest version of youtube",
    "could not authenticate you", "error(s) while querying api"].some((p) => msg.toLowerCase().includes(p))
}

function isNonCriticalError(msg) {
  return ["impersonation", "impersonate target", "subtitle", "unable to download video subtitles",
    "http error 429", "too many requests", "warning:", "deprecated feature", "deprecated"].some((p) => msg.toLowerCase().includes(p))
}

// ============================================================
// DURATION / FILENAME HELPERS
// ============================================================

function parseDurationString(str) {
  if (typeof str === "number") return str
  const parts = String(str).split(":").reverse()
  return (Number.parseInt(parts[0]) || 0) +
    (Number.parseInt(parts[1]) || 0) * 60 +
    (Number.parseInt(parts[2]) || 0) * 3600
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60), s = seconds % 60
    return s ? `${m}m ${s}s` : `${m}m`
  }
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60)
  return m ? `${h}h ${m}m` : `${h}h`
}

function checkDuration(duration) {
  if (!duration || duration <= 0) return { allowed: true, duration_formatted: "unknown" }
  const sec = typeof duration === "string" ? parseDurationString(duration) : duration
  if (sec > MAX_DURATION) {
    return { allowed: false, message: `Video too long. Max: ${formatDuration(MAX_DURATION)}, your video: ${formatDuration(sec)}`,
      duration_formatted: formatDuration(sec), max_duration: formatDuration(MAX_DURATION) }
  }
  return { allowed: true, duration_formatted: formatDuration(sec) }
}

function sanitizeInput(input, maxLength = 100) {
  if (typeof input !== "string") return ""
  return input.trim().substring(0, maxLength).replace(/[<>"'&]/g, "").replace(/\0/g, "")
}

function generateSecureFilename(title, quality, format, uniqueId) {
  const safe = (sanitizeInput(title, 50).replace(/[^\w\s\-_.()]/g, "").replace(/\s+/g, "_").replace(/_{2,}/g, "_").trim()) || "WaifuConvert"
  const qualLabel = format === "mp3" ? `${quality || "best"}kbps` : `${quality || "best"}p`
  return `${safe}-${qualLabel}-${uniqueId}.${format === "mp3" ? "mp3" : "mp4"}`
}

// ============================================================
// VALIDATION
// ============================================================

function isValidUrl(url) {
  try {
    if (!validator.isURL(url, { protocols: ["http", "https"], require_protocol: true, require_valid_protocol: true,
      allow_underscores: true, allow_trailing_dot: false, allow_protocol_relative_urls: false,
      allow_fragments: true, allow_query_components: true })) return false

    const hostname = new URL(url).hostname.toLowerCase()

    const isAllowed = ALLOWED_DOMAINS.some((domain) => {
      if (hostname === domain || hostname.endsWith("." + domain)) return true
      if (domain === "tiktok.com" && (hostname.includes("tiktok") || hostname.includes("musically"))) return true
      if (domain === "twitter.com" && (hostname.includes("twitter") || hostname.includes("x.com") || hostname.includes("twimg"))) return true
      if (domain === "youtube.com" && (hostname.includes("youtube") || hostname.includes("youtu"))) return true
      if (domain === "instagram.com" && (hostname.includes("instagram") || hostname.includes("cdninstagram"))) return true
      return false
    })
    if (!isAllowed) { console.warn(`[VALIDATE] Blocked domain: ${hostname}`); return false }

    const privateIp = [/^127\./, /^192\.168\./, /^10\./, /^172\.(1[6-9]|2[0-9]|3[0-1])\./, /^0\.0\.0\.0$/, /^localhost$/i]
    if (privateIp.some((r) => r.test(hostname))) { console.warn(`[VALIDATE] Private IP blocked: ${hostname}`); return false }

    return true
  } catch { return false }
}

function validateDownloadParams(url, format, quality) {
  const errors = []
  if (!url || typeof url !== "string") {
    errors.push("Please provide a valid URL")
  } else if (!isValidUrl(url)) {
    try {
      const hostname = new URL(url).hostname.toLowerCase()
      if (hostname.includes("localhost") || hostname.startsWith("127.") || hostname.startsWith("192.168.")) {
        errors.push("Local URLs are not allowed")
      } else {
        errors.push("This site is not supported. Try: TikTok, Twitter/X, Instagram, YouTube, Reddit, Facebook, Twitch, SoundCloud, Vimeo")
      }
    } catch { errors.push("Invalid URL. Make sure to copy the full URL (including https://)") }
  }

  if (!format || !["mp3", "mp4"].includes(format)) errors.push("Choose MP3 (audio) or MP4 (video)")

  if (quality) {
    const q = Number.parseInt(quality)
    if (format === "mp3" && (q < 64 || q > 320)) errors.push("Audio quality must be between 64 and 320 kbps")
    else if (format === "mp4" && ![144, 240, 360, 480, 720, 1080].includes(q)) errors.push("Video quality must be 144p, 240p, 360p, 480p, 720p or 1080p")
  }

  return errors
}

// ============================================================
// PLATFORM DETECTION
// ============================================================

function detectPlatform(url) {
  try {
    const h = new URL(url).hostname.toLowerCase()
    if (h.includes("tiktok")) return "tiktok"
    if (h.includes("twitter") || h.includes("x.com")) return "twitter"
    if (h.includes("youtube") || h.includes("youtu.be")) return "youtube"
    if (h.includes("instagram")) return "instagram"
    if (h.includes("reddit")) return "reddit"
    if (h.includes("facebook")) return "facebook"
    return "unknown"
  } catch { return "unknown" }
}

// ============================================================
// FILE HELPERS
// ============================================================

// Finds the most recently modified matching file (used when yt-dlp
// changes the output filename due to format negotiation)
function findRecentFile(baseDir, timestamp, extensions = [".mp4", ".mp3"]) {
  try {
    const recent = fs.readdirSync(baseDir)
      .filter((f) => {
        const mt = fs.statSync(path.join(baseDir, f)).mtime.getTime()
        return Math.abs(mt - timestamp) < 300000 && extensions.some((e) => f.toLowerCase().endsWith(e))
      })
      .sort((a, b) => fs.statSync(path.join(baseDir, b)).mtime.getTime() - fs.statSync(path.join(baseDir, a)).mtime.getTime())

    return recent.length ? path.join(baseDir, recent[0]) : null
  } catch { return null }
}

function cleanupOldFiles() {
  try {
    const cutoff = Date.now() - 60 * 60 * 1000 // 1 hour
    for (const file of fs.readdirSync(DOWNLOADS)) {
      const filePath = path.join(DOWNLOADS, file)
      if (fs.statSync(filePath).mtime.getTime() < cutoff) {
        fs.unlinkSync(filePath)
        console.log(`[CLEANUP] Deleted old file: ${file}`)
        for (const [key, val] of fileMap.entries()) {
          if (val.actualPath === filePath) { fileMap.delete(key); break }
        }
      }
    }
  } catch (err) { console.error("[CLEANUP] Error cleaning files:", err.message) }
}

// ============================================================
// VIDEO INFO EXTRACTION
// ============================================================

// Light fallback when JSON extraction fails - gets just title and duration
async function getVideoInfoWithoutJson(url, userAgent, cookieFile, platform) {
  console.log("[INFO] Attempting title/duration fallback extraction")
  const args = ["--user-agent", userAgent, "--js-runtimes", "node", "--no-playlist", "--get-title", "--get-duration"]
  if (cookieFile && fs.existsSync(cookieFile)) args.push("--cookies", cookieFile)
  args.push(url)

  try {
    const { stdout } = await executeSecureCommand(ytDlpPath, args, { timeout: 30000 })
    const lines = stdout.split("\n").filter((l) => l.trim())
    if (lines.length >= 1) return { title: lines[0] || "Video", duration: lines[1] ? parseDurationString(lines[1]) : 0, filesize: null }
  } catch (err) { console.warn("[INFO] Fallback extraction failed:", err.message) }

  return { title: "Video", duration: 0, filesize: null }
}

// ============================================================
// YOUTUBE RETRY HANDLER
// Handles empty/corrupt files by retrying with progressively
// simpler format selectors
// ============================================================

class YouTubeEmptyFileHandler {
  static async handleEmptyFile(url, format, quality, userAgent, cookieFile, platform, outputPath) {
    console.log("[YT-RETRY] Starting empty file retry handler")
    const maxRetries = 3
    let lastError = null

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.log(`[YT-RETRY] Attempt ${attempt}/${maxRetries}`)
      try {
        const formatToUse = attempt === 1 ? getFormatSelector(format, quality, platform) : getSimpleFormatSelector(format, quality)
        const q = Number.parseInt(quality || "128")

        const retryArgs = [
          ...buildSecureCommand(userAgent, cookieFile, platform),
          "-f", formatToUse,
          ...(format === "mp3"
            ? ["-x", "--audio-format", "mp3", "--postprocessor-args", `ffmpeg:-b:a ${q}k -ar 44100`]
            : ["--merge-output-format", "mp4"]),
          "--add-metadata",
          "-o", outputPath,
          url,
        ]

        const { stderr } = await executeSecureCommand(ytDlpPath, retryArgs, { timeout: 300000 })

        if (stderr && isFormatNotAvailableError(stderr) && attempt < maxRetries) throw new Error("Format not available - trying simpler fallback")
        if (stderr && isYouTubeCriticalError(stderr)) throw new Error(`Critical error: ${stderr}`)

        // Verify output file
        if (!fs.existsSync(outputPath)) {
          const found = findRecentFile(DOWNLOADS, Date.now(), [`.${format === "mp3" ? "mp3" : "mp4"}`])
          if (!found) throw new Error("Output file not created after retry")
          const stats = fs.statSync(found)
          if (stats.size < 1000) throw new Error("Output file is too small after retry")
          return { success: true, filePath: found, size: stats.size }
        }

        const stats = fs.statSync(outputPath)
        if (stats.size < 1000) throw new Error("Output file is too small after retry")
        return { success: true, filePath: outputPath, size: stats.size }
      } catch (err) {
        lastError = err
        console.warn(`[YT-RETRY] Attempt ${attempt} failed: ${err.message}`)
        await new Promise((r) => setTimeout(r, 3000 * attempt))
      }
    }

    throw new Error(`All retry attempts failed. Last error: ${lastError.message}`)
  }
}

// ============================================================
// YOUTUBE MULTI-STRATEGY DOWNLOAD
// Tries 3 bypass strategies in sequence before giving up.
// Strategy 1: cookies + headers; Strategy 2: no cookies; Strategy 3: compat mode
// ============================================================

async function tryYouTubeDownloadStrategies(url, format, quality, uniqueId) {
  const strategies = [
    { name: "Strategy 1: Cookies + Optimized Headers", fn: YouTubeBypassStrategies.strategy1, useCookie: true, timeout: 45000 },
    { name: "Strategy 2: No Cookies + Bypass", fn: YouTubeBypassStrategies.strategy2, useCookie: false, timeout: 30000 },
    { name: "Strategy 3: Compat Mode + Retries", fn: YouTubeBypassStrategies.strategy3, useCookie: true, timeout: 60000 },
  ]

  let lastError = null

  for (const strategy of strategies) {
    try {
      console.log(`[YT] Trying ${strategy.name}`)
      const cookieFile = strategy.useCookie ? getSmartCookie("youtube") : null
      const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
      const baseArgs = strategy.useCookie ? strategy.fn(userAgent, cookieFile) : strategy.fn(userAgent)

      // Get metadata first
      let data = null
      try {
        const { stdout } = await executeSecureCommand(ytDlpPath, [...baseArgs, "-j", url], { timeout: strategy.timeout })
        const jsonLine = stdout.split("\n").find((l) => l.trim().startsWith("{"))
        data = jsonLine ? JSON.parse(jsonLine) : await getVideoInfoWithoutJson(url, userAgent, cookieFile, "youtube")
        if (!data?.title || data.title === "Video") throw new Error("Could not extract video title")
        console.log(`[YT] Metadata OK: ${data.title?.substring(0, 60)}`)
      } catch (e) {
        data = await getVideoInfoWithoutJson(url, userAgent, cookieFile, "youtube")
        if (!data?.title || data.title === "Video") throw new Error("Could not extract video metadata even with fallback")
      }

      const durationCheck = checkDuration(data.duration)
      if (!durationCheck.allowed) throw new Error(durationCheck.message)

      const safeTitle = generateSecureFilename(data.title, quality, format, uniqueId)
      const outputPath = path.join(DOWNLOADS, safeTitle)
      const q = Number.parseInt(quality || "128")

      const downloadArgs = format === "mp3"
        ? [...baseArgs, "-f", getFormatSelector("mp3", quality, "youtube"), "--extract-audio", "--audio-format", "mp3",
            "--postprocessor-args", `ffmpeg:-b:a ${q}k -ar 44100`, "--add-metadata", "--embed-thumbnail", "-o", outputPath, url]
        : [...baseArgs, "-f", getFormatSelector("mp4", quality, "youtube"), "--merge-output-format", "mp4", "--add-metadata", "-o", outputPath, url]

      const { stderr } = await executeSecureCommand(ytDlpPath, downloadArgs, { timeout: 300000 })

      if (stderr) {
        if (isFormatNotAvailableError(stderr)) {
          // Try simpler format selector as immediate fallback
          const fallbackArgs = [...baseArgs, "-f", getSimpleFormatSelector(format, quality),
            ...(format === "mp3" ? ["--extract-audio", "--audio-format", "mp3", "--postprocessor-args", `ffmpeg:-b:a ${q}k -ar 44100`] : ["--merge-output-format", "mp4"]),
            "--add-metadata", "-o", outputPath, url]
          const { stderr: fbStderr } = await executeSecureCommand(ytDlpPath, fallbackArgs, { timeout: 300000 })
          if (fbStderr && isYouTubeCriticalError(fbStderr)) throw new Error(`Critical error in fallback: ${fbStderr.substring(0, 300)}`)
          console.log("[YT] Format fallback succeeded")
        } else if (isYouTubeCriticalError(stderr)) {
          throw new Error(`YouTube critical error: ${stderr.substring(0, 300)}`)
        } else if (!isNonCriticalError(stderr)) {
          console.warn("[YT] Non-classified stderr:", stderr.substring(0, 100))
        }
      }

      const finalPath = fs.existsSync(outputPath) ? outputPath : findRecentFile(DOWNLOADS, Date.now(), [`.${format === "mp3" ? "mp3" : "mp4"}`])
      if (!finalPath) throw new Error("Output file not found after download")
      if (fs.statSync(finalPath).size < 1000) throw new Error("Output file is too small (likely corrupt)")

      console.log(`[YT] Success with ${strategy.name}`)
      return { success: true, data, finalFilePath: finalPath, stats: fs.statSync(finalPath), durationCheck, strategy: strategy.name }
    } catch (err) {
      lastError = err
      console.warn(`[YT] ${strategy.name} failed: ${err.message}`)
      if (strategy !== strategies[strategies.length - 1]) await new Promise((r) => setTimeout(r, 2000))
    }
  }

  throw new Error(`All YouTube strategies failed. Last error: ${lastError.message}`)
}

// ============================================================
// EXPRESS MIDDLEWARE & SECURITY
// ============================================================

app.use(helmet({
  contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", "data:", "https:"] } },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
}))

app.use(cors({
  origin: ["http://localhost:3000", "http://127.0.0.1:3000", "https://www.waifuconvert.com", "https://waifuconvert.com", "https://waifuconvert.vercel.app"],
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept", "Origin", "X-Requested-With"],
  exposedHeaders: ["Content-Length", "Content-Type"],
  preflightContinue: false,
}))

// Explicit OPTIONS handler to guarantee CORS preflight always responds
app.options("*", (req, res) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*")
  res.header("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS")
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Content-Length, X-Requested-With, Accept, Origin")
  res.header("Access-Control-Allow-Credentials", "true")
  res.sendStatus(200)
})

const downloadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 20,
  message: { error: "Too many download attempts. Please try again in a few minutes.", type: "rate_limit_exceeded" },
  standardHeaders: true, legacyHeaders: false,
})

const generalLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60,
  message: { error: "Too many requests. Please try again in 1 minute.", type: "rate_limit_exceeded" },
})

app.use(generalLimiter)
app.use("/download", downloadLimiter)

// Track last activity time and update ResourceEconomizer
app.use((req, res, next) => {
  lastActivity = Date.now()
  console.log(`[REQ] ${req.method} ${req.path} from ${req.headers.origin || "unknown"}`)
  next()
})

// Parse JSON body with size limit
app.use((req, res, next) => {
  express.json({ limit: "10mb" })(req, res, (err) => {
    if (err) { console.error("[JSON] Parse error:", err.message); return res.status(400).json({ error: "Invalid JSON in request body" }) }
    next()
  })
})

// Ensure required directories exist
if (!fs.existsSync(DOWNLOADS)) fs.mkdirSync(DOWNLOADS, { recursive: true, mode: 0o755 })
if (!fs.existsSync(COOKIES_DIR)) fs.mkdirSync(COOKIES_DIR, { recursive: true, mode: 0o700 })

// ============================================================
// HELPER: Save completed file to fileMap and respond to client
// ============================================================

function respondWithFile(res, filePath, data, format, quality, platform, extra = {}) {
  const ext = format === "mp3" ? "mp3" : "mp4"
  const qualLabel = format === "mp3" ? `${quality}kbps` : `${quality}p`
  const friendlyName = `${data.title.substring(0, 50)} - ${qualLabel}.${ext}`
  const downloadKey = `download_${crypto.randomBytes(16).toString("hex")}.${ext}`
  const stats = fs.statSync(filePath)

  fileMap.set(downloadKey, { actualPath: filePath, actualFilename: path.basename(filePath), userFriendlyName: friendlyName, size: stats.size, created: Date.now() })

  // Log what each user downloaded for monitoring
  console.log(`[DOWNLOAD] Complete - platform: ${platform}, format: ${format}, quality: ${quality}, size: ${(stats.size / 1024 / 1024).toFixed(2)}MB, title: "${data.title?.substring(0, 60)}"`)

  runMemoryCleanup()

  return res.json({
    file: `/downloads/${downloadKey}`,
    filename: friendlyName,
    size: stats.size,
    title: data.title,
    duration: data.duration,
    platform,
    quality_achieved: qualLabel,
    ...extra,
  })
}

// ============================================================
// MAIN DOWNLOAD ROUTE
// ============================================================

app.post("/download", async (req, res) => {
  const startTime = Date.now()
  let downloadStarted = false

  try {
    console.log(`[DOWNLOAD] New request - body: ${JSON.stringify(req.body || {}).substring(0, 200)}`)

    if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
      return res.status(429).json({
        error: "Server is busy. Please try again in a few minutes.",
        type: "server_busy",
        queue_info: `${activeDownloads}/${MAX_CONCURRENT_DOWNLOADS} active downloads`,
      })
    }

    const { url, format, quality } = req.body
    const validationErrors = validateDownloadParams(url, format, quality)
    if (validationErrors.length > 0) return res.status(400).json({ error: "Invalid parameters", details: validationErrors })

    activeDownloads++
    downloadStarted = true
    console.log(`[DOWNLOAD] Active downloads: ${activeDownloads}/${MAX_CONCURRENT_DOWNLOADS}`)

    if (activeDownloads === 1) runMemoryCleanup()

    const platform = detectPlatform(url)
    const cookieFile = getSmartCookie(platform)
    const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
    const uniqueId = crypto.randomBytes(8).toString("hex")

    console.log(`[DOWNLOAD] Platform: ${platform}, Format: ${format}, Quality: ${quality}, Cookie: ${cookieFile ? path.basename(cookieFile) : "none"}`)

    // --- YouTube: use dedicated multi-strategy handler ---
    if (platform === "youtube") {
      try {
        const result = await tryYouTubeDownloadStrategies(url, format, quality, uniqueId)
        return respondWithFile(res, result.finalFilePath, result.data, format, quality, platform, { strategy_used: result.strategy })
      } catch (err) {
        console.error("[DOWNLOAD] YouTube all strategies failed:", err.message)
        return res.status(500).json({
          error: "Could not download this YouTube video. Please try again later or try a different video.",
          type: "youtube_error",
          suggestions: ["Wait a few minutes and try again", "Try a different quality setting", "Try downloading as MP3 instead"],
        })
      }
    }

    // --- Other platforms ---

    // Get metadata
    const jsonArgs = [...buildSecureCommand(userAgent, cookieFile, platform), "-j", "--skip-download", url]
    let data
    try {
      const { stdout } = await executeSecureCommand(ytDlpPath, jsonArgs, { timeout: 30000 })
      const jsonLine = stdout.split("\n").find((l) => l.trim().startsWith("{"))
      data = jsonLine ? JSON.parse(jsonLine) : await getVideoInfoWithoutJson(url, userAgent, cookieFile, platform)
    } catch {
      data = await getVideoInfoWithoutJson(url, userAgent, cookieFile, platform)
    }

    const durationCheck = checkDuration(data.duration)
    if (!durationCheck.allowed) {
      return res.status(400).json({ error: durationCheck.message, type: "duration_exceeded",
        video_duration: durationCheck.duration_formatted, max_duration: durationCheck.max_duration })
    }

    if (data.filesize && data.filesize > MAX_FILE_SIZE) {
      return res.status(400).json({ error: "File too large. Maximum allowed: 512MB", type: "file_too_large" })
    }

    const safeTitle = generateSecureFilename(data.title, quality, format, uniqueId)
    const outputPath = path.join(DOWNLOADS, safeTitle)
    const q = Number.parseInt(quality || "128")

    const downloadArgs = format === "mp3"
      ? [...buildSecureCommand(userAgent, cookieFile, platform), "-f", "bestaudio/best", "-x", "--audio-format", "mp3",
          "--postprocessor-args", `ffmpeg:-b:a ${q}k -ar 44100`, "-o", outputPath, url]
      : [...buildSecureCommand(userAgent, cookieFile, platform), "-f", getFormatSelector("mp4", quality, platform),
          "--merge-output-format", "mp4", "-o", outputPath, url]

    console.log("[DOWNLOAD] Starting download...")
    const { stderr } = await executeSecureCommand(ytDlpPath, downloadArgs, { timeout: 300000 })

    if (stderr) {
      if (isFormatNotAvailableError(stderr)) {
        // Try simple fallback format
        const fbArgs = [...buildSecureCommand(userAgent, cookieFile, platform), "-f", getSimpleFormatSelector(format, quality),
          ...(format === "mp3" ? ["-x", "--audio-format", "mp3", "--postprocessor-args", `ffmpeg:-b:a ${q}k -ar 44100`] : ["--merge-output-format", "mp4"]),
          "-o", outputPath, url]
        const { stderr: fbStderr } = await executeSecureCommand(ytDlpPath, fbArgs, { timeout: 300000 })
        if (fbStderr && isYouTubeCriticalError(fbStderr)) throw new Error(fbStderr)
        console.log("[DOWNLOAD] Format fallback succeeded")
      } else if (isNonCriticalError(stderr)) {
        console.log("[DOWNLOAD] Non-critical warnings ignored:", stderr.substring(0, 100))
      } else if (isAuthenticationError(stderr)) {
        if (platform === "instagram") return res.status(400).json({ error: "Instagram requires login. Please configure cookies via environment variables.", type: "auth_required", platform })
        if (platform === "twitter") return res.status(400).json({ error: "Twitter/X authentication cookies have expired or are invalid. Please contact the administrator.", type: "auth_required", platform })
        return res.status(400).json({ error: "This content is private or requires login.", type: "private_content" })
      }
    }

    let finalPath = fs.existsSync(outputPath) ? outputPath : findRecentFile(DOWNLOADS, startTime, [`.${format === "mp3" ? "mp3" : "mp4"}`])
    if (!finalPath) return res.status(500).json({ error: "File was not created after download", type: "download_failed" })

    const stats = fs.statSync(finalPath)
    if (stats.size < 1000) return res.status(500).json({ error: "Downloaded file appears to be empty or corrupt", type: "corrupt_file" })

    return respondWithFile(res, finalPath, data, format, quality, platform)
  } catch (err) {
    console.error("[DOWNLOAD] Unexpected error:", err?.message)
    console.error("[DOWNLOAD] Stack:", err?.stack?.substring(0, 300))

    if (isAuthenticationError(err.message)) {
      return res.status(400).json({ error: "This content is private or requires authentication.", type: "auth_required" })
    }

    return res.status(500).json({ error: "Internal server error", type: "server_error" })
  } finally {
    if (downloadStarted) {
      activeDownloads = Math.max(0, activeDownloads - 1)
      console.log(`[DOWNLOAD] Active downloads after finish: ${activeDownloads}/${MAX_CONCURRENT_DOWNLOADS}`)
      if (activeDownloads === 0) setTimeout(runMemoryCleanup, 5000)
    }
  }
})

// ============================================================
// FILE SERVING ROUTE
// ============================================================

app.get("/downloads/:fileKey", (req, res) => {
  const fileKey = sanitizeInput(req.params.fileKey, 100)
  console.log(`[SERVE] File requested: ${fileKey}`)

  const fileInfo = fileMap.get(fileKey)
  if (!fileInfo) return res.status(404).json({ error: "File not found or has expired" })

  const { actualPath, userFriendlyName, size } = fileInfo
  if (!fs.existsSync(actualPath)) { fileMap.delete(fileKey); return res.status(404).json({ error: "File no longer exists on disk" }) }

  try {
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(userFriendlyName)}"`)
    res.setHeader("Content-Type", "application/octet-stream")
    res.setHeader("Content-Length", size)
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate")
    res.setHeader("X-Content-Type-Options", "nosniff")
    console.log(`[SERVE] Sending: ${userFriendlyName}`)
    const stream = fs.createReadStream(actualPath)
    stream.on("error", (err) => { console.error("[SERVE] Stream error:", err); if (!res.headersSent) res.status(500).json({ error: "Error reading file" }) })
    stream.pipe(res)
  } catch (err) {
    console.error("[SERVE] Error:", err)
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" })
  }
})

// ============================================================
// UTILITY ROUTES
// ============================================================

app.get("/health", (req, res) => {
  const mem = logMemoryUsage()
  res.json({
    status: "ok",
    version: "7.0.0",
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.round(process.uptime()),
    active_downloads: activeDownloads,
    memory: mem,
    cookies: { google: googleCookiePool.length, instagram: instagramCookiePool.length, twitter: twitterCookiePool.length, total: generalCookiePool.length },
    limits: { max_duration: formatDuration(MAX_DURATION), max_file_size: "512MB", concurrent_downloads: MAX_CONCURRENT_DOWNLOADS, rate_limit: "20 downloads per 10 minutes" },
    gc_available: typeof global.gc === "function",
  })
})

app.get("/memory", (req, res) => {
  const mem = logMemoryUsage()
  res.json({
    timestamp: new Date().toISOString(),
    memory: mem,
    gc_available: typeof global.gc === "function",
    active_downloads: activeDownloads,
    last_activity_seconds_ago: Math.round((Date.now() - lastActivity) / 1000),
    node_options: process.env.NODE_OPTIONS || "not set",
  })
})

app.get("/test-cookies", (req, res) => {
  const envVars = {}

  const check = (envVar) => {
    const content = process.env[envVar]
    if (!content) { envVars[envVar] = { exists: false }; return }
    const fmt = validateCookieFormat(content)
    envVars[envVar] = { exists: true, length: content.length, format_valid: fmt.valid, valid_lines: fmt.validLines }
  }

  for (let i = 1; i <= 10; i++) check(`GOOGLE_COOKIE_${String(i).padStart(2, "0")}`)
  for (let i = 1; i <= 8; i++) check(`INSTAGRAM_COOKIE_${String(i).padStart(2, "0")}`)
  for (let i = 1; i <= 5; i++) {
    const envVar = `TWITTER_COOKIE_${String(i).padStart(2, "0")}`
    const content = process.env[envVar]
    if (!content) { envVars[envVar] = { exists: false }; continue }
    const fmt = validateCookieFormat(content)
    const tw = validateTwitterCookies(content)
    envVars[envVar] = { exists: true, length: content.length, format_valid: fmt.valid, valid_lines: fmt.validLines, nsfw_ready: tw.nsfwReady, critical_missing: tw.criticalMissing }
  }

  res.json({
    timestamp: new Date().toISOString(),
    pools: { google: googleCookiePool.length, instagram: instagramCookiePool.length, twitter: twitterCookiePool.length, total: generalCookiePool.length },
    environment_variables: envVars,
    selection_test: {
      youtube: getSmartCookie("youtube") ? path.basename(getSmartCookie("youtube")) : null,
      instagram: getSmartCookie("instagram") ? path.basename(getSmartCookie("instagram")) : null,
      twitter: getSmartCookie("twitter") ? path.basename(getSmartCookie("twitter")) : null,
    },
  })
})

app.get("/", (req, res) => {
  res.json({
    name: "WaifuConvert Backend",
    version: "7.0.0",
    status: "online",
    endpoints: ["/download (POST)", "/downloads/:key (GET)", "/health (GET)", "/memory (GET)", "/test-cookies (GET)"],
    supported_platforms: ["TikTok", "Twitter/X", "Instagram", "YouTube", "Reddit", "Facebook", "Twitch", "SoundCloud", "Vimeo", "Dailymotion", "Streamable"],
    quality_options: { mp3: "64-320 kbps", mp4: "144p, 240p, 360p, 480p, 720p, 1080p" },
  })
})

// ============================================================
// ERROR HANDLERS
// ============================================================

app.use((error, req, res, next) => {
  console.error("[ERROR] Unhandled middleware error:", error.message, "| Path:", req.path)
  console.error("[ERROR] Stack:", error.stack?.substring(0, 300))
  res.status(500).json({ error: "Internal server error", timestamp: new Date().toISOString() })
})

app.use("*", (req, res) => {
  res.status(404).json({ error: "Route not found", available_endpoints: ["/", "/health", "/download", "/test-cookies", "/memory"] })
})

// ============================================================
// INTERVALS & STARTUP
// ============================================================

fileCleanupInterval = setInterval(cleanupOldFiles, 15 * 60 * 1000) // every 15 minutes

memoryCleanupInterval = setInterval(() => {
  console.log("[INTERVAL] Running periodic memory cleanup")
  runMemoryCleanup()
  logMemoryUsage()
}, 5 * 60 * 1000) // every 5 minutes

// YouTube token algorithms change every 2-4 weeks. Auto-updating yt-dlp
// every 48 hours prevents the service from breaking without a manual redeploy.
ytDlpUpdateInterval = setInterval(async () => {
  console.log("[INTERVAL] Running periodic yt-dlp update check")
  await ensureYtDlpUpdated()
}, 48 * 60 * 60 * 1000) // every 48 hours

app.listen(PORT, async () => {
  console.log(`[STARTUP] WaifuConvert Backend v7.0.0 listening on port ${PORT}`)

  // Check if native GC is available (requires NODE_OPTIONS=--expose-gc)
  if (typeof global.gc === "function") {
    console.log("[STARTUP] Native GC available")
  } else {
    console.log("[STARTUP] Native GC unavailable - using manual cleanup fallback (set NODE_OPTIONS=--expose-gc to enable)")
  }

  // Update yt-dlp on startup to fix any YouTube token issues from downtime
  await ensureYtDlpUpdated()

  // Load cookies from environment variables
  createSecureCookieFiles()
  loadCookiePool()

  // Initial cleanup
  cleanupOldFiles()
  logMemoryUsage()

  console.log(`[STARTUP] CORS origins: waifuconvert.com, waifuconvert.vercel.app, localhost:3000`)
  console.log(`[STARTUP] Limits: ${MAX_CONCURRENT_DOWNLOADS} concurrent downloads, ${formatDuration(MAX_DURATION)} max duration, 512MB max file size`)
  console.log("[STARTUP] Intervals: file cleanup every 15min, memory cleanup every 5min, yt-dlp update every 48h")
  console.log("[STARTUP] Ready to serve requests")
})

// ============================================================
// PROCESS SIGNAL HANDLERS
// ============================================================

function gracefulShutdown(signal) {
  console.log(`[SHUTDOWN] Received ${signal} - shutting down gracefully`)
  if (memoryCleanupInterval) clearInterval(memoryCleanupInterval)
  if (fileCleanupInterval) clearInterval(fileCleanupInterval)
  if (ytDlpUpdateInterval) clearInterval(ytDlpUpdateInterval)
  runMemoryCleanup()
  process.exit(0)
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))
process.on("SIGINT", () => gracefulShutdown("SIGINT"))

process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT]", err.message)
  console.error("[UNCAUGHT] Stack:", err.stack?.substring(0, 500))
  try { runMemoryCleanup() } catch (_) {}
  // Do not call process.exit() - Railway will restart if needed
})

process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED_REJECTION]", reason?.message || reason)
  console.error("[UNHANDLED_REJECTION] Stack:", reason?.stack?.substring(0, 300))
})
