const express = require("express")
const cors = require("cors")
const { exec, spawn } = require("child_process")
const fs = require("fs")
const path = require("path")
const rateLimit = require("express-rate-limit")
const helmet = require("helmet")
const validator = require("validator")
const crypto = require("crypto")

const app = express()

// Confiar no proxy do Railway
app.set("trust proxy", true)

// Configurações dinâmicas (ajustadas pelo modo economia)
let CURRENT_MAX_CONCURRENT_DOWNLOADS = 4
let CURRENT_MAX_DURATION = 7200 // 2 horas em segundos

const NORMAL_MAX_CONCURRENT = 4
const NORMAL_MAX_DURATION = 7200 // 2h
const ECONOMY_MAX_CONCURRENT = 2
const ECONOMY_MAX_DURATION = 1800 // 30min

const PORT = process.env.PORT || 8080
const MAX_FILE_SIZE = 512 * 1024 * 1024 // 512MB

// Variáveis de controle
let lastActivity = Date.now()
let memoryCleanupInterval = null
let fileCleanupInterval = null
let keepAliveInterval = null
let economyCheckInterval = null

// Sistema de logs organizado
function logInfo(emoji, message, data = null) {
  console.log(`${emoji} ${message}`)
  if (data) {
    console.log(JSON.stringify(data, null, 2))
  }
}

function logError(message, error = null) {
  console.log(`❌ ${message}`)
  if (error) {
    console.log(`   Erro: ${error.message || error}`)
  }
}

function logDownload(stage, data) {
  console.log(`\n${"=".repeat(60)}`)
  console.log(`📥 ${stage}`)
  console.log(`${"=".repeat(60)}`)
  console.log(JSON.stringify(data, null, 2))
  console.log(`${"=".repeat(60)}\n`)
}

// Limpeza ultra agressiva de memória
function ultraAggressiveMemoryCleanup() {
  try {
    const before = process.memoryUsage().heapUsed

    if (typeof global.gc === "function") {
      global.gc()
    }

    if (require.cache) {
      const cacheKeys = Object.keys(require.cache)
      const nonEssential = cacheKeys.filter(
        (key) => !key.includes("express") && !key.includes("cors") && !key.includes("helmet"),
      )

      const toDelete = nonEssential.slice(0, Math.floor(nonEssential.length * 0.5))
      toDelete.forEach((key) => {
        try {
          delete require.cache[key]
        } catch (e) {}
      })
    }

    const tempArrays = []
    for (let i = 0; i < 20; i++) {
      tempArrays.push(new Array(5000).fill(null))
    }
    tempArrays.length = 0

    if (global.Buffer && global.Buffer.poolSize > 1) {
      global.Buffer.poolSize = 1
    }

    const after = process.memoryUsage().heapUsed
    const freed = Math.round((before - after) / 1024 / 1024)

    if (freed > 0) {
      console.log(`🧹 ${freed}MB liberados`)
    }

    return freed
  } catch (error) {
    return 0
  }
}

// Monitoramento contínuo de memória (a cada 2 minutos)
function startContinuousMemoryMonitoring() {
  memoryCleanupInterval = setInterval(
    () => {
      const memory = process.memoryUsage()
      const heapMB = Math.round(memory.heapUsed / 1024 / 1024)
      const rssMB = Math.round(memory.rss / 1024 / 1024)

      console.log(`📊 RAM: ${heapMB}MB heap / ${rssMB}MB total`)

      if (heapMB > 150) {
        ultraAggressiveMemoryCleanup()
      }

      if (activeDownloads === 0) {
        ultraAggressiveMemoryCleanup()
      }
    },
    2 * 60 * 1000,
  )
}

// Limpeza de arquivos antigos (a cada 5 minutos)
function startAggressiveFileCleanup() {
  fileCleanupInterval = setInterval(
    () => {
      try {
        if (!fs.existsSync(DOWNLOADS)) return

        const files = fs.readdirSync(DOWNLOADS)
        const now = Date.now()
        const thirtyMinutesAgo = now - 30 * 60 * 1000

        let deletedCount = 0
        let freedMB = 0

        files.forEach((file) => {
          const filePath = path.join(DOWNLOADS, file)
          try {
            const stats = fs.statSync(filePath)

            if (stats.mtime.getTime() < thirtyMinutesAgo) {
              const sizeMB = Math.round(stats.size / 1024 / 1024)
              fs.unlinkSync(filePath)
              deletedCount++
              freedMB += sizeMB

              for (const [key, value] of fileMap.entries()) {
                if (value.actualPath === filePath) {
                  fileMap.delete(key)
                  break
                }
              }
            }
          } catch (e) {}
        })

        if (deletedCount > 0) {
          console.log(`🗑️ Limpeza de arquivos: ${deletedCount} arquivos, ${freedMB}MB liberados`)
        }
      } catch (error) {
        console.error("❌ Erro limpeza:", error.message)
      }
    },
    5 * 60 * 1000,
  )
}

// Sistema de Keep-Alive (a cada 8 minutos)
function startKeepAliveSystem() {
  keepAliveInterval = setInterval(
    () => {
      const memory = process.memoryUsage()
      const heapMB = Math.round(memory.heapUsed / 1024 / 1024)

      if (resourceEconomizer.isEconomyMode) {
        console.log(`💓 Keep-alive ping - evitando sleep mode`)
        console.log(`💓 Heap: ${heapMB}MB`)
      } else {
        console.log(`💓 Keep-alive ping - evitando sleep mode`)
        console.log(`💓 Heap: ${heapMB}MB`)
      }

      if (activeDownloads === 0) {
        ultraAggressiveMemoryCleanup()
      }
    },
    8 * 60 * 1000,
  )
}

// Sistema de economia de recursos MELHORADO
class ResourceEconomizer {
  constructor() {
    this.isEconomyMode = false
    this.lastRequest = Date.now()
    this.economyThreshold = 10 * 60 * 1000 // 10 minutos de inatividade
  }

  updateActivity() {
    this.lastRequest = Date.now()

    if (this.isEconomyMode) {
      this.exitEconomyMode()
    }
  }

  checkEconomyMode() {
    const inactive = Date.now() - this.lastRequest
    const inactiveMinutes = Math.floor(inactive / 60000)

    // Ativar modo economia após 10min de inatividade E sem downloads ativos
    if (inactive > this.economyThreshold && !this.isEconomyMode && activeDownloads === 0) {
      this.enterEconomyMode(inactiveMinutes)
    }
  }

