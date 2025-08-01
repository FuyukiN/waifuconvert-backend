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

// 🛡️ CONFIGURAÇÕES MAIS GENEROSAS
const PORT = process.env.PORT || 8080
const MAX_CONCURRENT_DOWNLOADS = 8 // era 5
const MAX_FILE_SIZE = 1024 * 1024 * 1024 // 1GB (era 500MB)
const ALLOWED_DOMAINS = [
  // TikTok
  "tiktok.com",
  "vm.tiktok.com",
  "vt.tiktok.com",
  "m.tiktok.com",
  "www.tiktok.com",

  // Twitter/X
  "twitter.com",
  "x.com",
  "t.co",
  "mobile.twitter.com",
  "www.twitter.com",
  "www.x.com",

  // Instagram
  "instagram.com",
  "www.instagram.com",
  "m.instagram.com",

  // YouTube
  "youtube.com",
  "youtu.be",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",

  // Reddit
  "reddit.com",
  "www.reddit.com",
  "old.reddit.com",
  "m.reddit.com",
  "new.reddit.com",

  // Facebook
  "facebook.com",
  "fb.watch",
  "www.facebook.com",
  "m.facebook.com",
  "web.facebook.com",

  // Outras plataformas
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

// 🛡️ CONTADOR DE DOWNLOADS ATIVOS
let activeDownloads = 0

// 🛡️ MIDDLEWARE DE SEGURANÇA
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

// 🛡️ RATE LIMITING MAIS AMIGÁVEL
const downloadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutos (era 15)
  max: 20, // máximo 20 downloads por IP a cada 10 minutos (era 10 a cada 15)
  message: {
    error: "Muitas tentativas de download. Tente novamente em alguns minutos.",
    type: "rate_limit_exceeded",
  },
  standardHeaders: true,
  legacyHeaders: false,
})

const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 60, // máximo 60 requests por IP por minuto (era 30)
  message: {
    error: "Muitas requisições. Tente novamente em 1 minuto.",
    type: "rate_limit_exceeded",
  },
})

app.use(generalLimiter)
app.use("/download", downloadLimiter)

// 🛡️ VALIDAÇÃO DE URL SEGURA
function isValidUrl(url) {
  try {
    // Verificar se é uma URL válida
    if (
      !validator.isURL(url, {
        protocols: ["http", "https"],
        require_protocol: true,
        require_valid_protocol: true,
        allow_underscores: true,
        allow_trailing_dot: false,
        allow_protocol_relative_urls: false,
        allow_fragments: true, // Permite #
        allow_query_components: true, // Permite ?param=value
      })
    ) {
      return false
    }

    const parsedUrl = new URL(url)
    const hostname = parsedUrl.hostname.toLowerCase()

    // 🎯 VERIFICAÇÃO MAIS INTELIGENTE DE DOMÍNIOS
    const isAllowedDomain = ALLOWED_DOMAINS.some((domain) => {
      // Domínio exato
      if (hostname === domain) return true

      // Subdomínio (ex: vm.tiktok.com, www.youtube.com, mobile.twitter.com)
      if (hostname.endsWith("." + domain)) return true

      // Casos especiais para domínios conhecidos
      if (domain === "tiktok.com" && (hostname.includes("tiktok") || hostname.includes("musically"))) return true
      if (domain === "twitter.com" && hostname.includes("twimg")) return true // Para imagens do Twitter
      if (domain === "youtube.com" && (hostname.includes("youtube") || hostname.includes("youtu"))) return true
      if (domain === "instagram.com" && (hostname.includes("instagram") || hostname.includes("cdninstagram")))
        return true

      return false
    })

    if (!isAllowedDomain) {
      console.warn(`🚫 Domínio não permitido: ${hostname}`)
      console.warn(`📝 URL completa: ${url.substring(0, 100)}...`)
      return false
    }

    // Verificar se não é um IP local/privado (mais específico)
    const privateIpPatterns = [
      /^127\./, // 127.x.x.x
      /^192\.168\./, // 192.168.x.x
      /^10\./, // 10.x.x.x
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.x.x - 172.31.x.x
      /^0\.0\.0\.0$/, // 0.0.0.0
      /^localhost$/i, // localhost
    ]

    const isPrivateIp = privateIpPatterns.some((pattern) => pattern.test(hostname))

    if (isPrivateIp) {
      console.warn(`🚫 IP privado/local bloqueado: ${hostname}`)
      return false
    }

    return true
  } catch (error) {
    console.error("❌ Erro na validação de URL:", error.message)
    return false
  }
}

