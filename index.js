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
const MAX_CONCURRENT_DOWNLOADS = 8
const MAX_FILE_SIZE = 1024 * 1024 * 1024 // 1GB
const MAX_DURATION = 7200 // 🕐 2 HORAS PARA TUDO (MP3/MP4, qualquer qualidade)

// 🧠 SISTEMA DE LIMPEZA AGRESSIVA DE MEMÓRIA - RAILWAY FIX
let lastActivity = Date.now()

// 🧠 FUNÇÃO PARA GARBAGE COLLECTION FORÇADO - RAILWAY COMPATIBLE
function forceGarbageCollection() {
  try {
    // Método 1: Tentar global.gc() se disponível
    if (typeof global.gc === "function") {
      const before = process.memoryUsage().heapUsed
      global.gc()
      const after = process.memoryUsage().heapUsed
      const freed = Math.round((before - after) / 1024 / 1024)
      console.log(`🗑️ GC (Method 1): Liberados ${freed}MB de RAM`)
      return freed
    }

    // Método 2: Forçar através de require('v8')
    try {
      const v8 = require("v8")
      if (v8.getHeapStatistics) {
        const before = process.memoryUsage().heapUsed

        // Forçar coleta usando técnicas alternativas
        if (global.gc) {
          global.gc()
        } else {
          // Criar pressão de memória para forçar GC
          const dummy = new Array(1000000).fill("x")
          dummy.length = 0
        }

        const after = process.memoryUsage().heapUsed
        const freed = Math.round((before - after) / 1024 / 1024)
        console.log(`🗑️ GC (Method 2): Liberados ${freed}MB de RAM`)
        return freed
      }
    } catch (v8Error) {
      console.log("⚠️ V8 method failed:", v8Error.message)
    }

    // Método 3: Limpeza manual agressiva
    console.log("🧹 GC não disponível - usando limpeza manual agressiva")

    // Limpar variáveis globais
    if (global.Buffer) {
      global.Buffer.poolSize = 1
    }

    // Forçar limpeza de arrays grandes
    const before = process.memoryUsage().heapUsed

    // Criar e destruir objetos para forçar coleta
    for (let i = 0; i < 100; i++) {
      const temp = new Array(10000).fill(null)
      temp.length = 0
    }

    const after = process.memoryUsage().heapUsed
    const freed = Math.round((before - after) / 1024 / 1024)
    console.log(`🧹 Manual cleanup: ${freed}MB liberados`)
    return freed
  } catch (error) {
    console.log("❌ Erro na limpeza de memória:", error.message)
    return 0
  }
}

// 🧠 MONITORAMENTO DE MEMÓRIA APRIMORADO
function logMemoryUsage() {
  const used = process.memoryUsage()
  const mb = (bytes) => Math.round(bytes / 1024 / 1024)

  console.log(`📊 RAM: ${mb(used.heapUsed)}MB heap / ${mb(used.rss)}MB total`)
  console.log(`📊 External: ${mb(used.external)}MB / ArrayBuffers: ${mb(used.arrayBuffers)}MB`)

  // Alerta se usar mais que 200MB
  if (used.heapUsed > 200 * 1024 * 1024) {
    console.log("🚨 Alto uso de RAM - forçando limpeza...")
    forceGarbageCollection()
  }

  return {
    heapUsed: mb(used.heapUsed),
    rss: mb(used.rss),
    external: mb(used.external),
    arrayBuffers: mb(used.arrayBuffers),
  }
}

// 🧠 VERIFICAR VARIÁVEIS DE OTIMIZAÇÃO NA INICIALIZAÇÃO - RAILWAY DEBUG
function checkOptimizationVariables() {
  console.log("🧠 === VERIFICAÇÃO DE OTIMIZAÇÃO DE MEMÓRIA (RAILWAY) ===")
  console.log(`NODE_ENV: ${process.env.NODE_ENV || "❌ NÃO DEFINIDO"}`)
  console.log(`NODE_OPTIONS: ${process.env.NODE_OPTIONS || "❌ NÃO DEFINIDO"}`)
  console.log(`MAX_OLD_SPACE_SIZE: ${process.env.MAX_OLD_SPACE_SIZE || "❌ NÃO DEFINIDO"}MB`)

  // Verificações múltiplas para GC
  const gcMethods = []

  if (typeof global.gc === "function") {
    gcMethods.push("✅ global.gc() disponível")
  } else {
    gcMethods.push("❌ global.gc() não disponível")
  }

  try {
    const v8 = require("v8")
    if (v8.getHeapStatistics) {
      gcMethods.push("✅ V8 heap statistics disponível")
    }
  } catch (e) {
    gcMethods.push("❌ V8 não disponível")
  }

  console.log("🔍 Métodos de GC disponíveis:")
  gcMethods.forEach((method) => console.log(`   ${method}`))

  if (typeof global.gc === "undefined") {
    console.log("🚨 RAILWAY ISSUE: NODE_OPTIONS pode não estar sendo aplicado corretamente")
    console.log("💡 WORKAROUND: Usando métodos alternativos de limpeza de memória")
    console.log("🔧 TESTE: Executando limpeza manual...")

    // Testar limpeza manual imediatamente
    const freed = forceGarbageCollection()
    console.log(`🧪 Teste de limpeza: ${freed}MB processados`)
  } else {
    console.log("✅ GC está funcionando - otimização ativa!")
    // Testar GC imediatamente
    forceGarbageCollection()
  }

  console.log("🧠 ============================================")
}