  enterEconomyMode(inactiveMinutes) {
    this.isEconomyMode = true

    // Reduzir limites
    CURRENT_MAX_CONCURRENT_DOWNLOADS = ECONOMY_MAX_CONCURRENT
    CURRENT_MAX_DURATION = ECONOMY_MAX_DURATION

    console.log(`\n${"=".repeat(60)}`)
    console.log(`🔥 MODO ECONOMIA ATIVADO - servidor inativo há ${inactiveMinutes}min`)
    console.log(`${"=".repeat(60)}`)
    console.log(`🔥 Limites de economia aplicados:`)
    console.log(
      JSON.stringify(
        {
          concurrent_downloads: `${NORMAL_MAX_CONCURRENT} → ${ECONOMY_MAX_CONCURRENT}`,
          max_duration: `${formatDuration(NORMAL_MAX_DURATION)} → ${formatDuration(ECONOMY_MAX_DURATION)}`,
        },
        null,
        2,
      ),
    )
    console.log(`${"=".repeat(60)}\n`)

    ultraAggressiveMemoryCleanup()
  }

  exitEconomyMode() {
    if (!this.isEconomyMode) return

    this.isEconomyMode = false

    // Restaurar limites normais
    CURRENT_MAX_CONCURRENT_DOWNLOADS = NORMAL_MAX_CONCURRENT
    CURRENT_MAX_DURATION = NORMAL_MAX_DURATION

    console.log(`\n${"=".repeat(60)}`)
    console.log(`🚀 MODO NORMAL ATIVADO - nova requisição detectada`)
    console.log(`${"=".repeat(60)}`)
    console.log(`🚀 Limites normais restaurados:`)
    console.log(
      JSON.stringify(
        {
          concurrent_downloads: CURRENT_MAX_CONCURRENT_DOWNLOADS,
          max_duration: formatDuration(CURRENT_MAX_DURATION),
        },
        null,
        2,
      ),
    )
    console.log(`${"=".repeat(60)}\n`)
  }

  getEconomyStatus() {
    const inactive = Date.now() - this.lastRequest
    const inactiveMinutes = Math.floor(inactive / 60000)
    return {
      economy_mode: this.isEconomyMode,
      inactive_time_minutes: inactiveMinutes,
      current_limits: {
        max_concurrent: CURRENT_MAX_CONCURRENT_DOWNLOADS,
        max_duration: formatDuration(CURRENT_MAX_DURATION),
      },
    }
  }
}

const resourceEconomizer = new ResourceEconomizer()

// Verificar modo economia a cada 1 minuto
function startEconomyCheck() {
  economyCheckInterval = setInterval(() => {
    resourceEconomizer.checkEconomyMode()
  }, 60 * 1000)
}

// Domínios permitidos
const ALLOWED_DOMAINS = [
  "tiktok.com",
  "vm.tiktok.com",
  "vt.tiktok.com",
  "m.tiktok.com",
  "www.tiktok.com",
  "twitter.com",
  "x.com",
  "t.co",
  "mobile.twitter.com",
  "www.twitter.com",
  "www.x.com",
  "instagram.com",
  "www.instagram.com",
  "m.instagram.com",
  "youtube.com",
  "youtu.be",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "reddit.com",
  "www.reddit.com",
  "old.reddit.com",
  "m.reddit.com",
  "new.reddit.com",
  "facebook.com",
  "fb.watch",
  "www.facebook.com",
  "m.facebook.com",
  "web.facebook.com",
  "twitch.tv",
  "clips.twitch.tv",
  "www.twitch.tv",
  "soundcloud.com",
  "www.soundcloud.com",
  "m.soundcloud.com",
  "vimeo.com",
  "www.vimeo.com",
  "player.vimeo.com",
  "dailymotion.com",
  "www.dailymotion.com",
  "streamable.com",
  "www.streamable.com",
]

const DOWNLOADS = path.join(__dirname, "downloads")
const COOKIES_DIR = path.join(__dirname, "cookies")

let activeDownloads = 0

const TWITTER_ESSENTIAL_COOKIES = ["auth_token", "ct0", "twid", "att", "personalization_id"]

const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
]

// Handler para correção de arquivos vazios do YouTube
class YouTubeEmptyFileHandler {
  static async handleEmptyFile(url, format, quality, userAgent, cookieFile, platform, outputPath, attempt = 1) {
    const maxAttempts = 3

    logInfo("🔄", `YouTube Retry Tentativa ${attempt}/${maxAttempts}`)

    if (attempt > maxAttempts) {
      throw new Error("YouTube: Todas as tentativas falharam")
    }

    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt))

    let retryArgs

    if (attempt === 1) {
      retryArgs = [
        "--user-agent",
        userAgent,
        "--no-playlist",
        "--no-check-certificates",
        "--extractor-retries",
        "5",
        "--fragment-retries",
        "10",
        "--retry-sleep",
        "3",
        "--force-json",
        "--no-warnings",
      ]

      if (cookieFile) {
        retryArgs.push("--cookies", cookieFile)
      }

      if (format === "mp3") {
        retryArgs.push(
          "-f",
          "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio",
          "--extract-audio",
          "--audio-format",
          "mp3",
          "--audio-quality",
          `${quality}k`,
        )
      } else {
        retryArgs.push("-f", `best[height<=${quality}][ext=mp4]/best[height<=${quality}]/best`)
      }
    } else if (attempt === 2) {
      retryArgs = [
        "--user-agent",
        userAgent,
        "--no-playlist",
        "--no-check-certificates",
        "--extractor-retries",
        "3",
        "--fragment-retries",
        "5",
        "--retry-sleep",
        "5",
        "--no-warnings",
        "--ignore-errors",
      ]

      if (format === "mp3") {
        retryArgs.push("-f", "bestaudio", "--extract-audio", "--audio-format", "mp3")
      } else {
        retryArgs.push("-f", "best")
      }
    } else {
      retryArgs = [
        "--user-agent",
        userAgent,
        "--no-playlist",
        "--extractor-retries",
        "1",
        "--fragment-retries",
        "1",
        "--no-warnings",
        "--ignore-errors",
        "--compat-options",
        "all",
        "--prefer-free-formats",
      ]

      if (format === "mp3") {
        retryArgs.push("--extract-audio", "--audio-format", "mp3")
      }

      retryArgs.push("-f", "worst")
    }

    retryArgs.push("-o", outputPath, url)

    try {
      const { stdout, stderr } = await executeSecureCommand("yt-dlp", retryArgs, { timeout: 180000 })

      if (fs.existsSync(outputPath)) {
        const stats = fs.statSync(outputPath)
        if (stats.size > 1000) {
          logInfo("✅", `Retry ${attempt} bem-sucedido!`, {
            size: formatFileSize(stats.size),
          })
          return { success: true, filePath: outputPath, size: stats.size }
        } else {
          fs.unlinkSync(outputPath)
        }
      }

      return await YouTubeEmptyFileHandler.handleEmptyFile(
        url,
        format,
        quality,
        userAgent,
        cookieFile,
        platform,
        outputPath,
        attempt + 1,
      )
    } catch (error) {
      if (attempt === maxAttempts) {
        throw new Error(`YouTube: ${maxAttempts} tentativas falharam`)
      }

      return await YouTubeEmptyFileHandler.handleEmptyFile(
        url,
        format,
        quality,
        userAgent,
        cookieFile,
        platform,
        outputPath,
        attempt + 1,
      )
    }
  }
}