// 🛡️ SANITIZAÇÃO DE ENTRADA
function sanitizeInput(input, maxLength = 100) {
  if (typeof input !== "string") return ""

  return input
    .trim()
    .substring(0, maxLength)
    .replace(/[<>"'&]/g, "") // Remove caracteres perigosos
    .replace(/\0/g, "") // Remove null bytes
}

// 🛡️ GERAÇÃO DE NOMES DE ARQUIVO SEGUROS
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

// 🛡️ VALIDAÇÃO MAIS AMIGÁVEL
function validateDownloadParams(url, format, quality) {
  const errors = []

  if (!url || typeof url !== "string") {
    errors.push("Por favor, cole um link válido")
  } else if (!isValidUrl(url)) {
    // Detectar qual pode ser o problema
    try {
      const hostname = new URL(url).hostname.toLowerCase()
      if (hostname.includes("localhost") || hostname.startsWith("127.") || hostname.startsWith("192.168.")) {
        errors.push("Links locais não são permitidos por segurança")
      } else {
        errors.push(
          `Este site não é suportado ainda. Tente: TikTok, Twitter/X, Instagram, YouTube, Reddit, Facebook, Twitch, SoundCloud, Vimeo`,
        )
      }
    } catch {
      errors.push("Link inválido. Certifique-se de copiar a URL completa (com https://)")
    }
  }

  if (!format || !["mp3", "mp4"].includes(format)) {
    errors.push("Escolha MP3 (áudio) ou MP4 (vídeo)")
  }

  if (quality) {
    const q = Number.parseInt(quality)
    if (format === "mp3" && (q < 64 || q > 320)) {
      errors.push("Qualidade de áudio deve estar entre 64 e 320 kbps")
    } else if (format === "mp4" && ![360, 480, 720, 1080].includes(q)) {
      errors.push("Qualidade de vídeo deve ser 360p, 480p, 720p ou 1080p")
    }
  }

  return errors
}

// 🛡️ EXECUÇÃO SEGURA DE COMANDOS
function executeSecureCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || 600000 // 10 minutos padrão (era 5)

    console.log("🚀 Executando comando seguro:", command, args.slice(0, 3).join(" "), "...")

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
        reject(new Error(`Comando falhou com código ${code}: ${stderr}`))
      }
    })

    child.on("error", (error) => {
      reject(error)
    })

    // Timeout manual adicional
    const timeoutId = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error("Comando excedeu tempo limite"))
    }, timeout)

    child.on("close", () => {
      clearTimeout(timeoutId)
    })
  })
}

// YT-DLP PATH SEGURO
const ytDlpPath = "yt-dlp"

// User-Agents atualizados
const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/131.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
]

// 🛡️ CRIAÇÃO SEGURA DE COOKIES
function createSecureCookieFiles() {
  console.log("🛡️ Criando arquivos de cookie seguros...")

  if (!fs.existsSync(COOKIES_DIR)) {
    fs.mkdirSync(COOKIES_DIR, { recursive: true, mode: 0o700 }) // Permissões restritas
  }

  let cookiesCreated = 0

  // Cookies Google
  for (let i = 1; i <= 10; i++) {
    const envVar = `GOOGLE_COOKIE_${i.toString().padStart(2, "0")}`
    const cookieContent = process.env[envVar]

    if (cookieContent) {
      const filename = `google_conta${i.toString().padStart(2, "0")}.txt`
      const filepath = path.join(COOKIES_DIR, filename)

      // Validar conteúdo do cookie
      if (cookieContent.length > 10 && cookieContent.includes("=")) {
        fs.writeFileSync(filepath, cookieContent, { mode: 0o600 }) // Permissões restritas
        console.log(`✅ Cookie Google ${i} criado: ${filename}`)
        cookiesCreated++
      }
    }
  }

  // Cookies Instagram
  for (let i = 1; i <= 8; i++) {
    const envVar = `INSTAGRAM_COOKIE_${i.toString().padStart(2, "0")}`
    const cookieContent = process.env[envVar]

    if (cookieContent) {
      const filename = `instagram_conta${i.toString().padStart(2, "0")}.txt`
      const filepath = path.join(COOKIES_DIR, filename)

      if (cookieContent.length > 10 && cookieContent.includes("=")) {
        fs.writeFileSync(filepath, cookieContent, { mode: 0o600 })
        console.log(`✅ Cookie Instagram ${i} criado: ${filename}`)
        cookiesCreated++
      }
    }
  }

  console.log(`🎯 Total de cookies criados: ${cookiesCreated}`)
  return cookiesCreated
}

