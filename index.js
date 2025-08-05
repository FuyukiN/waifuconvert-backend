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

// 🛡️ CONFIGURAÇÕES PREPARADAS PARA O BOOM
const PORT = process.env.PORT || 8080
const MAX_CONCURRENT_DOWNLOADS = 12 // ⬆️ AUMENTADO DE 8 PARA 12
const MAX_FILE_SIZE = 1024 * 1024 * 1024 // 1GB
const MAX_DURATION = 7200 // 🕐 2 HORAS PARA TUDO (MP3/MP4, qualquer qualidade)

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

// 🛡️ CONTADOR DE DOWNLOADS ATIVOS - CORRIGIDO
let activeDownloads = 0

// 🔄 SISTEMA DE ROTAÇÃO DE COOKIES
const cookieUsageCount = new Map()
const lastUsedCookie = new Map()
const consecutiveFailures = new Map()

// 🚨 SISTEMA DE ALERTAS COM TIMEOUT - CORRIGIDO PARA 24H
let lastAlertTime = 0
const ALERT_COOLDOWN = 24 * 60 * 60 * 1000 // 24 horas em vez de 30 segundos

// 📊 SISTEMA DE ESTATÍSTICAS
const downloadStats = {
  total: 0,
  successful: 0,
  failed: 0,
  byPlatform: {},
  byHour: {},
  errors: [],
}

// 🐦 COOKIES ESSENCIAIS PARA TWITTER NSFW
const TWITTER_ESSENTIAL_COOKIES = [
  "auth_token", // ⭐⭐⭐ CRÍTICO - Token de autenticação principal
  "ct0", // ⭐⭐⭐ CRÍTICO - CSRF token
  "twid", // ⭐⭐ IMPORTANTE - Twitter ID
  "att", // ⭐⭐ IMPORTANTE - Authentication token
  "personalization_id", // ⭐ ÚTIL - Configurações de conta
]