// Verificação de duração do vídeo (usa limite dinâmico)
function checkDuration(duration) {
  if (!duration || duration <= 0) {
    return { allowed: true, message: null }
  }

  const durationSeconds = typeof duration === "string" ? parseDurationString(duration) : duration

  if (durationSeconds > CURRENT_MAX_DURATION) {
    const durationFormatted = formatDuration(durationSeconds)
    const maxFormatted = formatDuration(CURRENT_MAX_DURATION)

    return {
      allowed: false,
      message: `Vídeo muito longo! Máximo: ${maxFormatted}. Seu vídeo: ${durationFormatted}`,
      duration_formatted: durationFormatted,
      max_duration: maxFormatted,
    }
  }

  return {
    allowed: true,
    message: null,
    duration_formatted: formatDuration(durationSeconds),
  }
}

function parseDurationString(durationStr) {
  if (typeof durationStr === "number") return durationStr

  const parts = durationStr.split(":").reverse()
  let seconds = 0

  if (parts[0]) seconds += Number.parseInt(parts[0]) || 0
  if (parts[1]) seconds += (Number.parseInt(parts[1]) || 0) * 60
  if (parts[2]) seconds += (Number.parseInt(parts[2]) || 0) * 3600

  return seconds
}

function formatDuration(seconds) {
  if (seconds < 60) {
    return `${seconds}s`
  } else if (seconds < 3600) {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
  } else {
    const hours = Math.floor(seconds / 3600)
    const mins = Math.floor((seconds % 3600) / 60)
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
  }
}

function formatFileSize(size) {
  if (size < 1024) {
    return `${size} bytes`
  } else if (size < 1024 * 1024) {
    const kb = Math.round(size / 1024)
    return `${kb} KB`
  } else {
    const mb = Math.round(size / 1024 / 1024)
    return `${mb} MB`
  }
}

// Validação de formato de cookies
function validateCookieFormat(cookieContent, filename) {
  if (!cookieContent || cookieContent.length < 10) {
    return { valid: false, reason: "Cookie muito pequeno" }
  }

  const lines = cookieContent.split("\n")
  let validLines = 0
  let invalidLines = 0
  const issues = []

  lines.forEach((line, index) => {
    line = line.trim()

    if (!line || line.startsWith("#")) {
      return
    }

    const fields = line.split("\t")

    if (fields.length >= 6) {
      validLines++

      if (!fields[0].includes(".")) {
        issues.push(`Linha ${index + 1}: Domínio suspeito`)
      }

      const expiration = Number.parseInt(fields[4])
      if (expiration && expiration < Date.now() / 1000) {
        issues.push(`Linha ${index + 1}: Cookie expirado`)
      }
    } else {
      invalidLines++
      issues.push(`Linha ${index + 1}: Formato inválido`)
    }
  })

  return {
    valid: validLines > 0,
    validLines,
    invalidLines,
    issues,
    reason: validLines === 0 ? "Nenhuma linha válida" : null,
  }
}

// Validação específica de cookies do Twitter
function validateTwitterCookies(cookieContent) {
  const lines = cookieContent.split("\n")
  const foundCookies = new Set()

  lines.forEach((line) => {
    if (line.trim() && !line.startsWith("#")) {
      const fields = line.split("\t")
      if (fields.length >= 6) {
        const cookieName = fields[5]
        foundCookies.add(cookieName)
      }
    }
  })

  const criticalMissing = []
  const importantMissing = []

  if (!foundCookies.has("auth_token")) criticalMissing.push("auth_token")
  if (!foundCookies.has("ct0")) criticalMissing.push("ct0")
  if (!foundCookies.has("twid")) importantMissing.push("twid")
  if (!foundCookies.has("att")) importantMissing.push("att")

  return {
    valid: criticalMissing.length === 0,
    criticalMissing,
    importantMissing,
    foundCookies: Array.from(foundCookies),
    nsfwReady: criticalMissing.length === 0,
    recommendation: criticalMissing.length === 0 ? "✅ Pronto para NSFW" : "❌ Faltam cookies críticos",
  }
}

// Middleware de segurança
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  }),
)

// CORS
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "https://www.waifuconvert.com",
      "https://waifuconvert.com",
      "https://waifuconvert.vercel.app",
    ],
    credentials: true,
    optionsSuccessStatus: 200,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept", "Origin", "X-Requested-With"],
    exposedHeaders: ["Content-Length", "Content-Type"],
    preflightContinue: false,
  }),
)

app.options("*", (req, res) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*")
  res.header("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS")
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Content-Length, X-Requested-With, Accept, Origin",
  )
  res.header("Access-Control-Allow-Credentials", "true")
  res.sendStatus(200)
})

// Rate limiting
const downloadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    error: "Limite atingido. Tente em 15min.",
    type: "rate_limit_exceeded",
  },
  standardHeaders: true,
  legacyHeaders: false,
})

const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: {
    error: "Muitas requisições. Tente em 1min.",
    type: "rate_limit_exceeded",
  },
})

app.use(generalLimiter)
app.use("/download", downloadLimiter)

// Middleware para rastrear atividade
app.use((req, res, next) => {
  lastActivity = Date.now()
  resourceEconomizer.updateActivity()
  console.log(`🌐 ${req.method} ${req.path}`)
  next()
})