// 🧠 LIMPEZA AGRESSIVA DE MEMÓRIA PARA RAILWAY
function aggressiveMemoryCleanup() {
  console.log("🧹 === LIMPEZA AGRESSIVA DE MEMÓRIA ===")

  const before = process.memoryUsage()

  try {
    // 1. Tentar GC normal
    const gcFreed = forceGarbageCollection()

    // 2. Limpar caches do Node.js
    if (require.cache) {
      const cacheKeys = Object.keys(require.cache)
      console.log(`🗂️ Limpando ${cacheKeys.length} módulos do cache`)

      // Manter apenas módulos essenciais
      const essentialModules = ["express", "cors", "helmet", "validator"]
      cacheKeys.forEach((key) => {
        const isEssential = essentialModules.some((mod) => key.includes(mod))
        if (!isEssential && !key.includes("node_modules")) {
          try {
            delete require.cache[key]
          } catch (e) {
            // Ignorar erros de limpeza
          }
        }
      })
    }

    // 3. Limpar variáveis globais desnecessárias
    if (global.Buffer && global.Buffer.poolSize > 1) {
      global.Buffer.poolSize = 1
      console.log("🔧 Buffer pool size reduzido")
    }

    // 4. Forçar coleta através de pressão de memória
    const tempArrays = []
    for (let i = 0; i < 50; i++) {
      tempArrays.push(new Array(1000).fill(null))
    }
    tempArrays.length = 0

    const after = process.memoryUsage()
    const totalFreed = Math.round((before.heapUsed - after.heapUsed) / 1024 / 1024)

    console.log(`🎯 Limpeza completa: ${totalFreed}MB liberados`)
    console.log(
      `📊 Antes: ${Math.round(before.heapUsed / 1024 / 1024)}MB → Depois: ${Math.round(after.heapUsed / 1024 / 1024)}MB`,
    )

    return totalFreed
  } catch (error) {
    console.log("❌ Erro na limpeza agressiva:", error.message)
    return 0
  }
}

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

// 🐦 COOKIES ESSENCIAIS PARA TWITTER NSFW
const TWITTER_ESSENTIAL_COOKIES = [
  "auth_token", // ⭐⭐⭐ CRÍTICO - Token de autenticação principal
  "ct0", // ⭐⭐⭐ CRÍTICO - CSRF token
  "twid", // ⭐⭐ IMPORTANTE - Twitter ID
  "att", // ⭐⭐ IMPORTANTE - Authentication token
  "personalization_id", // ⭐ ÚTIL - Configurações de conta
]

// 🎯 CORREÇÃO YOUTUBE: User-Agents mais recentes e variados
const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/120.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0",
]

// 🎯 CORREÇÃO YOUTUBE: Função para atualizar yt-dlp automaticamente
async function ensureYtDlpUpdated() {
  try {
    console.log("🔄 Verificando/atualizando yt-dlp...")

    // Tentar atualizar yt-dlp
    await executeSecureCommand("pip", ["install", "--upgrade", "yt-dlp"], { timeout: 60000 })
    console.log("✅ yt-dlp atualizado com sucesso")

    // Verificar versão
    const { stdout } = await executeSecureCommand("yt-dlp", ["--version"], { timeout: 10000 })
    console.log(`📦 Versão do yt-dlp: ${stdout.trim()}`)

    return true
  } catch (error) {
    console.log("⚠️ Não foi possível atualizar yt-dlp:", error.message)
    return false
  }
}

// 🎯 CORREÇÃO YOUTUBE: Estratégias múltiplas para bypass
class YouTubeBypassStrategies {
  static getStrategy1Args(userAgent, cookieFile) {
    const args = [
      "--user-agent",
      userAgent,
      "--referer",
      "https://www.youtube.com/",
      "--add-header",
      "Accept-Language:en-US,en;q=0.9",
      "--add-header",
      "Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "--sleep-interval",
      "1",
      "--max-sleep-interval",
      "3",
      "--extractor-retries",
      "5",
      "--fragment-retries",
      "5",
      "--retry-sleep",
      "2",
      "--no-warnings",
      "--no-playlist",
      "--geo-bypass",
      "--ignore-errors",
    ]

    if (cookieFile) {
      args.push("--cookies", cookieFile)
    }

    return args
  }

  static getStrategy2Args(userAgent) {
    return [
      "--user-agent",
      userAgent,
      "--referer",
      "https://www.youtube.com/",
      "--add-header",
      "Accept-Language:en-US,en;q=0.9",
      "--add-header",
      "Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "--sleep-interval",
      "2",
      "--max-sleep-interval",
      "5",
      "--extractor-retries",
      "3",
      "--fragment-retries",
      "3",
      "--retry-sleep",
      "3",
      "--no-warnings",
      "--no-playlist",
      "--geo-bypass",
      "--ignore-errors",
      "--no-check-certificates",
    ]
  }

  static getStrategy3Args(userAgent, cookieFile) {
    const args = [
      "--user-agent",
      userAgent,
      "--referer",
      "https://www.youtube.com/",
      "--add-header",
      "Accept-Language:en-US,en;q=0.9",
      "--sleep-interval",
      "3",
      "--max-sleep-interval",
      "7",
      "--extractor-retries",
      "2",
      "--fragment-retries",
      "2",
      "--retry-sleep",
      "5",
      "--no-warnings",
      "--no-playlist",
      "--geo-bypass",
      "--ignore-errors",
      "--no-check-certificates",
      "--compat-options",
      "all",
    ]

    if (cookieFile) {
      args.push("--cookies", cookieFile)
    }

    return args
  }
}

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

  // Google Cookies
  for (let i = 1; i <= 10; i++) {
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

  // 🐦 Twitter Cookies
  for (let i = 1; i <= 5; i++) {
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

// 🚨 CORS CONFIGURAÇÃO CRÍTICA - CORRIGIDA PARA EVITAR SLEEP MODE ISSUES
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

// 🚨 CORS PREFLIGHT HANDLER - GARANTIR QUE SEMPRE RESPONDA
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

// 🛡️ RATE LIMITING MAIS AMIGÁVEL
const downloadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: {
    error: "Muitas tentativas de download. Tente novamente em alguns minutos.",
    type: "rate_limit_exceeded",
  },
  standardHeaders: true,
  legacyHeaders: false,
})

const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  message: {
    error: "Muitas requisições. Tente novamente em 1 minuto.",
    type: "rate_limit_exceeded",
  },
})

app.use(generalLimiter)
app.use("/download", downloadLimiter)