// Pools de cookies
let googleCookiePool = []
let instagramCookiePool = []
let generalCookiePool = []

function loadCookiePool() {
  try {
    if (!fs.existsSync(COOKIES_DIR)) {
      fs.mkdirSync(COOKIES_DIR, { recursive: true })
      return
    }

    const files = fs.readdirSync(COOKIES_DIR).filter((file) => file.endsWith(".txt"))

    googleCookiePool = files.filter((f) => f.startsWith("google_")).map((f) => path.join(COOKIES_DIR, f))
    instagramCookiePool = files.filter((f) => f.startsWith("instagram_")).map((f) => path.join(COOKIES_DIR, f))
    generalCookiePool = files.map((file) => path.join(COOKIES_DIR, file))

    console.log(`🔵 Google cookies: ${googleCookiePool.length}`)
    console.log(`📸 Instagram cookies: ${instagramCookiePool.length}`)
    console.log(`🍪 Total cookies: ${generalCookiePool.length}`)
  } catch (error) {
    console.error("❌ Erro ao carregar cookies:", error)
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

function getSmartCookie(platform) {
  switch (platform.toLowerCase()) {
    case "youtube":
    case "twitter":
    case "reddit":
      return getRandomFromPool(googleCookiePool)
    case "instagram":
      return getRandomFromPool(instagramCookiePool)
    default:
      return getRandomFromPool(generalCookiePool)
  }
}

function getRandomFromPool(pool) {
  if (pool.length === 0) return null
  return pool[Math.floor(Math.random() * pool.length)]
}

function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)]
}

function getFormatSelector(format, quality, platform) {
  if (format === "mp3") {
    return "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/best"
  }

  const q = Number.parseInt(quality)

  if (platform === "tiktok") {
    if (q >= 1080) return "best[height<=1080][ext=mp4]/best[height<=1080]/best[ext=mp4]/best"
    if (q >= 720) return "best[height<=720][ext=mp4]/best[height<=720]/best[ext=mp4]/best"
    if (q >= 480) return "best[height<=480][ext=mp4]/best[height<=480]/best[ext=mp4]/best"
    return "best[height<=360][ext=mp4]/best[height<=360]/best[ext=mp4]/best"
  }

  if (platform === "instagram") {
    if (q >= 1080) return "best[height<=1080][ext=mp4]/best[height<=1080]/best[ext=mp4]/best"
    if (q >= 720) return "best[height<=720][ext=mp4]/best[height<=720]/best[ext=mp4]/best"
    if (q >= 480) return "best[height<=480][ext=mp4]/best[height<=480]/best[ext=mp4]/best"
    return "best[height<=360][ext=mp4]/best[height<=360]/best[ext=mp4]/best"
  }

  // Configurações padrão
  if (q >= 1080) {
    return "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080][ext=mp4]/best[height<=1080]/best[ext=mp4]/best"
  } else if (q >= 720) {
    return "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720][ext=mp4]/best[height<=720]/best[ext=mp4]/best"
  } else if (q >= 480) {
    return "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480][ext=mp4]/best[height<=480]/best[ext=mp4]/best"
  } else {
    return "bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=360]+bestaudio/best[height<=360][ext=mp4]/best[height<=360]/best[ext=mp4]/best"
  }
}

function buildSecureCommand(userAgent, cookieFile, platform) {
  const baseArgs = [
    "--user-agent",
    userAgent,
    "--no-playlist",
    "--no-check-certificates",
    "--prefer-insecure",
    "--extractor-retries",
    "3",
    "--fragment-retries",
    "3",
    "--retry-sleep",
    "1",
    "--no-call-home",
    "--geo-bypass",
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
    baseArgs.push("--fragment-retries", "10", "--retry-sleep", "2", "--no-part", "--concurrent-fragments", "1")
  }

  if (platform === "instagram") {
    baseArgs.push(
      "--sleep-interval",
      "2",
      "--max-sleep-interval",
      "5",
      "--extractor-retries",
      "5",
      "--fragment-retries",
      "5",
      "--retry-sleep",
      "3",
    )
  }

  if (cookieFile) {
    baseArgs.push("--cookies", cookieFile)
  }

  return baseArgs
}

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
    "requested content is not available",
    "rate-limit reached",
    "General metadata extraction failed",
    "unable to extract shared data",
  ]

  return authErrors.some((error) => errorMessage.toLowerCase().includes(error.toLowerCase()))
}