// Validação de URL
function isValidUrl(url) {
  try {
    if (
      !validator.isURL(url, {
        protocols: ["http", "https"],
        require_protocol: true,
        require_valid_protocol: true,
        allow_underscores: true,
        allow_trailing_dot: false,
        allow_protocol_relative_urls: false,
        allow_fragments: true,
        allow_query_components: true,
      })
    ) {
      return false
    }

    const parsedUrl = new URL(url)
    const hostname = parsedUrl.hostname.toLowerCase()

    const isAllowedDomain = ALLOWED_DOMAINS.some((domain) => {
      if (hostname === domain) return true
      if (hostname.endsWith("." + domain)) return true
      if (domain === "tiktok.com" && (hostname.includes("tiktok") || hostname.includes("musically"))) return true
      if (domain === "twitter.com" && hostname.includes("twimg")) return true
      if (domain === "youtube.com" && (hostname.includes("youtube") || hostname.includes("youtu"))) return true
      if (domain === "instagram.com" && (hostname.includes("instagram") || hostname.includes("cdninstagram")))
        return true
      return false
    })

    if (!isAllowedDomain) {
      return false
    }

    const privateIpPatterns = [
      /^127\./,
      /^192\.168\./,
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
      /^0\.0\.0\.0$/,
      /^localhost$/i,
    ]

    const isPrivateIp = privateIpPatterns.some((pattern) => pattern.test(hostname))
    if (isPrivateIp) {
      return false
    }

    return true
  } catch (error) {
    return false
  }
}

function sanitizeInput(input, maxLength = 100) {
  if (typeof input !== "string") return ""
  return input
    .trim()
    .substring(0, maxLength)
    .replace(/[<>"'&]/g, "")
    .replace(/\0/g, "")
}

function generateSecureFilename(title, quality, format, uniqueId) {
  const safeTitle =
    sanitizeInput(title, 50)
      .replace(/[^\w\s\-_.()]/g, "")
      .replace(/\s+/g, "_")
      .replace(/_{2,}/g, "_")
      .trim() || "WaifuConvert"

  const qualLabel = format === "mp3" ? `${quality || "best"}kbps` : `${quality || "best"}p`
  const ext = format === "mp3" ? "mp3" : "mp4"

  return `${safeTitle}-${qualLabel}-${uniqueId}.${ext}`
}

// Validação de parâmetros de download
function validateDownloadParams(url, format, quality) {
  const errors = []

  if (!url || typeof url !== "string") {
    errors.push("Link inválido")
  } else if (!isValidUrl(url)) {
    errors.push(`Site não suportado`)
  }

  if (!format || !["mp3", "mp4"].includes(format)) {
    errors.push("Formato deve ser MP3 ou MP4")
  }

  if (quality) {
    const q = Number.parseInt(quality)
    if (format === "mp3" && (q < 64 || q > 320)) {
      errors.push("Qualidade de áudio: 64-320 kbps")
    } else if (format === "mp4" && ![144, 240, 360, 480, 720, 1080].includes(q)) {
      errors.push("Qualidade de vídeo: 144p, 240p, 360p, 480p, 720p, 1080p")
    }
  }

  return errors
}

// Execução segura de comandos
function executeSecureCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || 300000

    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeout,
      killSignal: "SIGKILL",
    })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (data) => {
      stdout += data.toString()
    })

    child.stderr.on("data", (data) => {
      stderr += data.toString()
    })

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(new Error(`Falhou com código ${code}: ${stderr}`))
      }
    })

    child.on("error", (error) => {
      reject(error)
    })

    const timeoutId = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error("Timeout"))
    }, timeout)

    child.on("close", () => {
      clearTimeout(timeoutId)
    })
  })
}

const ytDlpPath = "yt-dlp"

// Criação de arquivos de cookies
function createSecureCookieFiles() {
  if (!fs.existsSync(COOKIES_DIR)) {
    fs.mkdirSync(COOKIES_DIR, { recursive: true, mode: 0o700 })
  }

  let cookiesCreated = 0

  // Google Cookies
  for (let i = 1; i <= 10; i++) {
    const envVar = `GOOGLE_COOKIE_${i.toString().padStart(2, "0")}`
    const cookieContent = process.env[envVar]

    if (cookieContent && cookieContent.length > 100) {
      const filename = `google_conta${i.toString().padStart(2, "0")}.txt`
      const filepath = path.join(COOKIES_DIR, filename)
      fs.writeFileSync(filepath, cookieContent, { mode: 0o600 })
      cookiesCreated++
    }
  }

  // Instagram Cookies
  for (let i = 1; i <= 8; i++) {
    const envVar = `INSTAGRAM_COOKIE_${i.toString().padStart(2, "0")}`
    const cookieContent = process.env[envVar]

    if (cookieContent && cookieContent.length > 100) {
      const filename = `instagram_conta${i.toString().padStart(2, "0")}.txt`
      const filepath = path.join(COOKIES_DIR, filename)
      fs.writeFileSync(filepath, cookieContent, { mode: 0o600 })
      cookiesCreated++
    }
  }

  // Twitter Cookies
  for (let i = 1; i <= 5; i++) {
    const envVar = `TWITTER_COOKIE_${i.toString().padStart(2, "0")}`
    const cookieContent = process.env[envVar]

    if (cookieContent && cookieContent.length > 100) {
      const filename = `twitter_conta${i.toString().padStart(2, "0")}.txt`
      const filepath = path.join(COOKIES_DIR, filename)
      fs.writeFileSync(filepath, cookieContent, { mode: 0o600 })
      cookiesCreated++
    }
  }

  return cookiesCreated
}

let googleCookiePool = []
let instagramCookiePool = []
let twitterCookiePool = []
let generalCookiePool = []

// Carregamento de cookies
function loadCookiePool() {
  try {
    if (!fs.existsSync(COOKIES_DIR)) {
      fs.mkdirSync(COOKIES_DIR, { recursive: true })
      return
    }

    const files = fs.readdirSync(COOKIES_DIR).filter((file) => file.endsWith(".txt"))

    googleCookiePool = files.filter((f) => f.startsWith("google_")).map((f) => path.join(COOKIES_DIR, f))
    instagramCookiePool = files.filter((f) => f.startsWith("instagram_")).map((f) => path.join(COOKIES_DIR, f))
    twitterCookiePool = files.filter((f) => f.startsWith("twitter_")).map((f) => path.join(COOKIES_DIR, f))
    generalCookiePool = files.map((file) => path.join(COOKIES_DIR, file))
  } catch (error) {
    console.error("❌ Erro cookies:", error)
  }
}