// 🕐 FUNÇÃO SIMPLES PARA VERIFICAR DURAÇÃO
function checkDuration(duration) {
  if (!duration || duration <= 0) {
    return { allowed: true, message: null }
  }

  const durationSeconds = typeof duration === "string" ? parseDurationString(duration) : duration

  if (durationSeconds > MAX_DURATION) {
    const durationFormatted = formatDuration(durationSeconds)
    const maxFormatted = formatDuration(MAX_DURATION)

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

  const parts = durationStr.toString().split(":").reverse()
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

// 📊 FUNÇÃO PARA REGISTRAR ESTATÍSTICAS
function recordDownloadStat(platform, success, error = null) {
  downloadStats.total++

  if (success) {
    downloadStats.successful++
  } else {
    downloadStats.failed++
    if (error) {
      downloadStats.errors.push({
        timestamp: new Date().toISOString(),
        platform,
        error: error.substring(0, 100),
      })
      // Manter apenas últimos 50 erros
      if (downloadStats.errors.length > 50) {
        downloadStats.errors = downloadStats.errors.slice(-50)
      }
    }
  }

  // Por plataforma
  if (!downloadStats.byPlatform[platform]) {
    downloadStats.byPlatform[platform] = { total: 0, successful: 0, failed: 0 }
  }
  downloadStats.byPlatform[platform].total++
  if (success) {
    downloadStats.byPlatform[platform].successful++
  } else {
    downloadStats.byPlatform[platform].failed++
  }

  // Por hora
  const currentHour = new Date().getHours()
  downloadStats.byHour[currentHour] = (downloadStats.byHour[currentHour] || 0) + 1
}

// 🚨 SISTEMA DE ALERTAS COM COOLDOWN DE 24H - CORRIGIDO
function checkAlerts() {
  const now = Date.now()
  const alerts = []

  // 🚨 Carga alta
  const loadPercentage = activeDownloads / MAX_CONCURRENT_DOWNLOADS
  if (loadPercentage >= 0.8) {
    alerts.push(`🚨 CARGA ALTA: ${Math.round(loadPercentage * 100)}% da capacidade`)
  }

  // 🚨 Taxa de erro alta
  if (downloadStats.total > 10) {
    const errorRate = downloadStats.failed / downloadStats.total
    if (errorRate >= 0.3) {
      alerts.push(`🚨 TAXA DE ERRO ALTA: ${Math.round(errorRate * 100)}%`)
    }
  }

  // 🚨 Cookies esgotados - APENAS SE PASSOU 24H DESDE O ÚLTIMO ALERTA
  if (now - lastAlertTime > ALERT_COOLDOWN) {
    if (twitterCookiePool.length === 0) {
      alerts.push("🚨 SEM COOKIES TWITTER - NSFW INDISPONÍVEL")
    }

    if (googleCookiePool.length === 0) {
      alerts.push("🚨 SEM COOKIES GOOGLE - YOUTUBE COMPROMETIDO")
    }

    // Se houve alertas de cookies, atualizar timestamp
    if (alerts.some((alert) => alert.includes("SEM COOKIES"))) {
      lastAlertTime = now
    }
  }

  if (alerts.length > 0) {
    console.log("🚨 === ALERTAS CRÍTICOS ===")
    alerts.forEach((alert) => console.log(alert))
    console.log("🚨 ========================")
  }

  return alerts
}

// 🔍 FUNÇÃO PARA VALIDAR FORMATO DE COOKIES
function validateCookieFormat(cookieContent, filename) {
  if (!cookieContent || cookieContent.length < 10) {
    return { valid: false, reason: "Cookie muito pequeno ou vazio" }
  }

  const lines = cookieContent.split("\n")
  let validLines = 0
  let invalidLines = 0
  const issues = []

  lines.forEach((line, index) => {
    line = line.trim()

    // Pular comentários e linhas vazias
    if (!line || line.startsWith("#")) {
      return
    }

    // Formato Netscape: domain \t flag \t path \t secure \t expiration \t name \t value
    const fields = line.split("\t")

    if (fields.length >= 6) {
      validLines++

      // Verificar se o domínio faz sentido
      if (!fields[0].includes(".")) {
        issues.push(`Linha ${index + 1}: Domínio suspeito: ${fields[0]}`)
      }

      // Verificar expiração
      const expiration = Number.parseInt(fields[4])
      if (expiration && expiration < Date.now() / 1000) {
        issues.push(`Linha ${index + 1}: Cookie expirado: ${fields[5]}`)
      }
    } else {
      invalidLines++
      issues.push(`Linha ${index + 1}: Formato inválido (${fields.length} campos, precisa >= 6)`)
    }
  })

  return {
    valid: validLines > 0,
    validLines,
    invalidLines,
    issues,
    reason: validLines === 0 ? "Nenhuma linha válida encontrada" : null,
  }
}

// 🐦 FUNÇÃO PARA VALIDAR COOKIES ESPECÍFICOS DO TWITTER
function validateTwitterCookies(cookieContent) {
  const lines = cookieContent.split("\n")
  const foundCookies = new Set()

  lines.forEach((line) => {
    if (line.trim() && !line.startsWith("#")) {
      const fields = line.split("\t")
      if (fields.length >= 6) {
        const cookieName = fields[5] // Nome do cookie
        foundCookies.add(cookieName)
      }
    }
  })

  const criticalMissing = []
  const importantMissing = []

  // Verificar cookies críticos
  if (!foundCookies.has("auth_token")) criticalMissing.push("auth_token")
  if (!foundCookies.has("ct0")) criticalMissing.push("ct0")

  // Verificar cookies importantes
  if (!foundCookies.has("twid")) importantMissing.push("twid")
  if (!foundCookies.has("att")) importantMissing.push("att")

  return {
    valid: criticalMissing.length === 0,
    criticalMissing,
    importantMissing,
    foundCookies: Array.from(foundCookies),
    nsfwReady: criticalMissing.length === 0,
    recommendation:
      criticalMissing.length === 0 ? "✅ Pronto para NSFW" : "❌ Faltam cookies críticos - faça login novamente",
  }
}

// 🔍 FUNÇÃO PARA DEBUGAR SISTEMA DE COOKIES
function debugCookieSystem() {
  console.log("\n🔍 === DIAGNÓSTICO COMPLETO DE COOKIES ===")

  // Verificar variáveis de ambiente
  console.log("📋 VARIÁVEIS DE AMBIENTE:")
  let envVarsFound = 0

  // Google Cookies - AUMENTADO PARA 15
  for (let i = 1; i <= 15; i++) {
    const envVar = `GOOGLE_COOKIE_${i.toString().padStart(2, "0")}`
    const cookieContent = process.env[envVar]

    if (cookieContent) {
      envVarsFound++
      console.log(`✅ ${envVar}: ${cookieContent.length} caracteres`)

      const validation = validateCookieFormat(cookieContent, envVar)
      if (validation.valid) {
        console.log(`   ✅ Formato: OK (${validation.validLines} linhas válidas)`)
      } else {
        console.log(`   ❌ Formato: ${validation.reason}`)
        validation.issues.slice(0, 3).forEach((issue) => console.log(`   ⚠️ ${issue}`))
      }

      console.log(`   📄 Preview: ${cookieContent.substring(0, 80)}...`)
    }
  }

  // Instagram Cookies
  for (let i = 1; i <= 8; i++) {
    const envVar = `INSTAGRAM_COOKIE_${i.toString().padStart(2, "0")}`
    const cookieContent = process.env[envVar]

    if (cookieContent) {
      envVarsFound++
      console.log(`✅ ${envVar}: ${cookieContent.length} caracteres`)

      const validation = validateCookieFormat(cookieContent, envVar)
      if (validation.valid) {
        console.log(`   ✅ Formato: OK (${validation.validLines} linhas válidas)`)
      } else {
        console.log(`   ❌ Formato: ${validation.reason}`)
      }
    }
  }

  // 🐦 Twitter Cookies - AUMENTADO PARA 10
  for (let i = 1; i <= 10; i++) {
    const envVar = `TWITTER_COOKIE_${i.toString().padStart(2, "0")}`
    const cookieContent = process.env[envVar]

    if (cookieContent) {
      envVarsFound++
      console.log(`✅ ${envVar}: ${cookieContent.length} caracteres`)

      const validation = validateCookieFormat(cookieContent, envVar)
      const twitterValidation = validateTwitterCookies(cookieContent)

      if (validation.valid) {
        console.log(`   ✅ Formato: OK (${validation.validLines} linhas válidas)`)
      } else {
        console.log(`   ❌ Formato: ${validation.reason}`)
      }

      console.log(`   🐦 Twitter: ${twitterValidation.recommendation}`)
      if (twitterValidation.criticalMissing.length > 0) {
        console.log(`   ❌ Faltam críticos: ${twitterValidation.criticalMissing.join(", ")}`)
      }
    }
  }

  console.log(`📊 Total de variáveis encontradas: ${envVarsFound}`)

  // Verificar arquivos criados
  console.log("\n📁 ARQUIVOS DE COOKIE:")
  try {
    if (fs.existsSync(COOKIES_DIR)) {
      const files = fs.readdirSync(COOKIES_DIR).filter((f) => f.endsWith(".txt"))

      if (files.length === 0) {
        console.log("❌ Nenhum arquivo de cookie encontrado")
      } else {
        files.forEach((file) => {
          const filepath = path.join(COOKIES_DIR, file)
          const stats = fs.statSync(filepath)
          const content = fs.readFileSync(filepath, "utf8")
          const validation = validateCookieFormat(content, file)

          console.log(`📄 ${file}:`)
          console.log(`   📏 Tamanho: ${stats.size} bytes`)
          console.log(`   📝 Linhas: ${content.split("\n").length}`)
          console.log(`   ${validation.valid ? "✅" : "❌"} Formato: ${validation.valid ? "OK" : validation.reason}`)

          // 🐦 Validação específica para Twitter
          if (file.startsWith("twitter_")) {
            const twitterValidation = validateTwitterCookies(content)
            console.log(`   🐦 NSFW: ${twitterValidation.nsfwReady ? "✅ PRONTO" : "❌ FALTAM COOKIES"}`)
          }

          if (validation.issues.length > 0) {
            console.log(`   ⚠️ Problemas: ${validation.issues.length}`)
          }
        })
      }
    } else {
      console.log("❌ Diretório de cookies não existe")
    }
  } catch (error) {
    console.error("❌ Erro ao ler cookies:", error.message)
  }

  // Verificar pools
  console.log("\n🍪 POOLS DE COOKIES:")
  console.log(`🔵 Google Pool: ${googleCookiePool.length} arquivos`)
  console.log(`📸 Instagram Pool: ${instagramCookiePool.length} arquivos`)
  console.log(`🐦 Twitter Pool: ${twitterCookiePool.length} arquivos`)
  console.log(`📊 General Pool: ${generalCookiePool.length} arquivos`)

  if (googleCookiePool.length === 0 && instagramCookiePool.length === 0 && twitterCookiePool.length === 0) {
    console.log("❌ NENHUM COOKIE CARREGADO!")
    console.log("💡 Verifique se as variáveis de ambiente estão corretas")
  }

  console.log("🔍 === FIM DO DIAGNÓSTICO ===\n")
}

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

// 🛡️ RATE LIMITING PREPARADO PARA O BOOM
const downloadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30, // ⬆️ AUMENTADO DE 20 PARA 30
  message: {
    error: "Muitas tentativas de download. Tente novamente em alguns minutos.",
    type: "rate_limit_exceeded",
  },
  standardHeaders: true,
  legacyHeaders: false,
})

const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100, // ⬆️ AUMENTADO DE 60 PARA 100
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
      console.warn(`🚫 Domínio não permitido: ${hostname}`)
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
      console.warn(`🚫 IP privado/local bloqueado: ${hostname}`)
      return false
    }

    return true
  } catch (error) {
    console.error("❌ Erro na validação de URL:", error.message)
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

// 🛡️ VALIDAÇÃO MAIS AMIGÁVEL - CORRIGIDA COM 144P
function validateDownloadParams(url, format, quality) {
  const errors = []

  if (!url || typeof url !== "string") {
    errors.push("Por favor, cole um link válido")
  } else if (!isValidUrl(url)) {
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
    } else if (format === "mp4" && ![144, 360, 480, 720, 1080].includes(q)) {
      // ✅ ADICIONADO 144P
      errors.push("Qualidade de vídeo deve ser 144p, 360p, 480p, 720p ou 1080p")
    }
  }

  return errors
}

function executeSecureCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || 600000

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

    const timeoutId = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error("Comando excedeu tempo limite"))
    }, timeout)

    child.on("close", () => {
      clearTimeout(timeoutId)
    })
  })
}

const ytDlpPath = "yt-dlp"

// 🌐 USER AGENTS EXPANDIDOS - ADICIONADOS MAIS 3
const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/131.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  // 🆕 NOVOS USER AGENTS ADICIONADOS
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
]

// 🔍 VERSÃO MELHORADA COM DEBUG da função createSecureCookieFiles
function createSecureCookieFiles() {
  console.log("🛡️ Criando arquivos de cookie seguros...")

  if (!fs.existsSync(COOKIES_DIR)) {
    fs.mkdirSync(COOKIES_DIR, { recursive: true, mode: 0o700 })
  }

  let cookiesCreated = 0

  // Google Cookies - AUMENTADO PARA 15
  for (let i = 1; i <= 15; i++) {
    const envVar = `GOOGLE_COOKIE_${i.toString().padStart(2, "0")}`
    const cookieContent = process.env[envVar]

    if (cookieContent) {
      console.log(`🔍 Processando ${envVar}: ${cookieContent.length} caracteres`)

      const filename = `google_conta${i.toString().padStart(2, "0")}.txt`
      const filepath = path.join(COOKIES_DIR, filename)

      if (cookieContent.length > 10 && cookieContent.includes("=")) {
        // 🔍 VALIDAR FORMATO ANTES DE SALVAR
        const validation = validateCookieFormat(cookieContent, filename)

        fs.writeFileSync(filepath, cookieContent, { mode: 0o600 })
        console.log(`✅ Cookie Google ${i} criado: ${filename}`)

        if (validation.valid) {
          console.log(`   ✅ Formato válido: ${validation.validLines} linhas`)
        } else {
          console.log(`   ⚠️ Formato suspeito: ${validation.reason}`)
        }

        cookiesCreated++
      } else {
        console.log(`❌ Cookie ${envVar} muito pequeno ou sem '=': ${cookieContent.length} chars`)
      }
    }
  }

  // Instagram Cookies
  for (let i = 1; i <= 8; i++) {
    const envVar = `INSTAGRAM_COOKIE_${i.toString().padStart(2, "0")}`
    const cookieContent = process.env[envVar]

    if (cookieContent) {
      console.log(`🔍 Processando ${envVar}: ${cookieContent.length} caracteres`)

      const filename = `instagram_conta${i.toString().padStart(2, "0")}.txt`
      const filepath = path.join(COOKIES_DIR, filename)

      if (cookieContent.length > 10 && cookieContent.includes("=")) {
        const validation = validateCookieFormat(cookieContent, filename)

        fs.writeFileSync(filepath, cookieContent, { mode: 0o600 })
        console.log(`✅ Cookie Instagram ${i} criado: ${filename}`)

        if (validation.valid) {
          console.log(`   ✅ Formato válido: ${validation.validLines} linhas`)
        } else {
          console.log(`   ⚠️ Formato suspeito: ${validation.reason}`)
        }

        cookiesCreated++
      } else {
        console.log(`❌ Cookie ${envVar} muito pequeno ou sem '=': ${cookieContent.length} chars`)
      }
    }
  }

  // 🐦 Twitter Cookies - AUMENTADO PARA 10!
  for (let i = 1; i <= 10; i++) {
    const envVar = `TWITTER_COOKIE_${i.toString().padStart(2, "0")}`
    const cookieContent = process.env[envVar]

    if (cookieContent) {
      console.log(`🔍 Processando ${envVar}: ${cookieContent.length} caracteres`)

      const filename = `twitter_conta${i.toString().padStart(2, "0")}.txt`
      const filepath = path.join(COOKIES_DIR, filename)

      if (cookieContent.length > 10 && cookieContent.includes("=")) {
        const validation = validateCookieFormat(cookieContent, filename)
        const twitterValidation = validateTwitterCookies(cookieContent)

        fs.writeFileSync(filepath, cookieContent, { mode: 0o600 })
        console.log(`✅ Cookie Twitter ${i} criado: ${filename}`)

        if (validation.valid) {
          console.log(`   ✅ Formato válido: ${validation.validLines} linhas`)
        } else {
          console.log(`   ⚠️ Formato suspeito: ${validation.reason}`)
        }

        // 🐦 Validação específica do Twitter
        console.log(`   🐦 ${twitterValidation.recommendation}`)
        if (twitterValidation.nsfwReady) {
          console.log(`   🔞 NSFW habilitado - cookies críticos presentes`)
        } else {
          console.log(`   ❌ NSFW não disponível - faltam: ${twitterValidation.criticalMissing.join(", ")}`)
        }

        cookiesCreated++
      } else {
        console.log(`❌ Cookie ${envVar} muito pequeno ou sem '=': ${cookieContent.length} chars`)
      }
    }
  }

  console.log(`🎯 Total de cookies criados: ${cookiesCreated}`)

  // 🔍 EXECUTAR DIAGNÓSTICO COMPLETO APÓS 2 SEGUNDOS
  setTimeout(() => {
    debugCookieSystem()
  }, 2000)

  return cookiesCreated
}

let googleCookiePool = []
let instagramCookiePool = []
let twitterCookiePool = [] // 🐦 POOL TWITTER
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
    twitterCookiePool = files.filter((f) => f.startsWith("twitter_")).map((f) => path.join(COOKIES_DIR, f)) // 🐦
    generalCookiePool = files.map((file) => path.join(COOKIES_DIR, file))

    console.log(`🔵 Google cookies: ${googleCookiePool.length}`)
    console.log(`📸 Instagram cookies: ${instagramCookiePool.length}`)
    console.log(`🐦 Twitter cookies: ${twitterCookiePool.length}`) // 🐦
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