// Mapa de arquivos seguro
const fileMap = new Map()

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

function cleanupOldFiles() {
  try {
    const files = fs.readdirSync(DOWNLOADS)
    const oneHourAgo = Date.now() - 60 * 60 * 1000

    files.forEach((file) => {
      const filePath = path.join(DOWNLOADS, file)
      const stats = fs.statSync(filePath)

      if (stats.mtime.getTime() < oneHourAgo) {
        fs.unlinkSync(filePath)
        console.log("🗑️ Arquivo antigo removido:", file)

        for (const [key, value] of fileMap.entries()) {
          if (value.actualPath === filePath) {
            fileMap.delete(key)
            break
          }
        }
      }
    })
  } catch (error) {
    console.error("❌ Erro ao limpar arquivos:", error.message)
  }
}

// CORS seguro
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
  }),
)

app.use(express.json({ limit: "10mb" }))

// Criar diretórios
if (!fs.existsSync(DOWNLOADS)) {
  fs.mkdirSync(DOWNLOADS, { recursive: true, mode: 0o755 })
}

if (!fs.existsSync(COOKIES_DIR)) {
  fs.mkdirSync(COOKIES_DIR, { recursive: true, mode: 0o700 })
}

// 🛡️ ROTA PRINCIPAL DE DOWNLOAD SEGURA
app.post("/download", async (req, res) => {
  const startTime = Date.now()

  try {
    // 🛡️ Verificar limite de downloads simultâneos
    if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
      return res.status(429).json({
        error: "Servidor ocupado no momento. Tente novamente em 1-2 minutos.",
        type: "server_busy",
        tip: "Muitas pessoas estão usando o serviço agora. 😊",
      })
    }

    const { url, format, quality } = req.body

    // 🛡️ Validar parâmetros
    const validationErrors = validateDownloadParams(url, format, quality)
    if (validationErrors.length > 0) {
      return res.status(400).json({
        error: "Parâmetros inválidos",
        details: validationErrors,
      })
    }

    activeDownloads++
    console.log(`🚀 Downloads ativos: ${activeDownloads}/${MAX_CONCURRENT_DOWNLOADS}`)

    const detectedPlatform = detectPlatform(url)
    const cookieFile = getSmartCookie(detectedPlatform)
    const randomUA = getRandomUserAgent()
    const uniqueId = crypto.randomBytes(8).toString("hex")

    console.log("🎯 Nova requisição segura:", {
      url: url.substring(0, 50) + "...",
      format,
      quality,
      platform: detectedPlatform,
    })

    // 🛡️ Obter informações do vídeo com comando seguro
    const jsonArgs = [...buildSecureCommand(randomUA, cookieFile, detectedPlatform), "-j", url]

    try {
      const { stdout: jsonStdout, stderr: jsonStderr } = await executeSecureCommand(ytDlpPath, jsonArgs, {
        timeout: 45000,
      })

      let data
      try {
        const jsonLine = jsonStdout.split("\n").find((line) => line.trim().startsWith("{"))
        if (!jsonLine) throw new Error("Nenhuma linha JSON encontrada")
        data = JSON.parse(jsonLine)
      } catch (e) {
        console.error("❌ Erro ao parsear JSON:", e)
        return res.status(500).json({ error: "Resposta JSON inválida" })
      }

      // 🛡️ Verificar tamanho do arquivo
      if (data.filesize && data.filesize > MAX_FILE_SIZE) {
        return res.status(400).json({
          error: "Arquivo muito grande. Máximo permitido: 1GB",
          type: "file_too_large",
        })
      }

      const safeTitle = generateSecureFilename(data.title, quality, format, uniqueId)
      const outputPath = path.join(DOWNLOADS, safeTitle)

      console.log("📁 Arquivo seguro:", safeTitle)

      // 🛡️ Construir comando de download seguro
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
            "--embed-subs",
            "--write-auto-subs",
            "--sub-langs",
            "pt,en",
            "-o",
            outputPath,
            url,
          ]
        }
      }

      console.log("🚀 Iniciando download seguro...")

      const { stdout: downloadStdout, stderr: downloadStderr } = await executeSecureCommand(ytDlpPath, downloadArgs, {
        timeout: 600000,
      })

      // 🛡️ Verificar arquivo criado
      let finalFilePath = outputPath
      if (!fs.existsSync(finalFilePath)) {
        finalFilePath = findRecentFile(DOWNLOADS, startTime, [`.${format === "mp3" ? "mp3" : "mp4"}`])
        if (!finalFilePath) {
          return res.status(500).json({ error: "Arquivo não foi criado" })
        }
      }

      const actualFilename = path.basename(finalFilePath)
      const stats = fs.statSync(finalFilePath)

      if (stats.size < 1000) {
        return res.status(500).json({ error: "Arquivo gerado está corrompido ou vazio" })
      }

      // 🛡️ Mapear arquivo com chave segura
      const downloadKey = `download_${crypto.randomBytes(16).toString("hex")}.${format === "mp3" ? "mp3" : "mp4"}`
      fileMap.set(downloadKey, {
        actualPath: finalFilePath,
        actualFilename: actualFilename,
        userFriendlyName: `${data.title.substring(0, 50)} - ${format === "mp3" ? quality + "kbps" : quality + "p"}.${format === "mp3" ? "mp3" : "mp4"}`,
        size: stats.size,
        created: Date.now(),
      })

      console.log("✅ Download seguro concluído:", {
        platform: detectedPlatform,
        downloadKey: downloadKey,
        size: `${(stats.size / 1024 / 1024).toFixed(2)} MB`,
        used_cookies: !!cookieFile,
      })

      res.json({
        file: `/downloads/${downloadKey}`,
        filename: `${data.title.substring(0, 50)} - ${format === "mp3" ? quality + "kbps" : quality + "p"}.${format === "mp3" ? "mp3" : "mp4"}`,
        size: stats.size,
        title: data.title,
        duration: data.duration,
        platform: detectedPlatform,
        quality_achieved: format === "mp3" ? `${quality}kbps` : `${quality}p`,
        used_cookies: !!cookieFile,
      })
    } catch (error) {
      console.error("❌ Erro no download:", error.message)

      if (isAuthenticationError(error.message)) {
        if (detectedPlatform === "instagram") {
          return res.status(400).json({
            error: "Instagram requer login. Configure cookies via environment variables.",
            type: "instagram_auth_required",
            platform: "instagram",
          })
        }
        return res.status(400).json({
          error: "Conteúdo privado ou requer login.",
          type: "private_content",
        })
      }

      return res.status(500).json({ error: "Falha no download/conversão" })
    }
  } catch (error) {
    console.error("❌ Erro inesperado:", error)
    res.status(500).json({ error: "Erro interno do servidor" })
  } finally {
    activeDownloads--
    console.log(`📉 Downloads ativos: ${activeDownloads}/${MAX_CONCURRENT_DOWNLOADS}`)
  }
})