function detectPlatform(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    if (hostname.includes("tiktok")) return "tiktok"
    if (hostname.includes("twitter") || hostname.includes("x.com")) return "twitter"
    if (hostname.includes("youtube") || hostname.includes("youtu.be")) return "youtube"
    if (hostname.includes("instagram")) return "instagram"
    if (hostname.includes("reddit")) return "reddit"
    if (hostname.includes("facebook")) return "facebook"
    return "unknown"
  } catch (error) {
    return "unknown"
  }
}

// Seleção inteligente de cookies por plataforma
function getSmartCookie(platform) {
  let pool = []

  switch (platform.toLowerCase()) {
    case "youtube":
    case "reddit":
      pool = googleCookiePool
      break
    case "twitter":
    case "x":
      pool = twitterCookiePool.length > 0 ? twitterCookiePool : googleCookiePool
      break
    case "instagram":
      pool = instagramCookiePool
      break
    default:
      pool = generalCookiePool
  }

  if (pool.length === 0) {
    return null
  }

  const selected = pool[Math.floor(Math.random() * pool.length)]
  return selected
}

function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)]
}

// Seleção de formato de qualidade
function getFormatSelector(format, quality, platform) {
  if (format === "mp3") {
    return "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/best"
  }

  const q = Number.parseInt(quality)

  if (platform === "tiktok") {
    if (q >= 1080) return "best[height<=1080][ext=mp4]/best[height<=1080]/best"
    if (q >= 720) return "best[height<=720][ext=mp4]/best[height<=720]/best"
    if (q >= 480) return "best[height<=480][ext=mp4]/best[height<=480]/best"
    if (q >= 360) return "best[height<=360][ext=mp4]/best[height<=360]/best"
    if (q >= 240) return "best[height<=240][ext=mp4]/best[height<=240]/best"
    return "best[height<=144][ext=mp4]/best[height<=144]/best"
  }

  if (platform === "instagram") {
    if (q >= 1080) return "best[height<=1080][ext=mp4]/best[height<=1080]/best"
    if (q >= 720) return "best[height<=720][ext=mp4]/best[height<=720]/best"
    if (q >= 480) return "best[height<=480][ext=mp4]/best[height<=480]/best"
    if (q >= 360) return "best[height<=360][ext=mp4]/best[height<=360]/best"
    if (q >= 240) return "best[height<=240][ext=mp4]/best[height<=240]/best"
    return "best[height<=144][ext=mp4]/best[height<=144]/best"
  }

  // YouTube, Twitter e outras plataformas
  if (q >= 1080) {
    return "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best"
  } else if (q >= 720) {
    return "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]/best"
  } else if (q >= 480) {
    return "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]/best"
  } else if (q >= 360) {
    return "bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=360]+bestaudio/best[height<=360]/best"
  } else if (q >= 240) {
    return "bestvideo[height<=240][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=240]+bestaudio/best[height<=240]/best"
  } else {
    return "bestvideo[height<=144][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=144]+bestaudio/best[height<=144]/best"
  }
}

// Construção de comando yt-dlp
function buildSecureCommand(userAgent, cookieFile, platform) {
  const baseArgs = [
    "--user-agent",
    userAgent,
    "--no-playlist",
    "--no-check-certificates",
    "--prefer-insecure",
    "--extractor-retries",
    "2",
    "--fragment-retries",
    "2",
    "--retry-sleep",
    "1",
    "--no-call-home",
    "--geo-bypass",
    "--ignore-errors",
    "--add-header",
    "Accept-Language:en-US,en;q=0.9",
    "--add-header",
    "Accept-Encoding:gzip, deflate",
    "--add-header",
    "Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "--add-header",
    "Connection:keep-alive",
    "--add-header",
    "Upgrade-Insecure-Requests:1",
  ]

  if (platform === "tiktok") {
    baseArgs.push("--fragment-retries", "5", "--retry-sleep", "2", "--no-part", "--concurrent-fragments", "1")
  }

  if (platform === "instagram") {
    baseArgs.push(
      "--sleep-interval",
      "1",
      "--max-sleep-interval",
      "3",
      "--extractor-retries",
      "3",
      "--fragment-retries",
      "3",
      "--retry-sleep",
      "2",
    )
  }

  if (platform === "twitter") {
    baseArgs.push(
      "--sleep-interval",
      "1",
      "--max-sleep-interval",
      "2",
      "--extractor-retries",
      "3",
      "--fragment-retries",
      "3",
      "--retry-sleep",
      "1",
    )
  }

  if (cookieFile) {
    baseArgs.push("--cookies", cookieFile)
  }

  return baseArgs
}

// Detecção de erros
function isAuthenticationError(errorMessage) {
  const authErrors = [
    "requires authentication",
    "requiring login",
    "NSFW tweet",
    "private video",
    "private account",
    "login required",
    "sign in to confirm",
    "cookies",
    "Use --cookies",
    "not a bot",
    "captcha",
    "verification",
    "blocked",
    "rate limit",
    "not available",
    "rate-limit reached",
    "metadata extraction failed",
    "unable to extract shared data",
    "not available on this app",
    "latest version of YouTube",
  ]

  return authErrors.some((error) => errorMessage.toLowerCase().includes(error.toLowerCase()))
}

function isNonCriticalError(errorMessage) {
  const nonCriticalErrors = [
    "impersonation",
    "impersonate target",
    "subtitle",
    "Unable to download video subtitles",
    "HTTP Error 429",
    "Too Many Requests",
    "WARNING:",
  ]

  return nonCriticalErrors.some((error) => errorMessage.toLowerCase().includes(error.toLowerCase()))
}

function isYouTubeEmptyFileError(errorMessage) {
  const emptyFileErrors = ["downloaded file is empty", "file is empty", "0 bytes", "empty file"]

  return emptyFileErrors.some((error) => errorMessage.toLowerCase().includes(error.toLowerCase()))
}

const fileMap = new Map()