// 🔄 FUNÇÃO PARA ROTACIONAR COOKIES INTELIGENTEMENTE
function getSmartCookieWithRotation(platform) {
  let pool = []
  let poolName = ""

  switch (platform.toLowerCase()) {
    case "youtube":
    case "reddit":
      pool = googleCookiePool
      poolName = "Google"
      break
    case "twitter":
    case "x":
      // 🐦 PRIORIZAR COOKIES ESPECÍFICOS DO TWITTER
      pool = twitterCookiePool.length > 0 ? twitterCookiePool : googleCookiePool
      poolName = twitterCookiePool.length > 0 ? "Twitter" : "Google (fallback)"
      break
    case "instagram":
      pool = instagramCookiePool
      poolName = "Instagram"
      break
    default:
      pool = generalCookiePool
      poolName = "General"
  }

  if (pool.length === 0) {
    console.log(`🍪 Nenhum cookie ${poolName} disponível para ${platform}`)
    return null
  }

  // 🔄 ROTAÇÃO INTELIGENTE - EVITAR SOBRECARGA
  const now = Date.now()
  const availableCookies = pool.filter((cookie) => {
    const lastUsed = lastUsedCookie.get(cookie) || 0
    const usageCount = cookieUsageCount.get(cookie) || 0
    const failures = consecutiveFailures.get(cookie) || 0

    // Evitar cookies com muitas falhas
    if (failures >= 3) {
      return false
    }

    // Evitar cookies muito usados recentemente
    const timeSinceLastUse = now - lastUsed
    const cooldownTime = Math.min(60000, usageCount * 5000) // Max 1 min cooldown

    return timeSinceLastUse > cooldownTime
  })

  let selected
  if (availableCookies.length > 0) {
    // Usar cookie menos usado
    selected = availableCookies.reduce((least, current) => {
      const leastUsage = cookieUsageCount.get(least) || 0
      const currentUsage = cookieUsageCount.get(current) || 0
      return currentUsage < leastUsage ? current : least
    })
  } else {
    // Fallback para qualquer cookie se todos estão em cooldown
    selected = pool[Math.floor(Math.random() * pool.length)]
  }

  // Atualizar contadores
  cookieUsageCount.set(selected, (cookieUsageCount.get(selected) || 0) + 1)
  lastUsedCookie.set(selected, now)

  console.log(`🍪 Cookie selecionado para ${platform}: ${path.basename(selected)} (pool: ${poolName})`)
  console.log(`   📊 Uso: ${cookieUsageCount.get(selected)} vezes`)

  // 🐦 Log especial para Twitter
  if (platform === "twitter" && poolName === "Twitter") {
    console.log(`   🔞 Cookie Twitter específico - NSFW habilitado`)
  }

  return selected
}

// Manter função original para compatibilidade
function getSmartCookie(platform) {
  return getSmartCookieWithRotation(platform)
}

function getRandomFromPool(pool) {
  if (pool.length === 0) return null
  return pool[Math.floor(Math.random() * pool.length)]
}

function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)]
}

// 🎯 SELETOR DE FORMATO CORRIGIDO COM 144P
function getFormatSelector(format, quality, platform) {
  if (format === "mp3") {
    return "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/best"
  }

  const q = Number.parseInt(quality)

  if (platform === "tiktok") {
    if (q >= 1080) return "best[height<=1080][ext=mp4]/best[height<=1080]/best[ext=mp4]/best"
    if (q >= 720) return "best[height<=720][ext=mp4]/best[height<=720]/best[ext=mp4]/best"
    if (q >= 480) return "best[height<=480][ext=mp4]/best[height<=480]/best[ext=mp4]/best"
    if (q >= 360) return "best[height<=360][ext=mp4]/best[height<=360]/best[ext=mp4]/best"
    return "best[height<=144][ext=mp4]/best[height<=144]/best[ext=mp4]/best"
  }

  if (platform === "instagram") {
    if (q >= 1080) return "best[height<=1080][ext=mp4]/best[height<=1080]/best[ext=mp4]/best"
    if (q >= 720) return "best[height<=720][ext=mp4]/best[height<=720]/best[ext=mp4]/best"
    if (q >= 480) return "best[height<=480][ext=mp4]/best[height<=480]/best[ext=mp4]/best"
    if (q >= 360) return "best[height<=360][ext=mp4]/best[height<=360]/best[ext=mp4]/best"
    return "best[height<=144][ext=mp4]/best[height<=144]/best[ext=mp4]/best"
  }

  // YouTube, Twitter e outras plataformas - ADICIONADO 144P
  if (q >= 1080) {
    return "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080][ext=mp4]/best[height<=1080]/best[ext=mp4]/best"
  } else if (q >= 720) {
    return "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720][ext=mp4]/best[height<=720]/best[ext=mp4]/best"
  } else if (q >= 480) {
    return "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480][ext=mp4]/best[height<=480]/best[ext=mp4]/best"
  } else if (q >= 360) {
    return "bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=360]+bestaudio/best[height<=360][ext=mp4]/best[height<=360]/best[ext=mp4]/best"
  } else {
    // ✅ ADICIONADO SUPORTE PARA 144P
    return "bestvideo[height<=144][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=144]+bestaudio/best[height<=144][ext=mp4]/best[height<=144]/best[ext=mp4]/best"
  }
}