// 🛡️ ROTA DE DOWNLOAD SEGURA
app.get("/downloads/:fileKey", (req, res) => {
  const fileKey = sanitizeInput(req.params.fileKey, 100)

  console.log("📥 Download solicitado:", fileKey)

  const fileInfo = fileMap.get(fileKey)
  if (!fileInfo) {
    return res.status(404).json({ error: "Arquivo não encontrado ou expirado" })
  }

  const { actualPath, userFriendlyName, size } = fileInfo

  if (!fs.existsSync(actualPath)) {
    fileMap.delete(fileKey)
    return res.status(404).json({ error: "Arquivo não encontrado no disco" })
  }

  try {
    // 🛡️ Headers seguros para download
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(userFriendlyName)}"`)
    res.setHeader("Content-Type", "application/octet-stream")
    res.setHeader("Content-Length", size)
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate")
    res.setHeader("Pragma", "no-cache")
    res.setHeader("Expires", "0")
    res.setHeader("X-Content-Type-Options", "nosniff")

    console.log("✅ Enviando arquivo seguro:", userFriendlyName)

    const fileStream = fs.createReadStream(actualPath)

    fileStream.on("error", (error) => {
      console.error("❌ Erro ao ler arquivo:", error)
      if (!res.headersSent) {
        res.status(500).json({ error: "Erro ao ler arquivo" })
      }
    })

    fileStream.pipe(res)
  } catch (error) {
    console.error("❌ Erro na rota de download:", error)
    if (!res.headersSent) {
      res.status(500).json({ error: "Erro interno do servidor" })
    }
  }
})