// Busca de arquivo recente
function findRecentFile(baseDir, timestamp, extensions = [".mp4", ".mp3"]) {
  try {
    const files = fs.readdirSync(baseDir)
    const recentFiles = files.filter((file) => {
      const filePath = path.join(baseDir, file)
      const stats = fs.statSync(filePath)
      const fileTime = stats.birthtime.getTime()
      const timeDiff = Math.abs(fileTime - timestamp)

      return timeDiff < 300000 && extensions.some((ext) => file.toLowerCase().endsWith(ext))
    })

    if (recentFiles.length > 0) {
      recentFiles.sort((a, b) => {
        const aTime = fs.statSync(path.join(baseDir, a)).birthtime.getTime()
        const bTime = fs.statSync(path.join(baseDir, b)).birthtime.getTime()
        return bTime - aTime
      })
      return path.join(baseDir, recentFiles[0])
    }
  } catch (error) {
    console.error("❌ Erro ao procurar arquivo:", error)
  }
  return null
}

app.use(express.json({ limit: "5mb" }))

if (!fs.existsSync(DOWNLOADS)) {
  fs.mkdirSync(DOWNLOADS, { recursive: true, mode: 0o755 })
}

if (!fs.existsSync(COOKIES_DIR)) {
  fs.mkdirSync(COOKIES_DIR, { recursive: true, mode: 0o700 })
}