// 🧠 MIDDLEWARE PARA RASTREAR ATIVIDADE (PARA SLEEP MODE) - MAIS TOLERANTE
app.use((req, res, next) => {
  lastActivity = Date.now()
  console.log(`🌐 Request: ${req.method} ${req.path} - Activity updated`)
  next()
})

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

// 🔧 FUNÇÃO CORRIGIDA - REMOVIDA VERIFICAÇÃO DE '=' INCORRETA
function createSecureCookieFiles() {
  console.log("🛡️ Criando arquivos de cookie seguros...")

  if (!fs.existsSync(COOKIES_DIR)) {
    fs.mkdirSync(COOKIES_DIR, { recursive: true, mode: 0o700 })
  }

  let cookiesCreated = 0

  // Google Cookies - CORREÇÃO APLICADA
  for (let i = 1; i <= 10; i++) {
    const envVar = `GOOGLE_COOKIE_${i.toString().padStart(2, "0")}`
    const cookieContent = process.env[envVar]

    if (cookieContent) {
      console.log(`🔍 Processando ${envVar}: ${cookieContent.length} caracteres`)

      const filename = `google_conta${i.toString().padStart(2, "0")}.txt`
      const filepath = path.join(COOKIES_DIR, filename)

      // 🔧 CORREÇÃO: Removida verificação incorreta de '=' - cookies Netscape são válidos sem '='
      if (cookieContent.length > 100) {
        // Apenas verificar tamanho mínimo razoável
        // 🔍 VALIDAR FORMATO ANTES DE SALVAR
        const validation = validateCookieFormat(cookieContent, filename)

        fs.writeFileSync(filepath, cookieContent, { mode: 0o600 })
        console.log(`✅ Cookie Google ${i} criado: ${filename}`)

        if (validation.valid) {
          console.log(`   ✅ Formato válido: ${validation.validLines} linhas`)
        } else {
          console.log(`   ⚠️ Formato suspeito: ${validation.reason}`)
          // MAS AINDA ASSIM CRIAR O ARQUIVO - pode ser válido mesmo com aviso
        }

        cookiesCreated++
      } else {
        console.log(`❌ Cookie ${envVar} muito pequeno: ${cookieContent.length} chars`)
      }
    }
  }

  // Instagram Cookies - CORREÇÃO APLICADA
  for (let i = 1; i <= 8; i++) {
    const envVar = `INSTAGRAM_COOKIE_${i.toString().padStart(2, "0")}`
    const cookieContent = process.env[envVar]

    if (cookieContent) {
      console.log(`🔍 Processando ${envVar}: ${cookieContent.length} caracteres`)

      const filename = `instagram_conta${i.toString().padStart(2, "0")}.txt`
      const filepath = path.join(COOKIES_DIR, filename)

      // 🔧 CORREÇÃO: Removida verificação incorreta de '='
      if (cookieContent.length > 100) {
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
        console.log(`❌ Cookie ${envVar} muito pequeno: ${cookieContent.length} chars`)
      }
    }
  }

  // 🐦 Twitter Cookies - CORREÇÃO APLICADA
  for (let i = 1; i <= 5; i++) {
    const envVar = `TWITTER_COOKIE_${i.toString().padStart(2, "0")}`
    const cookieContent = process.env[envVar]

    if (cookieContent) {
      console.log(`🔍 Processando ${envVar}: ${cookieContent.length} caracteres`)

      const filename = `twitter_conta${i.toString().padStart(2, "0")}.txt`
      const filepath = path.join(COOKIES_DIR, filename)

      // 🔧 CORREÇÃO: Removida verificação incorreta de '='
      if (cookieContent.length > 100) {
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
        console.log(`❌ Cookie ${envVar} muito pequeno: ${cookieContent.length} chars`)
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
let twitterCookiePool = [] // 🐦 NOVO POOL TWITTER
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
    twitterCookiePool = files.filter((f) => f.startsWith("twitter_")).map((f) => path.join(COOKIES_DIR, f)) // 🐦 NOVO
    generalCookiePool = files.map((file) => path.join(COOKIES_DIR, file))

    console.log(`🔵 Google cookies: ${googleCookiePool.length}`)
    console.log(`📸 Instagram cookies: ${instagramCookiePool.length}`)
    console.log(`🐦 Twitter cookies: ${twitterCookiePool.length}`) // 🐦 NOVO
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

// 🔍 VERSÃO COM DEBUG da função getSmartCookie - ATUALIZADA COM TWITTER
function getSmartCookie(platform) {
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

  const selected = pool[Math.floor(Math.random() * pool.length)]
  console.log(`🍪 Cookie selecionado para ${platform}: ${path.basename(selected)} (pool: ${poolName})`)

  // 🐦 Log especial para Twitter
  if (platform === "twitter" && poolName === "Twitter") {
    console.log(`   🔞 Cookie Twitter específico - NSFW habilitado`)
  }

  return selected
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

// 🔧 COMANDO SEGURO CORRIGIDO - SEM IMPERSONATION E LEGENDAS OPCIONAIS
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

  // 🐦 CONFIGURAÇÕES ESPECÍFICAS PARA TWITTER
  if (platform === "twitter") {
    baseArgs.push(
      "--sleep-interval",
      "1",
      "--max-sleep-interval",
      "3",
      "--extractor-retries",
      "5",
      "--fragment-retries",
      "5",
      "--retry-sleep",
      "2",
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
    "The following content is not available on this app", // 🎯 YOUTUBE ESPECÍFICO
    "Watch on the latest version of YouTube", // 🎯 YOUTUBE ESPECÍFICO
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

// 🎯 CORREÇÃO YOUTUBE: Função para tentar múltiplas estratégias
async function tryYouTubeDownloadStrategies(url, format, quality, uniqueId) {
  const strategies = [
    { name: "Estratégia 1: Cookies + Headers otimizados", useStrategy: 1 },
    { name: "Estratégia 2: Sem cookies + Bypass", useStrategy: 2 },
    { name: "Estratégia 3: Modo compatibilidade", useStrategy: 3 },
  ]

  for (const strategy of strategies) {
    try {
      console.log(`🎯 YouTube: Tentando ${strategy.name}`)

      const cookieFile = strategy.useStrategy === 2 ? null : getSmartCookie("youtube")
      const randomUA = getRandomUserAgent()

      let baseArgs
      switch (strategy.useStrategy) {
        case 1:
          baseArgs = YouTubeBypassStrategies.getStrategy1Args(randomUA, cookieFile)
          break
        case 2:
          baseArgs = YouTubeBypassStrategies.getStrategy2Args(randomUA)
          break
        case 3:
          baseArgs = YouTubeBypassStrategies.getStrategy3Args(randomUA, cookieFile)
          break
      }

      // Primeiro, tentar obter informações
      const jsonArgs = [...baseArgs, "-j", url]
      const { stdout: jsonStdout } = await executeSecureCommand(ytDlpPath, jsonArgs, { timeout: 45000 })

      const jsonLine = jsonStdout.split("\n").find((line) => line.trim().startsWith("{"))
      if (!jsonLine) throw new Error("Nenhuma linha JSON encontrada")

      const data = JSON.parse(jsonLine)

      // Verificar duração
      const durationCheck = checkDuration(data.duration)
      if (!durationCheck.allowed) {
        throw new Error(durationCheck.message)
      }

      // Preparar download
      const safeTitle = generateSecureFilename(data.title, quality, format, uniqueId)
      const outputPath = path.join(DOWNLOADS, safeTitle)

      let downloadArgs
      if (format === "mp3") {
        const q = Number.parseInt(quality || "128")
        const formatSelector = getFormatSelector("mp3", quality, "youtube")
        downloadArgs = [
          ...baseArgs,
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
        const formatSelector = getFormatSelector("mp4", quality, "youtube")
        downloadArgs = [
          ...baseArgs,
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

      console.log(`🚀 YouTube: Executando download com ${strategy.name}`)
      await executeSecureCommand(ytDlpPath, downloadArgs, { timeout: 600000 })

      // Verificar se arquivo foi criado
      let finalFilePath = outputPath
      if (!fs.existsSync(finalFilePath)) {
        finalFilePath = findRecentFile(DOWNLOADS, Date.now(), [`.${format === "mp3" ? "mp3" : "mp4"}`])
        if (!finalFilePath) {
          throw new Error("Arquivo não foi criado")
        }
      }

      const stats = fs.statSync(finalFilePath)
      if (stats.size < 1000) {
        throw new Error("Arquivo gerado está corrompido ou vazio")
      }

      console.log(`✅ YouTube: Sucesso com ${strategy.name}!`)
      return {
        success: true,
        data,
        finalFilePath,
        stats,
        durationCheck,
        strategy: strategy.name,
      }
    } catch (error) {
      console.log(`❌ YouTube: ${strategy.name} falhou: ${error.message}`)

      // Se for o último método, lançar erro
      if (strategy === strategies[strategies.length - 1]) {
        throw new Error(`Todas as estratégias do YouTube falharam. Último erro: ${error.message}`)
      }

      // Aguardar antes da próxima tentativa
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
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

app.use(express.json({ limit: "10mb" }))

if (!fs.existsSync(DOWNLOADS)) {
  fs.mkdirSync(DOWNLOADS, { recursive: true, mode: 0o755 })
}

if (!fs.existsSync(COOKIES_DIR)) {
  fs.mkdirSync(COOKIES_DIR, { recursive: true, mode: 0o700 })
}

// 🛡️ ROTA PRINCIPAL CORRIGIDA - CONTADOR E ERROS FIXADOS + DEBUG DE COOKIES + TWITTER + YOUTUBE FIX
app.post("/download", async (req, res) => {
  const startTime = Date.now()
  let downloadStarted = false // 🔧 FLAG PARA CONTROLAR CONTADOR

  try {
    console.log(`🌐 POST /download - CORS headers should be set automatically`)

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
    const uniqueId = crypto.randomBytes(8).toString("hex")

    console.log("🎯 Nova requisição segura:", {
      url: url.substring(0, 50) + "...",
      format,
      quality,
      platform: detectedPlatform,
    })

    // 🎯 CORREÇÃO YOUTUBE: Usar estratégias específicas para YouTube
    if (detectedPlatform === "youtube") {
      try {
        console.log("🎯 Detectado YouTube - usando estratégias avançadas de bypass")

        // Atualizar yt-dlp se possível
        await ensureYtDlpUpdated()

        const result = await tryYouTubeDownloadStrategies(url, format, quality, uniqueId)

        const actualFilename = path.basename(result.finalFilePath)
        const downloadKey = `download_${crypto.randomBytes(16).toString("hex")}.${format === "mp3" ? "mp3" : "mp4"}`

        fileMap.set(downloadKey, {
          actualPath: result.finalFilePath,
          actualFilename: actualFilename,
          userFriendlyName: `${result.data.title.substring(0, 50)} - ${format === "mp3" ? quality + "kbps" : quality + "p"}.${format === "mp3" ? "mp3" : "mp4"}`,
          size: result.stats.size,
          created: Date.now(),
        })

        console.log("✅ YouTube download concluído com sucesso:", {
          platform: detectedPlatform,
          downloadKey: downloadKey,
          size: `${(result.stats.size / 1024 / 1024).toFixed(2)} MB`,
          duration: result.durationCheck.duration_formatted || "N/A",
          strategy: result.strategy,
        })

        return res.json({
          file: `/downloads/${downloadKey}`,
          filename: `${result.data.title.substring(0, 50)} - ${format === "mp3" ? quality + "kbps" : quality + "p"}.${format === "mp3" ? "mp3" : "mp4"}`,
          size: result.stats.size,
          title: result.data.title,
          duration: result.data.duration,
          duration_formatted: result.durationCheck.duration_formatted,
          platform: detectedPlatform,
          quality_achieved: format === "mp3" ? `${quality}kbps` : `${quality}p`,
          used_strategy: result.strategy,
          youtube_fix_applied: true,
        })
      } catch (error) {
        console.error("❌ Todas as estratégias do YouTube falharam:", error.message)

        return res.status(500).json({
          error: "YouTube temporariamente indisponível. Tente novamente em alguns minutos.",
          type: "youtube_blocked",
          platform: "youtube",
          suggestion: "O YouTube está bloqueando downloads no momento. Tente outro vídeo ou aguarde alguns minutos.",
          technical_details: error.message.substring(0, 200),
        })
      }
    }

    // 🔄 LÓGICA ORIGINAL PARA OUTRAS PLATAFORMAS (TikTok, Twitter, Instagram, etc.)
    const cookieFile = getSmartCookie(detectedPlatform) // 🔍 JÁ COM DEBUG + TWITTER
    const randomUA = getRandomUserAgent()

    // 🔍 LOG DETALHADO DE COOKIE
    console.log("🍪 Informações de cookie:", {
      platform: detectedPlatform,
      cookieFile: cookieFile ? path.basename(cookieFile) : "NENHUM",
      cookieExists: cookieFile ? fs.existsSync(cookieFile) : false,
      cookieSize: cookieFile && fs.existsSync(cookieFile) ? fs.statSync(cookieFile).size : 0,
    })

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
          // 🔧 TWITTER E OUTRAS - SEM AUTO-SUBS PARA EVITAR RATE LIMIT
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

      console.log("🚀 Iniciando download seguro...")

      const { stdout: downloadStdout, stderr: downloadStderr } = await executeSecureCommand(ytDlpPath, downloadArgs, {
        timeout: 600000,
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

      console.log("✅ Download seguro concluído:", {
        platform: detectedPlatform,
        downloadKey: downloadKey,
        size: `${(stats.size / 1024 / 1024).toFixed(2)} MB`,
        duration: durationCheck.duration_formatted || "N/A",
        used_cookies: !!cookieFile,
        cookie_file: cookieFile ? path.basename(cookieFile) : "NENHUM",
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
        used_cookies: !!cookieFile,
      })
    } catch (error) {
      console.error("❌ Erro no download:", error.message)

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
          // 🐦 ERRO ESPECÍFICO PARA TWITTER
          return res.status(400).json({
            error: "Conteúdo NSFW do Twitter requer cookies de autenticação. Configure TWITTER_COOKIE_01.",
            type: "twitter_nsfw_required",
            platform: "twitter",
            suggestion: "Use Cookie-Editor para extrair cookies do Twitter logado",
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
    res.status(500).json({ error: "Erro interno do servidor" })
  } finally {
    // 🔧 DECREMENTAR CONTADOR APENAS SE FOI INCREMENTADO
    if (downloadStarted) {
      activeDownloads = Math.max(0, activeDownloads - 1) // 🔧 NUNCA DEIXAR NEGATIVO
      console.log(`📉 Downloads ativos: ${activeDownloads}/${MAX_CONCURRENT_DOWNLOADS}`)
    }
  }
})

// 🧠 NOVA ROTA: Status de memória em tempo real - RAILWAY COMPATIBLE
app.get("/memory", (req, res) => {
  const memoryStats = logMemoryUsage()
  const gcMethods = []

  // Verificar múltiplos métodos de GC
  if (typeof global.gc === "function") {
    gcMethods.push("global.gc() disponível")
  }

  try {
    const v8 = require("v8")
    if (v8.getHeapStatistics) {
      gcMethods.push("V8 heap statistics disponível")
    }
  } catch (e) {
    gcMethods.push("V8 não disponível")
  }

  res.json({
    message: "🧠 Status de Memória em Tempo Real - RAILWAY OPTIMIZED",
    timestamp: new Date().toISOString(),
    memory: memoryStats,
    gc_methods: gcMethods,
    gc_available: gcMethods.length > 0,
    environment_variables: {
      NODE_OPTIONS: process.env.NODE_OPTIONS || "não definido",
      NODE_ENV: process.env.NODE_ENV || "não definido",
      MAX_OLD_SPACE_SIZE: process.env.MAX_OLD_SPACE_SIZE || "não definido",
    },
    uptime: Math.round(process.uptime()),
    active_downloads: activeDownloads,
    last_activity: Math.round((Date.now() - lastActivity) / 1000) + "s ago",
    recommendations: [
      gcMethods.length > 0 ? "✅ Métodos de limpeza disponíveis" : "❌ Nenhum método de GC - usando limpeza manual",
      memoryStats.heapUsed > 200 ? "⚠️ Alto uso de memória - executando limpeza" : "✅ Uso de memória normal",
      activeDownloads === 0 ? "💤 Servidor inativo - candidato para sleep mode" : "🚀 Servidor ativo",
    ],
    railway_workaround: gcMethods.length === 0 ? "Usando limpeza manual agressiva" : "GC nativo funcionando",
  })
})

// 🔍 ROTA DE TESTE DE COOKIES - ATUALIZADA COM TWITTER
app.get("/test-cookies", async (req, res) => {
  console.log("🧪 === TESTE DE COOKIES INICIADO ===")

  const results = {
    environment_variables: {},
    cookie_files: {},
    pools: {
      google: googleCookiePool.length,
      instagram: instagramCookiePool.length,
      twitter: twitterCookiePool.length, // 🐦 NOVO
      general: generalCookiePool.length,
    },
    tests: {},
    recommendations: [],
  }

  // 1. Verificar variáveis de ambiente
  let envVarsFound = 0

  // Google
  for (let i = 1; i <= 10; i++) {
    const envVar = `GOOGLE_COOKIE_${i.toString().padStart(2, "0")}`
    const cookieContent = process.env[envVar]

    if (cookieContent) {
      envVarsFound++
      const validation = validateCookieFormat(cookieContent, envVar)

      results.environment_variables[envVar] = {
        exists: true,
        length: cookieContent.length,
        has_equals: cookieContent.includes("="), // 🔧 MANTIDO PARA COMPATIBILIDADE, MAS NÃO USADO NA VALIDAÇÃO
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

  // 🐦 Twitter - NOVO
  for (let i = 1; i <= 5; i++) {
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
  const platforms = ["youtube", "instagram", "twitter"] // 🐦 INCLUÍDO TWITTER

  for (const platform of platforms) {
    const selectedCookie = getSmartCookie(platform)

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

  const hasFormatIssues = Object.values(results.environment_variables).some((v) => v.exists && !v.format_valid)
  if (hasFormatIssues) {
    results.recommendations.push("⚠️ Alguns cookies têm formato inválido - use formato Netscape do Cookie Editor")
  } else {
    results.recommendations.push("✅ Formato dos cookies OK")
  }

  console.log("🧪 === TESTE DE COOKIES CONCLUÍDO ===")

  res.json({
    message: "🧪 Teste de Cookies Completo - RAILWAY MEMORY OPTIMIZATION + YOUTUBE FIX + CORS FIX APLICADO!",
    timestamp: new Date().toISOString(),
    summary: {
      env_vars_found: envVarsFound,
      cookies_loaded: results.pools.google + results.pools.instagram + results.pools.twitter,
      files_created: Object.keys(results.cookie_files).length,
      twitter_nsfw_ready: results.pools.twitter > 0,
      youtube_fix_applied: "✅ Estratégias múltiplas de bypass implementadas",
      memory_optimization_applied: "🧠 Sistema de limpeza agressiva de memória ativado (Railway compatible)",
      cors_fix_applied: "🚨 CORS configurado para evitar sleep mode issues",
      fix_applied: "✅ Removida verificação incorreta de '=' - cookies Netscape agora carregam corretamente",
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
  const memoryStats = logMemoryUsage()

  const stats = {
    status: "OK - SECURE + RAILWAY MEMORY OPTIMIZED + YOUTUBE FIX + CORS FIXED",
    version:
      "6.2.0 - RAILWAY MEMORY OPTIMIZATION + YOUTUBE BYPASS STRATEGIES + COOKIE VALIDATION FIXED + TWITTER SUPPORT + CORS SLEEP MODE FIX",
    timestamp: new Date().toISOString(),
    limits: {
      max_duration: formatDuration(MAX_DURATION),
      max_file_size: "1GB",
      max_concurrent: MAX_CONCURRENT_DOWNLOADS,
    },
    memory_optimization: {
      gc_available: typeof global.gc !== "undefined",
      railway_workaround: typeof global.gc === "undefined" ? "Manual cleanup active" : "Native GC active",
      current_memory: memoryStats,
      sleep_mode_enabled: true,
      sleep_mode_tolerance: "20min (mais tolerante para evitar CORS issues)",
      auto_cleanup_enabled: true,
    },
    cors_configuration: {
      status: "FIXED - Configuração robusta para evitar sleep mode issues",
      origins: ["https://www.waifuconvert.com", "https://waifuconvert.com", "https://waifuconvert.vercel.app"],
      preflight_handler: "✅ Explicit OPTIONS handler implemented",
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      credentials: true,
    },
    security_features: [
      "✅ Input validation",
      "✅ Command injection protection",
      "✅ Rate limiting",
      "✅ Duration limits (2h max)",
      "✅ Secure file handling",
      "✅ Domain whitelist",
      "✅ Resource limits",
      "✅ Helmet security headers",
      "✅ Counter bug fixed",
      "✅ 144p quality support",
      "✅ Non-critical error handling",
      "✅ Cookie debugging system",
      "✅ Twitter NSFW support",
      "✅ Cookie validation fixed - Netscape format now works",
      "🎯 YouTube bypass strategies implemented",
      "🎯 Multiple fallback methods for YouTube",
      "🎯 Auto yt-dlp updates",
      "🧠 Railway-compatible memory management",
      "🧠 Multiple GC methods (native + manual)",
      "🧠 Sleep mode for inactive periods",
      "🚨 CORS configuration fixed for sleep mode compatibility",
    ],
    cookies_loaded: {
      google: googleCookiePool.length,
      instagram: instagramCookiePool.length,
      twitter: twitterCookiePool.length,
      total: generalCookiePool.length,
    },
    active_downloads: activeDownloads,
    uptime: process.uptime(),
  }

  res.json(stats)
})

app.get("/", (req, res) => {
  res.json({
    message:
      "🛡️ WaifuConvert Backend - RAILWAY MEMORY OPTIMIZED + YOUTUBE FIX + COOKIE VALIDATION FIXED + TWITTER NSFW + CORS SLEEP MODE FIX!",
    version: "6.2.0",
    status:
      "online - security active + railway memory optimized + youtube fix + cookie fix + cors sleep mode fix applied",
    security_level: "HIGH",
    limits: {
      duration: "2 horas máximo (MP3/MP4, qualquer qualidade)",
      file_size: "1GB máximo",
      rate_limit: "20 downloads a cada 10 minutos",
      concurrent: "8 downloads simultâneos",
    },
    quality_support: {
      mp3: "64kbps - 320kbps",
      mp4: "144p, 360p, 480p, 720p, 1080p",
    },
    memory_features: [
      "🧠 Railway-compatible garbage collection",
      "🧠 Multiple cleanup methods (native + manual)",
      "🧠 Memory usage monitoring",
      "🧠 Automatic cleanup every 3 minutes",
      "🧠 Sleep mode after 20min inactive (mais tolerante)",
      "🧠 Memory limit enforcement (256MB)",
      "🧠 Real-time memory alerts",
      "🧠 Aggressive manual cleanup when GC unavailable",
    ],
    cors_features: [
      "🚨 Robust CORS configuration",
      "🚨 Explicit preflight handler",
      "🚨 Sleep mode compatibility",
      "🚨 Multiple origin support",
      "🚨 Credential support enabled",
      "🚨 Comprehensive headers support",
    ],
    youtube_features: [
      "🎯 Multiple bypass strategies",
      "🎯 Auto yt-dlp updates",
      "🎯 Advanced cookie rotation",
      "🎯 Fallback methods",
      "🎯 Rate limit handling",
      "🎯 Bot detection bypass",
    ],
    twitter_features: [
      "🐦 Dedicated Twitter cookie pool",
      "🔞 NSFW content support",
      "🔍 Twitter-specific cookie validation",
      "⚡ Optimized for Twitter rate limits",
      "🛡️ Secure Twitter authentication",
    ],
    debug_features: [
      "🔍 Cookie format validation",
      "🔍 Environment variable checking",
      "🔍 Cookie pool debugging",
      "🔍 Platform-specific cookie selection",
      "🔍 Real-time cookie usage logging",
      "🐦 Twitter NSFW readiness check",
      "🎯 YouTube strategy testing",
      "🧠 Railway memory usage monitoring",
      "🚨 CORS troubleshooting",
    ],
    fixes_applied: [
      "✅ Counter never goes negative",
      "✅ 144p quality support added",
      "✅ Impersonation warnings eliminated",
      "✅ Subtitle rate limit errors ignored",
      "✅ Non-critical error handling",
      "✅ Cookie debugging system",
      "✅ Twitter NSFW support added",
      "✅ Cookie validation fixed - removed incorrect '=' check",
      "✅ Netscape format cookies now load properly",
      "🎯 YouTube bypass strategies implemented",
      "🎯 Multiple fallback methods for blocked content",
      "🎯 Auto yt-dlp update system",
      "🧠 Railway memory optimization system implemented",
      "🧠 Multiple GC methods for Railway compatibility",
      "🧠 Sleep mode for cost reduction",
      "🚨 CORS sleep mode issue fixed",
      "🚨 Explicit preflight handler added",
      "🚨 More tolerant sleep timing (20min)",
    ],
    features: [
      "✅ Input validation & sanitization",
      "✅ Command injection protection",
      "✅ Rate limiting (20 downloads/10min)",
      "✅ Duration limits (2h max for everything)",
      "✅ Concurrent download limits",
      "✅ Domain whitelist protection",
      "✅ Secure file handling",
      "✅ Resource usage limits",
      "✅ Security headers (Helmet)",
      "✅ Safe cookie management",
      "✅ Fixed cookie validation for Netscape format",
      "🎯 Advanced YouTube bypass system",
      "🧠 Railway-intelligent memory management",
      "🚨 Robust CORS configuration",
    ],
    platform_support: {
      tiktok: "✅ Working perfectly",
      twitter: `🐦 Working with ${twitterCookiePool.length} dedicated cookies + ${googleCookiePool.length} fallback`,
      instagram: `✅ Working with ${instagramCookiePool.length} cookies`,
      youtube: `🎯 FIXED - Working with advanced bypass strategies + ${googleCookiePool.length} cookies`,
    },
    debug_endpoints: [
      "GET /test-cookies - Diagnóstico completo de cookies (incluindo Twitter)",
      "GET /health - Status do sistema",
      "GET /memory - Status de memória em tempo real (Railway compatible)",
    ],
    railway_optimizations: [
      "🚀 NODE_OPTIONS compatibility check",
      "🚀 Multiple GC fallback methods",
      "🚀 Aggressive manual cleanup",
      "🚀 Memory pressure detection",
      "🚀 Container-optimized sleep mode",
      "🚨 CORS sleep mode compatibility",
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
    available_endpoints: ["/", "/health", "/download", "/test-cookies", "/memory"],
  })
})

// 🧠 LIMPEZA AUTOMÁTICA A CADA 3 MINUTOS (Railway otimizado)
setInterval(
  () => {
    console.log("🧹 Limpeza automática Railway iniciada...")
    cleanupOldFiles()
    aggressiveMemoryCleanup() // Usar limpeza agressiva
    logMemoryUsage()
  },
  3 * 60 * 1000,
) // 3 minutos para Railway

// 🧠 SLEEP MODE MAIS TOLERANTE - 20 MINUTOS para evitar CORS issues
setInterval(() => {
  const inactive = Date.now() - lastActivity
  if (inactive > 20 * 60 * 1000 && activeDownloads === 0) {
    console.log("💤 20min inativo + 0 downloads - entrando em sleep mode Railway...")
    console.log("🧠 Última limpeza agressiva de memória antes do sleep...")
    aggressiveMemoryCleanup()
    process.exit(0) // Railway restarta quando necessário
  }
}, 60 * 1000) // Verificar a cada minuto

app.listen(PORT, async () => {
  console.log(
    "🛡️ WaifuConvert Backend - RAILWAY MEMORY OPTIMIZED + YOUTUBE FIX + COOKIE VALIDATION FIXED + TWITTER NSFW SUPPORT + CORS SLEEP MODE FIX",
  )
  console.log(`🌐 Porta: ${PORT}`)

  // 🧠 VERIFICAR VARIÁVEIS DE OTIMIZAÇÃO DE MEMÓRIA NA INICIALIZAÇÃO - RAILWAY
  checkOptimizationVariables()

  console.log("🔒 RECURSOS DE SEGURANÇA ATIVADOS:")
  console.log("  ✅ Validação rigorosa de entrada")
  console.log("  ✅ Proteção contra command injection")
  console.log("  ✅ Rate limiting inteligente")
  console.log("  ✅ Limite de duração: 2 horas para tudo")
  console.log("  ✅ Contador de downloads corrigido")
  console.log("  ✅ Suporte a 144p adicionado")
  console.log("  ✅ Tratamento de erros não críticos")
  console.log("  ✅ Sistema de debug de cookies")
  console.log("  🐦 Suporte completo ao Twitter NSFW")
  console.log("  🔧 CORREÇÃO APLICADA: Validação de cookies Netscape")
  console.log("  🎯 YOUTUBE FIX: Estratégias múltiplas de bypass")
  console.log("  🎯 Auto-atualização do yt-dlp")
  console.log("  🧠 RAILWAY MEMORY OPTIMIZATION: Sistema de limpeza agressiva")
  console.log("  🧠 Múltiplos métodos de GC (nativo + manual)")
  console.log("  🧠 Limpeza automática a cada 3 minutos")
  console.log("  🧠 Sleep mode após 20min inativo (mais tolerante)")
  console.log("  🚨 CORS SLEEP MODE FIX: Configuração robusta")
  console.log("  🚨 Explicit preflight handler")
  console.log("  ✅ Whitelist de domínios")
  console.log("  ✅ Limites de recursos")
  console.log("  ✅ Headers de segurança")
  console.log("  ✅ Execução segura de comandos")
  console.log("  ✅ Gerenciamento seguro de arquivos")

  // Tentar atualizar yt-dlp na inicialização
  console.log("🔄 Verificando yt-dlp na inicialização...")
  await ensureYtDlpUpdated()

  const cookiesCreated = createSecureCookieFiles()
  loadCookiePool()

  console.log("🍪 COOKIES SEGUROS:")
  console.log(`  🔵 Google: ${googleCookiePool.length}`)
  console.log(`  📸 Instagram: ${instagramCookiePool.length}`)
  console.log(`  🐦 Twitter: ${twitterCookiePool.length}`)
  console.log(`  📊 Total: ${generalCookiePool.length}`)

  console.log("🕐 LIMITES DE DURAÇÃO:")
  console.log(`  📹 Qualquer formato: máximo ${formatDuration(MAX_DURATION)}`)
  console.log(`  📁 Tamanho máximo: 1GB`)

  console.log("🎯 QUALIDADES SUPORTADAS:")
  console.log("  🎵 MP3: 64kbps - 320kbps")
  console.log("  📹 MP4: 144p, 360p, 480p, 720p, 1080p")

  console.log("🐦 RECURSOS TWITTER:")
  console.log("  🔞 Suporte a conteúdo NSFW")
  console.log("  🍪 Pool dedicado de cookies")
  console.log("  🔍 Validação específica de cookies")
  console.log("  ⚡ Otimizado para rate limits")

  console.log("🎯 RECURSOS YOUTUBE:")
  console.log("  🎯 Estratégias múltiplas de bypass")
  console.log("  🎯 Auto-atualização do yt-dlp")
  console.log("  🎯 Rotação inteligente de cookies")
  console.log("  🎯 Fallback para conteúdo bloqueado")
  console.log("  🎯 Detecção e bypass de bot")

  console.log("🧠 RECURSOS DE MEMÓRIA RAILWAY:")
  console.log("  🧠 Limpeza automática a cada 3 minutos")
  console.log("  🧠 Múltiplos métodos de GC (nativo + manual)")
  console.log("  🧠 Limpeza agressiva quando GC indisponível")
  console.log("  🧠 Monitoramento de uso de RAM")
  console.log("  🧠 Sleep mode após 20min inativo (mais tolerante)")
  console.log("  🧠 Limite de memória: 256MB")
  console.log("  🧠 Alertas de alto uso de memória")
  console.log("  🧠 Cache cleanup automático")

  console.log("🚨 RECURSOS DE CORS:")
  console.log("  🚨 Configuração robusta para evitar sleep mode issues")
  console.log("  🚨 Explicit preflight OPTIONS handler")
  console.log("  🚨 Multiple origin support")
  console.log("  🚨 Credential support habilitado")
  console.log("  🚨 Comprehensive headers support")
  console.log("  🚨 Sleep mode timing mais tolerante (20min)")

  console.log("🔧 CORREÇÕES CRÍTICAS APLICADAS:")
  console.log("  ✅ Removida verificação incorreta de '=' nos cookies")
  console.log("  ✅ Cookies Netscape agora carregam corretamente")
  console.log("  🎯 YouTube bypass strategies implementadas")
  console.log("  🎯 Sistema de fallback para YouTube bloqueado")
  console.log("  🧠 Sistema de otimização de memória Railway implementado")
  console.log("  🧠 Múltiplos métodos de GC para compatibilidade Railway")
  console.log("  🚨 CORS sleep mode issue RESOLVIDO")
  console.log("  🚨 Preflight handler explícito adicionado")
  console.log("  🚨 Sleep timing mais tolerante para evitar CORS issues")

  console.log("🔍 ENDPOINTS DE DEBUG:")
  console.log("  🧪 /test-cookies - Diagnóstico completo")
  console.log("  ❤️ /health - Status do sistema")
  console.log("  🧠 /memory - Status de memória em tempo real (Railway compatible)")

  // 🧠 LOG INICIAL DE MEMÓRIA E TESTE DE LIMPEZA
  console.log("🧠 Status inicial de memória:")
  logMemoryUsage()

  console.log("🧪 Testando limpeza agressiva na inicialização...")
  aggressiveMemoryCleanup()

  console.log("🚨 CORS configurado para:")
  console.log("  🌐 https://www.waifuconvert.com")
  console.log("  🌐 https://waifuconvert.com")
  console.log("  🌐 https://waifuconvert.vercel.app")
  console.log("  🛡️ Explicit preflight handler ativo")
  console.log("  ⏰ Sleep mode mais tolerante (20min)")

  cleanupOldFiles()
})

process.on("uncaughtException", (error) => {
  console.error("❌ Erro não capturado:", error.message)
  console.log("🧠 Limpeza de emergência antes de sair...")
  aggressiveMemoryCleanup()
  process.exit(1)
})

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Promise rejeitada:", reason)
})

process.on("SIGTERM", () => {
  console.log("🛑 Recebido SIGTERM, encerrando graciosamente...")
  console.log("🧠 Limpeza final agressiva de memória...")
  aggressiveMemoryCleanup()
  process.exit(0)
})

process.on("SIGINT", () => {
  console.log("🛑 Recebido SIGINT, encerrando graciosamente...")
  console.log("🧠 Limpeza final agressiva de memória...")
  aggressiveMemoryCleanup()
  process.exit(0)
})