// 🔧 COMANDO SEGURO MELHORADO PARA TWITTER NSFW - CORRIGIDO
function buildSecureCommand(userAgent, cookieFile, platform) {
  const baseArgs = [
    "--user-agent",
    userAgent,
    "--no-playlist",
    "--no-check-certificates",
    "--prefer-insecure",
    "--extractor-retries",
    "5", // ⬆️ AUMENTADO DE 3 PARA 5
    "--fragment-retries",
    "5", // ⬆️ AUMENTADO DE 3 PARA 5
    "--retry-sleep",
    "2", // ⬆️ AUMENTADO DE 1 PARA 2
    "--no-call-home",
    "--geo-bypass",
    "--ignore-errors", // 🔧 IGNORAR ERROS NÃO CRÍTICOS
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

  // 🐦 CONFIGURAÇÕES ESPECÍFICAS PARA TWITTER NSFW - MELHORADAS
  if (platform === "twitter") {
    baseArgs.push(
      "--sleep-interval",
      "2", // ⬆️ AUMENTADO DE 1 PARA 2
      "--max-sleep-interval",
      "5", // ⬆️ AUMENTADO DE 3 PARA 5
      "--extractor-retries",
      "8", // ⬆️ AUMENTADO DE 5 PARA 8
      "--fragment-retries",
      "8", // ⬆️ AUMENTADO DE 5 PARA 8
      "--retry-sleep",
      "3", // ⬆️ AUMENTADO DE 2 PARA 3
      // 🔧 HEADERS ESPECÍFICOS PARA TWITTER
      "--add-header",
      "Referer:https://twitter.com/",
      "--add-header",
      "Origin:https://twitter.com",
      "--add-header",
      "Sec-Fetch-Site:same-origin",
      "--add-header",
      "Sec-Fetch-Mode:cors",
      "--add-header",
      "Sec-Fetch-Dest:empty",
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
    "Could not authenticate you", // 🔧 ADICIONADO ERRO ESPECÍFICO DO TWITTER
    "authentication failed", // 🔧 ADICIONADO
    "unauthorized", // 🔧 ADICIONADO
  ]

  return authErrors.some((error) => errorMessage.toLowerCase().includes(error.toLowerCase()))
}

// 🔧 FUNÇÃO PARA DETECTAR ERROS NÃO CRÍTICOS
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

if (!fs.existsSync(DOWNLOADS)) {
  fs.mkdirSync(DOWNLOADS, { recursive: true, mode: 0o755 })
}

if (!fs.existsSync(COOKIES_DIR)) {
  fs.mkdirSync(COOKIES_DIR, { recursive: true, mode: 0o700 })
}

// 🛡️ ROTA PRINCIPAL CORRIGIDA - CONTADOR E ERROS FIXADOS + DEBUG DE COOKIES + TWITTER + ROTAÇÃO
app.post("/download", async (req, res) => {
  const startTime = Date.now()
  let downloadStarted = false // 🔧 FLAG PARA CONTROLAR CONTADOR
  let cookieUsed = null

  try {
    if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
      return res.status(429).json({
        error: "Servidor ocupado no momento. Tente novamente em 1-2 minutos.",
        type: "server_busy",
        tip: "Muitas pessoas estão usando o serviço agora. 😊",
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

    // 🔧 INCREMENTAR CONTADOR APENAS APÓS VALIDAÇÃO
    activeDownloads++
    downloadStarted = true
    console.log(`🚀 Downloads ativos: ${activeDownloads}/${MAX_CONCURRENT_DOWNLOADS}`)

    const detectedPlatform = detectPlatform(url)
    cookieUsed = getSmartCookieWithRotation(detectedPlatform) // 🔄 COM ROTAÇÃO!
    const randomUA = getRandomUserAgent()
    const uniqueId = crypto.randomBytes(8).toString("hex")

    // 🔍 LOG DETALHADO DE COOKIE
    console.log("🍪 Informações de cookie:", {
      platform: detectedPlatform,
      cookieFile: cookieUsed ? path.basename(cookieUsed) : "NENHUM",
      cookieExists: cookieUsed ? fs.existsSync(cookieUsed) : false,
      cookieSize: cookieUsed && fs.existsSync(cookieUsed) ? fs.statSync(cookieUsed).size : 0,
    })

    console.log("🎯 Nova requisição segura:", {
      url: url.substring(0, 50) + "...",
      format,
      quality,
      platform: detectedPlatform,
    })

    const jsonArgs = [...buildSecureCommand(randomUA, cookieUsed, detectedPlatform), "-j", url]

    try {
      const { stdout: jsonStdout, stderr: jsonStderr } = await executeSecureCommand(ytDlpPath, jsonArgs, {
        timeout: 60000, // ⬆️ AUMENTADO DE 45s PARA 60s PARA TWITTER
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

      const durationCheck = checkDuration(data.duration)
      if (!durationCheck.allowed) {
        console.log("🚫 Vídeo rejeitado por duração:", durationCheck.message)
        return res.status(400).json({
          error: durationCheck.message,
          type: "duration_exceeded",
          video_duration: durationCheck.duration_formatted,
          max_duration: durationCheck.max_duration,
          suggestion: "Tente um vídeo mais curto (máximo 2 horas para qualquer formato)",
        })
      }

      if (data.filesize && data.filesize > MAX_FILE_SIZE) {
        return res.status(400).json({
          error: "Arquivo muito grande. Máximo permitido: 1GB",
          type: "file_too_large",
        })
      }

      const safeTitle = generateSecureFilename(data.title, quality, format, uniqueId)
      const outputPath = path.join(DOWNLOADS, safeTitle)

      console.log("📁 Arquivo aprovado:", {
        title: data.title.substring(0, 30) + "...",
        duration: durationCheck.duration_formatted || "N/A",
        filename: safeTitle,
      })

      let downloadArgs
      if (format === "mp3") {
        const q = Number.parseInt(quality || "128")
        const formatSelector = getFormatSelector("mp3", quality, detectedPlatform)
        downloadArgs = [
          ...buildSecureCommand(randomUA, cookieUsed, detectedPlatform),
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
            ...buildSecureCommand(randomUA, cookieUsed, detectedPlatform),
            "-f",
            formatSelector,
            "--add-metadata",
            "-o",
            outputPath,
            url,
          ]
        } else {
          // 🔧 YOUTUBE, TWITTER E OUTRAS - SEM AUTO-SUBS PARA EVITAR RATE LIMIT
          downloadArgs = [
            ...buildSecureCommand(randomUA, cookieUsed, detectedPlatform),
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

      console.log("🚀 Iniciando download seguro...")

      const { stdout: downloadStdout, stderr: downloadStderr } = await executeSecureCommand(ytDlpPath, downloadArgs, {
        timeout: 900000, // ⬆️ AUMENTADO PARA 15 MINUTOS PARA TWITTER NSFW
      })

      // 🔧 VERIFICAR SE HOUVE ERROS NÃO CRÍTICOS
      if (downloadStderr && isNonCriticalError(downloadStderr)) {
        console.log("⚠️ Avisos não críticos ignorados:", downloadStderr.substring(0, 100) + "...")
      }

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

      const downloadKey = `download_${crypto.randomBytes(16).toString("hex")}.${format === "mp3" ? "mp3" : "mp4"}`
      fileMap.set(downloadKey, {
        actualPath: finalFilePath,
        actualFilename: actualFilename,
        userFriendlyName: `${data.title.substring(0, 50)} - ${format === "mp3" ? quality + "kbps" : quality + "p"}.${format === "mp3" ? "mp3" : "mp4"}`,
        size: stats.size,
        created: Date.now(),
      })

      // 📊 REGISTRAR SUCESSO
      recordDownloadStat(detectedPlatform, true)

      // 🔄 RESETAR FALHAS DO COOKIE
      if (cookieUsed) {
        consecutiveFailures.set(cookieUsed, 0)
      }

      console.log("✅ Download seguro concluído:", {
        platform: detectedPlatform,
        downloadKey: downloadKey,
        size: `${(stats.size / 1024 / 1024).toFixed(2)} MB`,
        duration: durationCheck.duration_formatted || "N/A",
        used_cookies: !!cookieUsed,
        cookie_file: cookieUsed ? path.basename(cookieUsed) : "NENHUM",
      })

      res.json({
        file: `/downloads/${downloadKey}`,
        filename: `${data.title.substring(0, 50)} - ${format === "mp3" ? quality + "kbps" : quality + "p"}.${format === "mp3" ? "mp3" : "mp4"}`,
        size: stats.size,
        title: data.title,
        duration: data.duration,
        duration_formatted: durationCheck.duration_formatted,
        platform: detectedPlatform,
        quality_achieved: format === "mp3" ? `${quality}kbps` : `${quality}p`,
        used_cookies: !!cookieUsed,
      })
    } catch (error) {
      console.error("❌ Erro no download:", error.message)

      // 📊 REGISTRAR FALHA
      recordDownloadStat(detectedPlatform, false, error.message)

      // 🔄 INCREMENTAR FALHAS DO COOKIE
      if (cookieUsed) {
        const failures = consecutiveFailures.get(cookieUsed) || 0
        consecutiveFailures.set(cookieUsed, failures + 1)
      }

      // 🔧 VERIFICAR SE É ERRO NÃO CRÍTICO ANTES DE FALHAR
      if (isNonCriticalError(error.message)) {
        console.log("⚠️ Erro não crítico detectado, tentando continuar...")
        // Não retornar erro, deixar continuar
      } else if (isAuthenticationError(error.message)) {
        if (detectedPlatform === "instagram") {
          return res.status(400).json({
            error: "Instagram requer login. Configure cookies via environment variables.",
            type: "instagram_auth_required",
            platform: "instagram",
          })
        } else if (detectedPlatform === "twitter") {
          // 🐦 ERRO ESPECÍFICO PARA TWITTER MELHORADO
          return res.status(400).json({
            error: "Conteúdo NSFW do Twitter requer cookies válidos. Verifique se os cookies não expiraram.",
            type: "twitter_nsfw_required",
            platform: "twitter",
            suggestion: "Renove os cookies do Twitter usando Cookie-Editor com uma conta logada",
            debug_info: {
              cookie_used: cookieUsed ? path.basename(cookieUsed) : "NENHUM",
              error_details: error.message.substring(0, 200),
            },
          })
        }
        return res.status(400).json({
          error: "Conteúdo privado ou requer login.",
          type: "private_content",
        })
      } else {
        return res.status(500).json({ error: "Falha no download/conversão" })
      }
    }
  } catch (error) {
    console.error("❌ Erro inesperado:", error)
    recordDownloadStat("unknown", false, error.message)
    res.status(500).json({ error: "Erro interno do servidor" })
  } finally {
    // 🔧 DECREMENTAR CONTADOR APENAS SE FOI INCREMENTADO
    if (downloadStarted) {
      activeDownloads = Math.max(0, activeDownloads - 1) // 🔧 NUNCA DEIXAR NEGATIVO
      console.log(`📉 Downloads ativos: ${activeDownloads}/${MAX_CONCURRENT_DOWNLOADS}`)
    }
  }
})

// 📊 ROTA DE ESTATÍSTICAS EM TEMPO REAL
app.get("/stats", (req, res) => {
  const currentHour = new Date().getHours()
  const alerts = checkAlerts()

  res.json({
    message: "📊 Estatísticas em Tempo Real - BOOM READY!",
    timestamp: new Date().toISOString(),
    server: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      active_downloads: activeDownloads,
      max_concurrent: MAX_CONCURRENT_DOWNLOADS,
      load_percentage: Math.round((activeDownloads / MAX_CONCURRENT_DOWNLOADS) * 100),
    },
    downloads: {
      total: downloadStats.total,
      successful: downloadStats.successful,
      failed: downloadStats.failed,
      success_rate: downloadStats.total > 0 ? Math.round((downloadStats.successful / downloadStats.total) * 100) : 0,
      current_hour: downloadStats.byHour[currentHour] || 0,
    },
    platforms: downloadStats.byPlatform,
    cookies: {
      google: googleCookiePool.length,
      instagram: instagramCookiePool.length,
      twitter: twitterCookiePool.length,
      total: generalCookiePool.length,
      rotation_stats: {
        total_usage: Array.from(cookieUsageCount.values()).reduce((a, b) => a + b, 0),
        cookies_in_cooldown: Array.from(lastUsedCookie.entries()).filter(
          ([cookie, lastUsed]) => Date.now() - lastUsed < 60000,
        ).length,
        failed_cookies: Array.from(consecutiveFailures.entries()).filter(([cookie, failures]) => failures >= 3).length,
      },
    },
    recent_errors: downloadStats.errors.slice(-5),
    alerts: alerts,
    boom_readiness: {
      concurrent_capacity: `${activeDownloads}/${MAX_CONCURRENT_DOWNLOADS}`,
      rate_limit_capacity: "30 downloads/10min",
      cookie_pools_ready: googleCookiePool.length > 0 && twitterCookiePool.length > 0,
      twitter_nsfw_ready: twitterCookiePool.length > 0,
      user_agents: userAgents.length,
    },
  })
})

// 🔍 ROTA DE TESTE DE COOKIES - ATUALIZADA COM TWITTER E ROTAÇÃO
app.get("/test-cookies", async (req, res) => {
  console.log("🧪 === TESTE DE COOKIES INICIADO ===")

  const results = {
    environment_variables: {},
    cookie_files: {},
    pools: {
      google: googleCookiePool.length,
      instagram: instagramCookiePool.length,
      twitter: twitterCookiePool.length,
      general: generalCookiePool.length,
    },
    rotation_stats: {
      total_usage: Array.from(cookieUsageCount.values()).reduce((a, b) => a + b, 0),
      cookies_tracked: cookieUsageCount.size,
      failed_cookies: Array.from(consecutiveFailures.entries()).filter(([cookie, failures]) => failures >= 3).length,
    },
    tests: {},
    recommendations: [],
  }

  // 1. Verificar variáveis de ambiente
  let envVarsFound = 0

  // Google - AUMENTADO PARA 15
  for (let i = 1; i <= 15; i++) {
    const envVar = `GOOGLE_COOKIE_${i.toString().padStart(2, "0")}`
    const cookieContent = process.env[envVar]

    if (cookieContent) {
      envVarsFound++
      const validation = validateCookieFormat(cookieContent, envVar)

      results.environment_variables[envVar] = {
        exists: true,
        length: cookieContent.length,
        has_equals: cookieContent.includes("="),
        format_valid: validation.valid,
        valid_lines: validation.validLines,
        invalid_lines: validation.invalidLines,
        issues: validation.issues.slice(0, 3),
      }
    } else {
      results.environment_variables[envVar] = { exists: false }
    }
  }

  // Instagram
  for (let i = 1; i <= 8; i++) {
    const envVar = `INSTAGRAM_COOKIE_${i.toString().padStart(2, "0")}`
    const cookieContent = process.env[envVar]

    if (cookieContent) {
      envVarsFound++
      const validation = validateCookieFormat(cookieContent, envVar)

      results.environment_variables[envVar] = {
        exists: true,
        length: cookieContent.length,
        has_equals: cookieContent.includes("="),
        format_valid: validation.valid,
        valid_lines: validation.validLines,
        invalid_lines: validation.invalidLines,
      }
    } else {
      results.environment_variables[envVar] = { exists: false }
    }
  }

  // 🐦 Twitter - AUMENTADO PARA 10
  for (let i = 1; i <= 10; i++) {
    const envVar = `TWITTER_COOKIE_${i.toString().padStart(2, "0")}`
    const cookieContent = process.env[envVar]

    if (cookieContent) {
      envVarsFound++
      const validation = validateCookieFormat(cookieContent, envVar)
      const twitterValidation = validateTwitterCookies(cookieContent)

      results.environment_variables[envVar] = {
        exists: true,
        length: cookieContent.length,
        has_equals: cookieContent.includes("="),
        format_valid: validation.valid,
        valid_lines: validation.validLines,
        invalid_lines: validation.invalidLines,
        twitter_nsfw_ready: twitterValidation.nsfwReady,
        twitter_critical_missing: twitterValidation.criticalMissing,
        twitter_cookies_found: twitterValidation.foundCookies,
      }
    } else {
      results.environment_variables[envVar] = { exists: false }
    }
  }

  // 2. Verificar arquivos criados
  try {
    if (fs.existsSync(COOKIES_DIR)) {
      const files = fs.readdirSync(COOKIES_DIR).filter((f) => f.endsWith(".txt"))

      for (const file of files) {
        const filepath = path.join(COOKIES_DIR, file)
        const stats = fs.statSync(filepath)
        const content = fs.readFileSync(filepath, "utf8")
        const validation = validateCookieFormat(content, file)

        results.cookie_files[file] = {
          size: stats.size,
          lines: content.split("\n").length,
          format_valid: validation.valid,
          valid_lines: validation.validLines,
          invalid_lines: validation.invalidLines,
          issues: validation.issues.slice(0, 2),
          usage_count: cookieUsageCount.get(filepath) || 0,
          consecutive_failures: consecutiveFailures.get(filepath) || 0,
        }

        // 🐦 Validação específica para Twitter
        if (file.startsWith("twitter_")) {
          const twitterValidation = validateTwitterCookies(content)
          results.cookie_files[file].twitter_nsfw_ready = twitterValidation.nsfwReady
          results.cookie_files[file].twitter_critical_missing = twitterValidation.criticalMissing
        }
      }
    }
  } catch (error) {
    results.cookie_files.error = error.message
  }

  // 3. Testar seleção de cookies
  const platforms = ["youtube", "instagram", "twitter"]

  for (const platform of platforms) {
    const selectedCookie = getSmartCookieWithRotation(platform)

    results.tests[platform] = {
      cookie_selected: !!selectedCookie,
      cookie_path: selectedCookie ? path.basename(selectedCookie) : null,
      cookie_exists: selectedCookie ? fs.existsSync(selectedCookie) : false,
    }

    // 🐦 Info específica para Twitter
    if (platform === "twitter" && selectedCookie) {
      const isTwitterSpecific = path.basename(selectedCookie).startsWith("twitter_")
      results.tests[platform].twitter_specific = isTwitterSpecific
      results.tests[platform].nsfw_capable = isTwitterSpecific
    }
  }

  // 4. Gerar recomendações
  if (envVarsFound === 0) {
    results.recommendations.push("❌ Nenhuma variável de ambiente encontrada - configure GOOGLE_COOKIE_01, etc.")
  } else {
    results.recommendations.push(`✅ ${envVarsFound} variáveis de ambiente encontradas`)
  }

  if (results.pools.google === 0 && results.pools.instagram === 0 && results.pools.twitter === 0) {
    results.recommendations.push("❌ Nenhum cookie carregado - verifique formato e variáveis")
  } else {
    results.recommendations.push(
      `✅ ${results.pools.google + results.pools.instagram + results.pools.twitter} cookies carregados`,
    )
  }

  // 🐦 Recomendação específica para Twitter
  if (results.pools.twitter === 0) {
    results.recommendations.push("⚠️ Nenhum cookie Twitter - conteúdo NSFW não disponível")
  } else {
    results.recommendations.push(`🐦 ${results.pools.twitter} cookies Twitter - NSFW habilitado`)
  }

  // 🔄 Recomendações de rotação
  if (results.rotation_stats.failed_cookies > 0) {
    results.recommendations.push(`⚠️ ${results.rotation_stats.failed_cookies} cookies com falhas - considere renovar`)
  }

  const hasFormatIssues = Object.values(results.environment_variables).some((v) => v.exists && !v.format_valid)
  if (hasFormatIssues) {
    results.recommendations.push("⚠️ Alguns cookies têm formato inválido - use formato Netscape do Cookie Editor")
  } else {
    results.recommendations.push("✅ Formato dos cookies OK")
  }

  console.log("🧪 === TESTE DE COOKIES CONCLUÍDO ===")

  res.json({
    message: "🧪 Teste de Cookies Completo - BOOM READY com Rotação!",
    timestamp: new Date().toISOString(),
    summary: {
      env_vars_found: envVarsFound,
      cookies_loaded: results.pools.google + results.pools.instagram + results.pools.twitter,
      files_created: Object.keys(results.cookie_files).length,
      twitter_nsfw_ready: results.pools.twitter > 0,
      rotation_active: results.rotation_stats.cookies_tracked > 0,
    },
    results: results,
  })
})

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

app.get("/health", (req, res) => {
  const alerts = checkAlerts()

  const stats = {
    status: "OK - BOOM READY",
    version: "6.1.0 - BOOM EDITION + COOKIE ROTATION + TWITTER NSFW FIXED",
    timestamp: new Date().toISOString(),
    limits: {
      max_duration: formatDuration(MAX_DURATION),
      max_file_size: "1GB",
      max_concurrent: MAX_CONCURRENT_DOWNLOADS,
    },
    boom_features: [
      "🔄 Smart cookie rotation",
      "📊 Real-time statistics",
      "🚨 Automatic alerts (24h cooldown)",
      "⚡ Increased capacity (12 concurrent)",
      "🌐 8 user agents",
      "🐦 Twitter NSFW support (FIXED)",
      "📈 Performance monitoring",
    ],
    security_features: [
      "✅ Input validation",
      "✅ Command injection protection",
      "✅ Rate limiting (30/10min)",
      "✅ Duration limits (2h max)",
      "✅ Secure file handling",
      "✅ Domain whitelist",
      "✅ Resource limits",
      "✅ Helmet security headers",
      "✅ Counter bug fixed",
      "✅ 144p quality support",
      "✅ Non-critical error handling",
      "✅ Cookie debugging system",
      "✅ Twitter NSFW support (FIXED)",
      "✅ Alert spam prevention (24h cooldown)",
    ],
    cookies_loaded: {
      google: googleCookiePool.length,
      instagram: instagramCookiePool.length,
      twitter: twitterCookiePool.length,
      total: generalCookiePool.length,
    },
    performance: {
      active_downloads: activeDownloads,
      uptime: process.uptime(),
      memory_usage: Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100 + " MB",
      load_percentage: Math.round((activeDownloads / MAX_CONCURRENT_DOWNLOADS) * 100),
    },
    alerts: alerts,
  }

  res.json(stats)
})

app.get("/", (req, res) => {
  res.json({
    message: "🚀 WaifuConvert Backend - BOOM EDITION + COOKIE ROTATION + TWITTER NSFW FIXED!",
    version: "6.1.0",
    status: "online - boom ready",
    security_level: "HIGH",
    boom_readiness: "✅ READY FOR REDDIT TRAFFIC",
    limits: {
      duration: "2 horas máximo (MP3/MP4, qualquer qualidade)",
      file_size: "1GB máximo",
      rate_limit: "30 downloads a cada 10 minutos",
      concurrent: "12 downloads simultâneos",
    },
    quality_support: {
      mp3: "64kbps - 320kbps",
      mp4: "144p, 360p, 480p, 720p, 1080p",
    },
    boom_features: [
      "🔄 Smart cookie rotation with cooldowns",
      "📊 Real-time statistics and monitoring",
      "🚨 Automatic alert system (24h cooldown - NO MORE SPAM!)",
      "⚡ Increased capacity (50% more concurrent)",
      "🌐 8 diverse user agents",
      "🐦 Dedicated Twitter NSFW support (FIXED)",
      "📈 Performance tracking",
      "🛡️ Enhanced security",
    ],
    twitter_features: [
      "🐦 Dedicated Twitter cookie pool (up to 10)",
      "🔞 NSFW content support (FIXED)",
      "🔍 Twitter-specific cookie validation",
      "⚡ Optimized for Twitter rate limits",
      "🛡️ Secure Twitter authentication",
      "🔄 Smart rotation for Twitter cookies",
      "🔧 Enhanced error handling for Twitter auth",
      "⏰ Increased timeouts for Twitter NSFW",
    ],
    debug_features: [
      "🔍 Cookie format validation",
      "🔍 Environment variable checking",
      "🔍 Cookie pool debugging",
      "🔍 Platform-specific cookie selection",
      "🔍 Real-time cookie usage logging",
      "🐦 Twitter NSFW readiness check",
      "🔄 Cookie rotation statistics",
      "📊 Performance monitoring",
    ],
    fixes_applied: [
      "✅ Counter never goes negative",
      "✅ 144p quality support added",
      "✅ Impersonation warnings eliminated",
      "✅ Subtitle rate limit errors ignored",
      "✅ Non-critical error handling",
      "✅ Cookie debugging system",
      "✅ Twitter NSFW support FIXED",
      "✅ Smart cookie rotation implemented",
      "✅ Performance monitoring added",
      "✅ Alert spam prevention (24h cooldown)",
      "✅ Enhanced Twitter authentication",
      "✅ Increased timeouts for Twitter",
    ],
    features: [
      "✅ Input validation & sanitization",
      "✅ Command injection protection",
      "✅ Rate limiting (30 downloads/10min)",
      "✅ Duration limits (2h max for everything)",
      "✅ Concurrent download limits (12 max)",
      "✅ Domain whitelist protection",
      "✅ Secure file handling",
      "✅ Resource usage limits",
      "✅ Security headers (Helmet)",
      "✅ Safe cookie management with rotation",
      "✅ Alert spam prevention",
    ],
    platform_support: {
      tiktok: "✅ Working perfectly",
      twitter: `🐦 Working with ${twitterCookiePool.length} dedicated cookies + ${googleCookiePool.length} fallback + NSFW support (FIXED)`,
      instagram: `✅ Working with ${instagramCookiePool.length} cookies`,
      youtube: `✅ Working with ${googleCookiePool.length} cookies`,
    },
    debug_endpoints: [
      "GET /test-cookies - Diagnóstico completo de cookies (incluindo rotação)",
      "GET /health - Status do sistema",
      "GET /stats - Estatísticas em tempo real",
    ],
  })
})

app.use((error, req, res, next) => {
  console.error("❌ Erro não tratado:", error.message)
  res.status(500).json({
    error: "Erro interno do servidor",
    timestamp: new Date().toISOString(),
  })
})

app.use("*", (req, res) => {
  res.status(404).json({
    error: "Rota não encontrada",
    available_endpoints: ["/", "/health", "/download", "/test-cookies", "/stats"],
  })
})

// 🔄 RESETAR CONTADORES DE ROTAÇÃO A CADA HORA
setInterval(
  () => {
    console.log("🔄 Resetando contadores de uso de cookies...")
    cookieUsageCount.clear()
    lastUsedCookie.clear()
    // Manter falhas por mais tempo para evitar cookies problemáticos
  },
  60 * 60 * 1000,
) // 1 hora

// 🚨 VERIFICAR ALERTAS A CADA 5 MINUTOS (EM VEZ DE 30 SEGUNDOS) - MAS COM COOLDOWN DE 24H
setInterval(checkAlerts, 5 * 60 * 1000) // 5 minutos

setInterval(cleanupOldFiles, 30 * 60 * 1000)

app.listen(PORT, () => {
  console.log("🚀 WaifuConvert Backend - BOOM EDITION + COOKIE ROTATION + TWITTER NSFW FIXED")
  console.log(`🌐 Porta: ${PORT}`)
  console.log("🔒 RECURSOS DE SEGURANÇA ATIVADOS:")
  console.log("  ✅ Validação rigorosa de entrada")
  console.log("  ✅ Proteção contra command injection")
  console.log("  ✅ Rate limiting inteligente (30/10min)")
  console.log("  ✅ Limite de duração: 2 horas para tudo")
  console.log("  ✅ Contador de downloads corrigido")
  console.log("  ✅ Suporte a 144p adicionado")
  console.log("  ✅ Tratamento de erros não críticos")
  console.log("  ✅ Sistema de debug de cookies")
  console.log("  🐦 Suporte completo ao Twitter NSFW (CORRIGIDO)")
  console.log("  🔄 Rotação inteligente de cookies")
  console.log("  📊 Monitoramento em tempo real")
  console.log("  🚨 Sistema de alertas com cooldown de 24h (SEM SPAM)")
  console.log("  ✅ Whitelist de domínios")
  console.log("  ✅ Limites de recursos")
  console.log("  ✅ Headers de segurança")
  console.log("  ✅ Execução segura de comandos")
  console.log("  ✅ Gerenciamento seguro de arquivos")

  const cookiesCreated = createSecureCookieFiles()
  loadCookiePool()

  console.log("🍪 COOKIES SEGUROS:")
  console.log(`  🔵 Google: ${googleCookiePool.length} (até 15 suportados)`)
  console.log(`  📸 Instagram: ${instagramCookiePool.length} (até 8 suportados)`)
  console.log(`  🐦 Twitter: ${twitterCookiePool.length} (até 10 suportados)`)
  console.log(`  📊 Total: ${generalCookiePool.length}`)

  console.log("🕐 LIMITES DE DURAÇÃO:")
  console.log(`  📹 Qualquer formato: máximo ${formatDuration(MAX_DURATION)}`)
  console.log(`  📁 Tamanho máximo: 1GB`)

  console.log("🎯 QUALIDADES SUPORTADAS:")
  console.log("  🎵 MP3: 64kbps - 320kbps")
  console.log("  📹 MP4: 144p, 360p, 480p, 720p, 1080p")

  console.log("🚀 PREPARAÇÃO PARA O BOOM:")
  console.log(`  ⚡ Downloads simultâneos: ${MAX_CONCURRENT_DOWNLOADS} (era 8)`)
  console.log("  📈 Rate limit: 30/10min (era 20/10min)")
  console.log(`  🌐 User agents: ${userAgents.length} (era 5)`)
  console.log("  🔄 Rotação inteligente de cookies")
  console.log("  📊 Monitoramento em tempo real")
  console.log("  🚨 Sistema de alertas (24h cooldown - SEM SPAM)")

  console.log("🐦 RECURSOS TWITTER (CORRIGIDOS):")
  console.log("  🔞 Suporte a conteúdo NSFW (CORRIGIDO)")
  console.log("  🍪 Pool dedicado de cookies")
  console.log("  🔍 Validação específica de cookies")
  console.log("  ⚡ Otimizado para rate limits")
  console.log("  🔄 Rotação inteligente")
  console.log("  🔧 Headers específicos para Twitter")
  console.log("  ⏰ Timeouts aumentados (60s JSON, 15min download)")
  console.log("  🛡️ Melhor tratamento de erros de autenticação")

  console.log("🔍 ENDPOINTS DE DEBUG:")
  console.log("  🧪 /test-cookies - Diagnóstico completo")
  console.log("  ❤️ /health - Status do sistema")
  console.log("  📊 /stats - Estatísticas em tempo real")

  console.log("🔧 CORREÇÕES APLICADAS:")
  console.log("  ✅ Twitter NSFW: Headers específicos adicionados")
  console.log("  ✅ Twitter NSFW: Timeouts aumentados")
  console.log("  ✅ Twitter NSFW: Retry logic melhorado")
  console.log("  ✅ Alertas: Cooldown de 24h implementado")
  console.log("  ✅ Alertas: Verificação a cada 5min (era 30s)")
  console.log("  ✅ Logs: Redução significativa de spam")

  cleanupOldFiles()
})

process.on("uncaughtException", (error) => {
  console.error("❌ Erro não capturado:", error.message)
  process.exit(1)
})

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Promise rejeitada:", reason)
})

process.on("SIGTERM", () => {
  console.log("🛑 Recebido SIGTERM, encerrando graciosamente...")
  process.exit(0)
})

process.on("SIGINT", () => {
  console.log("🛑 Recebido SIGINT, encerrando graciosamente...")
  process.exit(0)
})