// Rota principal de download
app.post("/download", async (req, res) => {
  const startTime = Date.now()
  let downloadStarted = false
  let detectedPlatform = ""

  try {
    // Verificar limite dinâmico de downloads
    if (activeDownloads >= CURRENT_MAX_CONCURRENT_DOWNLOADS) {
      return res.status(429).json({
        error: `Servidor ocupado. Máximo de downloads simultâneos: ${CURRENT_MAX_CONCURRENT_DOWNLOADS}`,
        type: "server_busy",
        current_limit: CURRENT_MAX_CONCURRENT_DOWNLOADS,
        economy_mode: resourceEconomizer.isEconomyMode,
      })
    }

    const { url, format, quality } = req.body

    const validationErrors = validateDownloadParams(url, format, quality)
    if (validationErrors.length > 0) {
      return res.status(400).json({
        error: "Parâmetros inválidos",
        details: validationErrors,
      })
    }

    detectedPlatform = detectPlatform(url)

    logDownload("NOVA REQUISIÇÃO", {
      url: url.substring(0, 100) + (url.length > 100 ? "..." : ""),
      format,
      quality,
      platform: detectedPlatform,
      economy_mode: resourceEconomizer.isEconomyMode,
      timestamp: new Date().toISOString(),
    })

    activeDownloads++
    downloadStarted = true

    if (activeDownloads === 1) {
      ultraAggressiveMemoryCleanup()
    }

    const cookieFile = getSmartCookie(detectedPlatform)
    const randomUA = getRandomUserAgent()
    const uniqueId = crypto.randomBytes(8).toString("hex")

    logInfo("🍪", "Cookie selecionado", {
      platform: detectedPlatform,
      cookie_file: cookieFile ? path.basename(cookieFile) : "sem_cookie",
    })

    const jsonArgs = [...buildSecureCommand(randomUA, cookieFile, detectedPlatform), "-j", url]

    try {
      const { stdout: jsonStdout } = await executeSecureCommand(ytDlpPath, jsonArgs, {
        timeout: 30000,
      })

      let data
      try {
        const jsonLine = jsonStdout.split("\n").find((line) => line.trim().startsWith("{"))
        if (!jsonLine) throw new Error("JSON não encontrado")
        data = JSON.parse(jsonLine)
      } catch (e) {
        return res.status(500).json({ error: "Resposta JSON inválida" })
      }

      logDownload("ARQUIVO APROVADO", {
        title: data.title?.substring(0, 80) || "sem_titulo",
        duration: formatDuration(data.duration || 0),
        filesize: data.filesize ? formatFileSize(data.filesize) : "desconhecido",
        platform: detectedPlatform,
      })

      const durationCheck = checkDuration(data.duration)
      if (!durationCheck.allowed) {
        return res.status(400).json({
          error: durationCheck.message,
          type: "duration_exceeded",
          economy_mode: resourceEconomizer.isEconomyMode,
        })
      }

      if (data.filesize && data.filesize > MAX_FILE_SIZE) {
        return res.status(400).json({
          error: "Arquivo muito grande. Máximo: 512MB",
          type: "file_too_large",
        })
      }

      const safeTitle = generateSecureFilename(data.title, quality, format, uniqueId)
      const outputPath = path.join(DOWNLOADS, safeTitle)

      let downloadArgs
      if (format === "mp3") {
        const q = Number.parseInt(quality || "128")
        const formatSelector = getFormatSelector("mp3", quality, detectedPlatform)
        downloadArgs = [
          ...buildSecureCommand(randomUA, cookieFile, detectedPlatform),
          "-f",
          formatSelector,
          "--extract-audio",
          "--audio-format",
          "mp3",
          "--audio-quality",
          `${q}k`,
          "--add-metadata",
          "--embed-thumbnail",
          "-o",
          outputPath,
          url,
        ]
      } else {
        const formatSelector = getFormatSelector("mp4", quality, detectedPlatform)

        if (detectedPlatform === "tiktok" || detectedPlatform === "instagram") {
          downloadArgs = [
            ...buildSecureCommand(randomUA, cookieFile, detectedPlatform),
            "-f",
            formatSelector,
            "--add-metadata",
            "-o",
            outputPath,
            url,
          ]
        } else {
          downloadArgs = [
            ...buildSecureCommand(randomUA, cookieFile, detectedPlatform),
            "-f",
            formatSelector,
            "--merge-output-format",
            "mp4",
            "--add-metadata",
            "-o",
            outputPath,
            url,
          ]
        }
      }

      logInfo("🚀", "Iniciando download...", {
        output: path.basename(outputPath),
        format_selector: getFormatSelector(format, quality, detectedPlatform).substring(0, 50),
      })

      try {
        const { stderr: downloadStderr } = await executeSecureCommand(ytDlpPath, downloadArgs, {
          timeout: 300000,
        })

        if (downloadStderr && isNonCriticalError(downloadStderr)) {
          console.log("⚠️ Avisos não críticos ignorados")
        }

        let finalFilePath = outputPath
        if (!fs.existsSync(finalFilePath)) {
          finalFilePath = findRecentFile(DOWNLOADS, startTime, [`.${format === "mp3" ? "mp3" : "mp4"}`])
          if (!finalFilePath) {
            return res.status(500).json({ error: "Arquivo não criado" })
          }
        }

        const stats = fs.statSync(finalFilePath)

        // Verificação de arquivo vazio (YouTube)
        if (stats.size < 1000) {
          if (detectedPlatform === "youtube") {
            try {
              if (fs.existsSync(finalFilePath)) {
                fs.unlinkSync(finalFilePath)
              }

              const retryResult = await YouTubeEmptyFileHandler.handleEmptyFile(
                url,
                format,
                quality,
                randomUA,
                cookieFile,
                detectedPlatform,
                outputPath,
              )

              if (retryResult.success) {
                finalFilePath = retryResult.filePath
                const newStats = fs.statSync(finalFilePath)

                const downloadKey = `download_${crypto.randomBytes(16).toString("hex")}.${format === "mp3" ? "mp3" : "mp4"}`
                fileMap.set(downloadKey, {
                  actualPath: finalFilePath,
                  actualFilename: path.basename(finalFilePath),
                  userFriendlyName: `${data.title.substring(0, 50)} - ${format === "mp3" ? quality + "kbps" : quality + "p"}.${format === "mp3" ? "mp3" : "mp4"}`,
                  size: newStats.size,
                  created: Date.now(),
                })

                ultraAggressiveMemoryCleanup()

                return res.json({
                  file: `/downloads/${downloadKey}`,
                  filename: `${data.title.substring(0, 50)} - ${format === "mp3" ? quality + "kbps" : quality + "p"}.${format === "mp3" ? "mp3" : "mp4"}`,
                  size: newStats.size,
                  title: data.title,
                  duration: data.duration,
                  platform: detectedPlatform,
                })
              }
            } catch (retryError) {
              return res.status(500).json({
                error: "YouTube: Arquivo vazio. Tente outro vídeo.",
                type: "youtube_empty_file",
              })
            }
          } else {
            return res.status(500).json({ error: "Arquivo corrompido" })
          }
        }

        const downloadKey = `download_${crypto.randomBytes(16).toString("hex")}.${format === "mp3" ? "mp3" : "mp4"}`
        fileMap.set(downloadKey, {
          actualPath: finalFilePath,
          actualFilename: path.basename(finalFilePath),
          userFriendlyName: `${data.title.substring(0, 50)} - ${format === "mp3" ? quality + "kbps" : quality + "p"}.${format === "mp3" ? "mp3" : "mp4"}`,
          size: stats.size,
          created: Date.now(),
        })

        logDownload("DOWNLOAD CONCLUÍDO", {
          platform: detectedPlatform,
          title: data.title?.substring(0, 60) || "sem_titulo",
          size: formatFileSize(stats.size),
          duration: formatDuration(data.duration || 0),
          format: `${format.toUpperCase()} - ${quality}${format === "mp3" ? "kbps" : "p"}`,
          used_cookies: cookieFile ? true : false,
          cookie_file: cookieFile ? path.basename(cookieFile) : null,
          download_time: `${Math.round((Date.now() - startTime) / 1000)}s`,
        })

        ultraAggressiveMemoryCleanup()

        res.json({
          file: `/downloads/${downloadKey}`,
          filename: `${data.title.substring(0, 50)} - ${format === "mp3" ? quality + "kbps" : quality + "p"}.${format === "mp3" ? "mp3" : "mp4"}`,
          size: stats.size,
          title: data.title,
          duration: data.duration,
          platform: detectedPlatform,
        })
      } catch (downloadError) {
        if (detectedPlatform === "youtube" && isYouTubeEmptyFileError(downloadError.message)) {
          try {
            const retryResult = await YouTubeEmptyFileHandler.handleEmptyFile(
              url,
              format,
              quality,
              randomUA,
              cookieFile,
              detectedPlatform,
              outputPath,
            )

            if (retryResult.success) {
              const downloadKey = `download_${crypto.randomBytes(16).toString("hex")}.${format === "mp3" ? "mp3" : "mp4"}`
              fileMap.set(downloadKey, {
                actualPath: retryResult.filePath,
                actualFilename: path.basename(retryResult.filePath),
                userFriendlyName: `${data.title.substring(0, 50)} - ${format === "mp3" ? quality + "kbps" : quality + "p"}.${format === "mp3" ? "mp3" : "mp4"}`,
                size: retryResult.size,
                created: Date.now(),
              })

              logDownload("DOWNLOAD CONCLUÍDO", {
                platform: detectedPlatform,
                title: data.title?.substring(0, 60) || "sem_título",
                size: formatFileSize(retryResult.size),
                duration: formatDuration(data.duration || 0),
                format: `${format.toUpperCase()} - ${quality}${format === "mp3" ? "kbps" : "p"}`,
                used_cookies: cookieFile ? true : false,
                cookie_file: cookieFile ? path.basename(cookieFile) : null,
                download_time: `${Math.round((Date.now() - startTime) / 1000)}s`,
              })

              ultraAggressiveMemoryCleanup()

              return res.json({
                file: `/downloads/${downloadKey}`,
                filename: `${data.title.substring(0, 50)} - ${format === "mp3" ? quality + "kbps" : quality + "p"}.${format === "mp3" ? "mp3" : "mp4"}`,
                size: retryResult.size,
                title: data.title,
                duration: data.duration,
                platform: detectedPlatform,
              })
            }
          } catch (retryError) {
            return res.status(500).json({
              error: "YouTube: Problema persistente. Tente outro.",
              type: "youtube_persistent_error",
            })
          }
        }

        if (isAuthenticationError(downloadError.message)) {
          if (detectedPlatform === "instagram") {
            return res.status(400).json({
              error: "Instagram: Configure cookies",
              type: "instagram_auth_required",
            })
          } else if (detectedPlatform === "twitter") {
            return res.status(400).json({
              error: "Twitter NSFW: Configure TWITTER_COOKIE_01",
              type: "twitter_nsfw_required",
            })
          }
          return res.status(400).json({
            error: "Conteúdo privado",
            type: "private_content",
          })
        } else {
          return res.status(500).json({ error: "Falha no download" })
        }
      }
    } catch (error) {
      if (isAuthenticationError(error.message)) {
        if (detectedPlatform === "instagram") {
          return res.status(400).json({
            error: "Instagram: Configure cookies",
            type: "instagram_auth_required",
          })
        } else if (detectedPlatform === "twitter") {
          return res.status(400).json({
            error: "Twitter NSFW: Configure TWITTER_COOKIE_01",
            type: "twitter_nsfw_required",
          })
        }
        return res.status(400).json({
          error: "Conteúdo privado",
          type: "private_content",
        })
      } else {
        return res.status(500).json({ error: "Falha ao obter informações" })
      }
    }
  } catch (error) {
    logError("ERRO NO DOWNLOAD", {
      message: error.message,
      platform: detectedPlatform,
    })
    res.status(500).json({ error: "Erro interno" })
  } finally {
    if (downloadStarted) {
      activeDownloads = Math.max(0, activeDownloads - 1)

      if (activeDownloads === 0) {
        setTimeout(() => {
          ultraAggressiveMemoryCleanup()
        }, 5000)
      }
    }
  }
})