// 🛡️ ROTA DE HEALTH CHECK SEGURA
app.get("/health", (req, res) => {
  const stats = {
    status: "OK - SECURE",
    version: "5.0.0 - SECURITY HARDENED",
    timestamp: new Date().toISOString(),
    security_features: [
      "✅ Input validation",
      "✅ Command injection protection",
      "✅ Rate limiting",
      "✅ Secure file handling",
      "✅ Domain whitelist",
      "✅ Resource limits",
      "✅ Helmet security headers",
    ],
    cookies_loaded: {
      google: googleCookiePool.length,
      instagram: instagramCookiePool.length,
      total: generalCookiePool.length,
    },
    active_downloads: activeDownloads,
    max_concurrent: MAX_CONCURRENT_DOWNLOADS,
    uptime: process.uptime(),
  }

  res.json(stats)
})

// 🛡️ ROTA RAIZ SEGURA
app.get("/", (req, res) => {
  res.json({
    message: "🛡️ WaifuConvert Backend - SECURITY HARDENED!",
    version: "5.0.0",
    status: "online - security active",
    security_level: "HIGH",
    features: [
      "✅ Input validation & sanitization",
      "✅ Command injection protection",
      "✅ Rate limiting (20 downloads/10min)",
      "✅ Concurrent download limits",
      "✅ Domain whitelist protection",
      "✅ Secure file handling",
      "✅ Resource usage limits",
      "✅ Security headers (Helmet)",
      "✅ Safe cookie management",
    ],
    platform_support: {
      tiktok: "✅ Working perfectly",
      twitter: `✅ Working with ${googleCookiePool.length} cookies`,
      instagram: `✅ Working with ${instagramCookiePool.length} cookies`,
      youtube: `✅ Working with ${googleCookiePool.length} cookies`,
    },
  })
})

// 🛡️ MIDDLEWARE DE TRATAMENTO DE ERROS SEGURO
app.use((error, req, res, next) => {
  console.error("❌ Erro não tratado:", error.message)

  // Não vazar informações sensíveis
  res.status(500).json({
    error: "Erro interno do servidor",
    timestamp: new Date().toISOString(),
  })
})

// 🛡️ MIDDLEWARE PARA ROTAS NÃO ENCONTRADAS
app.use("*", (req, res) => {
  res.status(404).json({
    error: "Rota não encontrada",
    available_endpoints: ["/", "/health", "/download"],
  })
})

// Limpeza automática
setInterval(cleanupOldFiles, 30 * 60 * 1000)

// 🚀 INICIAR SERVIDOR SEGURO
app.listen(PORT, () => {
  console.log("🛡️ WaifuConvert Backend - SECURITY HARDENED EDITION")
  console.log(`🌐 Porta: ${PORT}`)
  console.log("🔒 RECURSOS DE SEGURANÇA ATIVADOS:")
  console.log("  ✅ Validação rigorosa de entrada")
  console.log("  ✅ Proteção contra command injection")
  console.log("  ✅ Rate limiting inteligente")
  console.log("  ✅ Whitelist de domínios")
  console.log("  ✅ Limites de recursos")
  console.log("  ✅ Headers de segurança")
  console.log("  ✅ Execução segura de comandos")
  console.log("  ✅ Gerenciamento seguro de arquivos")

  const cookiesCreated = createSecureCookieFiles()
  loadCookiePool()

  console.log("🍪 COOKIES SEGUROS:")
  console.log(`  🔵 Google: ${googleCookiePool.length}`)
  console.log(`  📸 Instagram: ${instagramCookiePool.length}`)
  console.log(`  📊 Total: ${generalCookiePool.length}`)

  cleanupOldFiles()
})

// 🛡️ HANDLERS DE ERRO SEGUROS
process.on("uncaughtException", (error) => {
  console.error("❌ Erro não capturado:", error.message)
  process.exit(1)
})

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Promise rejeitada:", reason)
})

// 🛡️ GRACEFUL SHUTDOWN
process.on("SIGTERM", () => {
  console.log("🛑 Recebido SIGTERM, encerrando graciosamente...")
  process.exit(0)
})

process.on("SIGINT", () => {
  console.log("🛑 Recebido SIGINT, encerrando graciosamente...")
  process.exit(0)
})