// Rota de status de memória
app.get("/memory", (req, res) => {
  const memory = process.memoryUsage()
  const heapMB = Math.round(memory.heapUsed / 1024 / 1024)

  if (req.query.cleanup === "true") {
    ultraAggressiveMemoryCleanup()
  }

  res.json({
    heap_used: heapMB,
    rss_total: Math.round(memory.rss / 1024 / 1024),
    economy_mode: resourceEconomizer.isEconomyMode,
    active_downloads: activeDownloads,
    current_limits: {
      max_concurrent: CURRENT_MAX_CONCURRENT_DOWNLOADS,
      max_duration: formatDuration(CURRENT_MAX_DURATION),
    },
    uptime: Math.round(process.uptime()),
  })
})

// Rota de teste de cookies
app.get("/test-cookies", async (req, res) => {
  const results = {
    pools: {
      google: googleCookiePool.length,
      instagram: instagramCookiePool.length,
      twitter: twitterCookiePool.length,
      general: generalCookiePool.length,
    },
    economy_status: resourceEconomizer.getEconomyStatus(),
  }

  res.json(results)
})

// Rota de download de arquivo
app.get("/downloads/:fileKey", (req, res) => {
  const fileKey = sanitizeInput(req.params.fileKey, 100)

  const fileInfo = fileMap.get(fileKey)
  if (!fileInfo) {
    return res.status(404).json({ error: "Arquivo não encontrado" })
  }

  const { actualPath, userFriendlyName, size } = fileInfo

  if (!fs.existsSync(actualPath)) {
    fileMap.delete(fileKey)
    return res.status(404).json({ error: "Arquivo não existe" })
  }

  try {
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(userFriendlyName)}"`)
    res.setHeader("Content-Type", "application/octet-stream")
    res.setHeader("Content-Length", size)
    res.setHeader("Cache-Control", "no-cache")
    res.setHeader("X-Content-Type-Options", "nosniff")

    const fileStream = fs.createReadStream(actualPath)

    fileStream.on("error", (error) => {
      if (!res.headersSent) {
        res.status(500).json({ error: "Erro ao ler arquivo" })
      }
    })

    fileStream.pipe(res)

    logInfo("📤", "Arquivo enviado", {
      filename: userFriendlyName.substring(0, 60),
      size: formatFileSize(size),
    })
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: "Erro interno" })
    }
  }
})

// Rota de health check
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    uptime: Math.round(process.uptime()),
    active_downloads: activeDownloads,
    economy_mode: resourceEconomizer.isEconomyMode,
    current_limits: {
      max_concurrent: CURRENT_MAX_CONCURRENT_DOWNLOADS,
      max_duration: formatDuration(CURRENT_MAX_DURATION),
    },
    cookies: {
      google: googleCookiePool.length,
      instagram: instagramCookiePool.length,
      twitter: twitterCookiePool.length,
    },
  })
})

// Rota raiz
app.get("/", (req, res) => {
  res.json({
    message: "WaifuConvert Backend",
    status: "online",
    platforms: ["TikTok", "Twitter", "Instagram", "YouTube", "Reddit", "Facebook"],
    economy_mode: resourceEconomizer.isEconomyMode,
  })
})

// Error handlers
app.use((error, req, res, next) => {
  logError("ERRO INTERNO", error)
  res.status(500).json({ error: "Erro interno" })
})

app.use("*", (req, res) => {
  res.status(404).json({ error: "Rota não encontrada" })
})

// Inicialização do servidor
app.listen(PORT, async () => {
  console.log(`\n${"=".repeat(60)}`)
  console.log(`🛡️ WaifuConvert Backend - Porta ${PORT}`)
  console.log(`${"=".repeat(60)}\n`)

  createSecureCookieFiles()
  loadCookiePool()

  console.log(`🍪 Cookies carregados:`)
  console.log(`   Google: ${googleCookiePool.length}`)
  console.log(`   Instagram: ${instagramCookiePool.length}`)
  console.log(`   Twitter: ${twitterCookiePool.length}`)
  console.log(`   Total: ${generalCookiePool.length}\n`)

  startContinuousMemoryMonitoring()
  startAggressiveFileCleanup()
  startKeepAliveSystem()
  startEconomyCheck()

  console.log(`✅ Backend pronto!`)
  console.log(`💡 Modo Economia: ativa após 10min de inatividade`)
  console.log(`💡 Keep-Alive: ping a cada 8min\n`)
})

// Process handlers
process.on("uncaughtException", (error) => {
  console.error("❌ Erro não capturado:", error.message)
  process.exit(1)
})

process.on("unhandledRejection", (reason) => {
  console.error("❌ Promise rejeitada:", reason)
})

process.on("SIGTERM", () => {
  console.log("\n⚠️ Recebido SIGTERM - encerrando graciosamente...")
  if (memoryCleanupInterval) clearInterval(memoryCleanupInterval)
  if (fileCleanupInterval) clearInterval(fileCleanupInterval)
  if (keepAliveInterval) clearInterval(keepAliveInterval)
  if (economyCheckInterval) clearInterval(economyCheckInterval)
  process.exit(0)
})

process.on("SIGINT", () => {
  console.log("\n⚠️ Recebido SIGINT - encerrando graciosamente...")
  if (memoryCleanupInterval) clearInterval(memoryCleanupInterval)
  if (fileCleanupInterval) clearInterval(fileCleanupInterval)
  if (keepAliveInterval) clearInterval(keepAliveInterval)
  if (economyCheckInterval) clearInterval(economyCheckInterval)
  process.exit(0)
})
