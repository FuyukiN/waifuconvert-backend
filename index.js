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

// 🛡️ CONFIAR NO RAILWAY PROXY PARA RATE LIMITING CORRETO
app.set("trust proxy", true)

// 🛡️ CONFIGURAÇÕES MAIS GENEROSAS
const PORT = process.env.PORT || 8080
const MAX_CONCURRENT_DOWNLOADS = 4 // REDUZIDO para economia
const MAX_FILE_SIZE = 512 * 1024 * 1024 // 512MB (reduzido)
const MAX_DURATION = 7200 // 🕐 2 HORAS PARA TUDO (MP3/MP4, qualquer qualidade)

// 🧠 SISTEMA DE LIMPEZA AGRESSIVA DE MEMÓRIA - SEM SLEEP MODE
let lastActivity = Date.now()
let memoryCleanupInterval = null
let fileCleanupInterval = null

// Sistema de economia de recursos
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

    if (inactive > this.economyThreshold && !this.isEconomyMode && activeDownloads === 0) {
      this.enterEconomyMode(inactiveMinutes)
    }
  }

  enterEconomyMode(inactiveMinutes) {
    this.isEconomyMode = true
    console.log(`🔥 MODO ECONOMIA ATIVADO - servidor inativo há ${inactiveMinutes}min`)
    ultraAggressiveMemoryCleanup()
  }

  exitEconomyMode() {
    if (!this.isEconomyMode) return
    this.isEconomyMode = false
    console.log(`🚀 MODO NORMAL ATIVADO - nova requisição detectada`)
  }

  getEconomyStatus() {
    const inactive = Date.now() - this.lastRequest
    const inactiveMinutes = Math.floor(inactive / 60000)
    return {
      economy_mode: this.isEconomyMode,
      inactive_time_minutes: inactiveMinutes,
    }
  }
}

const resourceEconomizer = new ResourceEconomizer()

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

// 🧠 FUNÇÃO DE LIMPEZA ULTRA-AGRESSIVA (PARA DOWNLOADS)
function ultraAggressiveMemoryCleanup() {
  console.log("🧹 === LIMPEZA ULTRA-AGRESSIVA DE MEMÓRIA ===")
  const before = process.memoryUsage()

  try {
    // 1. Tentar GC normal
    forceGarbageCollection()

    // 2. Limpar caches do Node.js (com cuidado)
    if (require.cache) {
      const cacheKeys = Object.keys(require.cache)
      const essentialModules = [
        "express",
        "cors",
        "helmet",
        "validator",
        "child_process",
        "fs",
        "path",
        "rate-limit",
        "crypto",
        "v8", // Adicionado v8
      ]
      let clearedCount = 0
      cacheKeys.forEach((key) => {
        const isEssential = essentialModules.some((mod) => key.includes(mod))
        // Evitar remover módulos essenciais ou do node_modules
        if (!isEssential && !key.includes("node_modules") && key.startsWith(process.cwd())) {
          try {
            delete require.cache[key]
            clearedCount++
          } catch (e) {
            // Ignorar erros de limpeza
          }
        }
      })
      console.log(`🗂️ Módulos do cache limpos: ${clearedCount}`)
    }

    // 3. Limpar pools de cookies temporariamente
    const currentGooglePool = googleCookiePool.length
    const currentInstagramPool = instagramCookiePool.length
    const currentTwitterPool = twitterCookiePool.length
    const currentGeneralPool = generalCookiePool.length

    // Limpar pools para forçar recarga (se necessário) - pode ser perigoso se não gerenciado
    // googleCookiePool = []; instagramCookiePool = []; twitterCookiePool = []; generalCookiePool = [];
    // console.log(`🧹 Pools de cookies limpos temporariamente`)

    // 4. Forçar coleta através de pressão de memória
    const tempArrays = []
    for (let i = 0; i < 100; i++) {
      // Criar arrays menores e mais numerosos para tentar forçar GC
      tempArrays.push(new Array(10000).fill(null))
    }
    tempArrays.length = 0 // Limpar o array que contém os arrays temporários

    // 5. Limpeza de objetos globais (com cautela)
    // Opcional: Remover ou limpar variáveis globais específicas se houver suspeita de vazamento

    // 6. Limpar arquivos temporários mais antigos (se aplicável)
    // cleanupOldFiles() // Já é chamado em outro lugar

    const after = process.memoryUsage()
    const totalFreed = Math.round((before.heapUsed - after.heapUsed) / 1024 / 1024)

    console.log(`🎯 Limpeza ultra-agressiva completa: ${totalFreed}MB liberados`)
    console.log(
      `📊 Antes: ${Math.round(before.heapUsed / 1024 / 1024)}MB → Depois: ${Math.round(after.heapUsed / 1024 / 1024)}MB`,
    )
  } catch (error) {
    console.log("❌ Erro na limpeza ultra-agressiva:", error.message)
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
    ultraAggressiveMemoryCleanup() // Usar a versão ultra-agressiva
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

  // Google Cookies - CORREÇÃO APLICADA
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

  // Instagram Cookies - CORREÇÃO APLICADA
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

  // 🐦 Twitter Cookies - CORREÇÃO APLICADA
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

// 🛡️ MIDDLEWARE DE SEGURANÇA - CORRIGIDO PARA MOBILE
app.use(
  helmet({
    contentSecurityPolicy: false,
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
)

// 🚨 CORS CONFIGURAÇÃO CRÍTICA - CORRIGIDA PARA MOBILE
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true)
      const allowedOrigins = [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "https://www.waifuconvert.com",
        "https://waifuconvert.com",
        "https://waifuconvert.vercel.app",
      ]
      if (allowedOrigins.indexOf(origin) !== -1 || origin.endsWith('.vercel.app')) {
        callback(null, true)
      } else {
        callback(null, true)
      }
    },
    credentials: true,
    optionsSuccessStatus: 200,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept", "Origin", "X-Requested-With", "User-Agent"],
    exposedHeaders: ["Content-Length", "Content-Type", "Content-Disposition"],
    preflightContinue: false,
    maxAge: 86400,
  }),
)

// 🚨 CORS PREFLIGHT HANDLER - GARANTIR QUE SEMPRE RESPONDA (MOBILE FIX)
app.options("*", (req, res) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*")
  res.header("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS,HEAD")
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Content-Length, X-Requested-With, Accept, Origin, User-Agent",
  )
  res.header("Access-Control-Allow-Credentials", "true")
  res.header("Access-Control-Max-Age", "86400")
  res.sendStatus(204)
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

// 🧠 MIDDLEWARE PARA RASTREAR ATIVIDADE (SEM SLEEP MODE)
app.use((req, res, next) => {
  resourceEconomizer.updateActivity() // Atualizar atividade para o economizador de recursos
  lastActivity = Date.now() // Não relevante para o modo sleep, mas mantido para logs
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
      if (
        domain === "twitter.com" &&
        (hostname.includes("twitter") || hostname.includes("x.com") || hostname.includes("twimg"))
      )
        return true
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
    // Formato simples e compatível para áudio
    return "bestaudio/best"
  }

  const q = Number.parseInt(quality)

  // TikTok e Instagram: formato simples sem merge
  if (platform === "tiktok" || platform === "instagram") {
    if (q >= 720) return "best[height<=1080]/best"
    if (q >= 480) return "best[height<=720]/best"
    if (q >= 360) return "best[height<=480]/best"
    if (q >= 240) return "best[height<=360]/best"
    return "best[height<=240]/best"
  }

  // YouTube e outras: formato simplificado sem merge complexo
  if (q >= 720) return "best[height<=1080]/best"
  if (q >= 480) return "best[height<=720]/best"
  if (q >= 360) return "best[height<=480]/best"
  if (q >= 240) return "best[height<=360]/best"
  return "best[height<=240]/best"
}

// 🔧 COMANDO SEGURO CORRIGIDO - SEM IMPERSONATION E LEGENDAS OPCIONAIS
function buildSecureCommand(userAgent, cookieFile, platform) {
  const baseArgs = [
    "--no-update",
    "--user-agent",
    userAgent,
    "--no-playlist",
    "--no-check-certificates",
    "--extractor-retries",
    "3",
    "--fragment-retries",
    "3",
    "--retry-sleep",
    "2",
    "--no-call-home",
    "--geo-bypass",
    "--socket-timeout",
    "30",
  ]

  if (platform === "tiktok") {
    baseArgs.push("--no-part", "--concurrent-fragments", "1")
  }

  if (platform === "instagram") {
    baseArgs.push("--sleep-interval", "1", "--max-sleep-interval", "2")
  }

  if (platform === "twitter") {
    baseArgs.push("--sleep-interval", "1")
  }

  if (cookieFile) {
    baseArgs.push("--cookies", cookieFile)
  }

  return baseArgs
}

function isYouTubeCriticalError(errorMessage) {
  const criticalErrors = [
    "Did not get any data blocks",
    "ERROR: Did not get any data blocks",
    "unable to download video data", // Adicionado
    "no video formats found", // Adicionado
    "This video is unavailable",
    "Video unavailable",
    "This video has been removed",
    "This video is private",
  ]

  return criticalErrors.some((error) => errorMessage.toLowerCase().includes(error.toLowerCase()))
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

// 🎯 FUNÇÃO PARA DETECTAR ERROS DE ARQUIVO VAZIO NO YOUTUBE
function isYouTubeEmptyFileError(errorMessage) {
  const emptyFileErrors = [
    "did not get any data blocks", // Pode indicar arquivo vazio também
    "no data blocks received",
    "failed to download any fragments",
    "unable to download webpage",
    "File is too short", // Mais genérico, mas pode indicar falha
  ]
  return emptyFileErrors.some((error) => errorMessage.toLowerCase().includes(error.toLowerCase()))
}

// Classe para lidar com erros de arquivo vazio no YouTube com retries
class YouTubeEmptyFileHandler {
  static async handleEmptyFile(url, format, quality, userAgent, cookieFile, platform, outputPath) {
    console.log("🎯 YouTube Empty File Handler: Iniciando retries...")
    const maxRetries = 3
    let retryCount = 0
    let lastError = null

    while (retryCount < maxRetries) {
      retryCount++
      console.log(`🎯 YouTube Empty File Handler: Tentativa ${retryCount}/${maxRetries}`)

      try {
        // Recriar o comando com parâmetros ligeiramente diferentes ou mais agressivos
        const retryArgs = [
          ...buildSecureCommand(userAgent, cookieFile, platform),
          "-f",
          getFormatSelector(format, quality, platform),
          format === "mp3" ? "--extract-audio" : "--merge-output-format",
          format === "mp3" ? "mp3" : "mp4",
          format === "mp3" ? "--audio-quality" : "",
          format === "mp3" ? `${Number.parseInt(quality || "128")}k` : "",
          "--add-metadata",
          format === "mp4" ? "-o" : "",
          format === "mp4" ? outputPath : "",
          url,
        ].filter(Boolean) // Remover strings vazias

        // Tentar obter apenas o vídeo/áudio principal com mais retries
        const { stderr: downloadStderr } = await executeSecureCommand(ytDlpPath, retryArgs, {
          timeout: 300000, // 5 minutos para download retry
        })

        if (downloadStderr) {
          console.log("⚠️ stderror durante retry:", downloadStderr.substring(0, 100) + "...")
          if (isYouTubeCriticalError(downloadStderr)) {
            throw new Error(`YouTube critical error during retry: ${downloadStderr}`)
          }
        }

        // Verificar o arquivo novamente após o retry
        if (!fs.existsSync(outputPath)) {
          // Tentar encontrar o arquivo mais recente se outputPath não foi gerado diretamente
          const recentFilePath = findRecentFile(DOWNLOADS, Date.now(), [`.${format === "mp3" ? "mp3" : "mp4"}`])
          if (recentFilePath) {
            console.log(`🎯 Arquivo encontrado via findRecentFile: ${path.basename(recentFilePath)}`)
            const stats = fs.statSync(recentFilePath)
            if (stats.size < 1000) {
              throw new Error("Arquivo gerado no retry ainda está muito pequeno.")
            }
            return { success: true, filePath: recentFilePath, size: stats.size }
          } else {
            throw new Error("Arquivo ainda não foi criado após retry.")
          }
        } else {
          const stats = fs.statSync(outputPath)
          if (stats.size < 1000) {
            throw new Error("Arquivo gerado no retry ainda está muito pequeno.")
          }
          return { success: true, filePath: outputPath, size: stats.size }
        }
      } catch (error) {
        lastError = error
        console.error(`❌ Erro no YouTube Empty File Handler (Tentativa ${retryCount}):`, error.message)
        // Esperar um pouco antes da próxima tentativa
        await new Promise((resolve) => setTimeout(resolve, 3000 * retryCount)) // Backoff exponencial
      }
    }

    throw new Error(`Todas as tentativas de retry falharam. Último erro: ${lastError.message}`)
  }
}

// 🎯 MELHORANDO EXTRAÇÃO DE INFORMAÇÕES DE VÍDEO SEM JSON
async function getVideoInfoWithoutJson(url, userAgent, cookieFile, platform) {
  console.log(`[INFO_FALLBACK] Tentando extração sem JSON`)

  const args = ["--user-agent", userAgent, "--no-playlist", "--get-title", "--get-duration"]

  if (cookieFile && fs.existsSync(cookieFile)) {
    args.push("--cookies", cookieFile)
  }

  args.push(url)

  try {
    const { stdout } = await executeSecureCommand(ytDlpPath, args, { timeout: 30000 })
    const lines = stdout.split("\n").filter((line) => line.trim())

    if (lines.length >= 1) {
      return {
        title: lines[0] || "Video",
        duration: lines[1] ? parseDurationString(lines[1]) : 0,
        filesize: null,
      }
    }
  } catch (e) {
    console.log(`[INFO_FALLBACK_FAILED] ${e.message}`)
  }

  return {
    title: "Video",
    duration: 0,
    filesize: null,
  }
}

// 🎯 FUNÇÃO PARA TENTAR MÚLTIPLAS ESTRATÉGIAS DE DOWNLOAD (PARA YOUTUBE)
async function tryYouTubeDownloadStrategies(url, format, quality, uniqueId) {
  // Estratégias otimizadas para economia e compatibilidade
  const strategies = [
    { name: "Estratégia 1: Cookies + Headers Otimizados", useStrategy: 1, timeout: 45000 },
    { name: "Estratégia 2: Sem Cookies + Bypass", useStrategy: 2, timeout: 30000 },
    { name: "Estratégia 3: Modo Compatibilidade + Retries", useStrategy: 3, timeout: 60000 },
  ]

  let lastError = null

  for (const strategy of strategies) {
    try {
      console.log(`🎯 YouTube: Tentando ${strategy.name}`)

      const cookieFile = strategy.useStrategy === 2 ? null : getSmartCookie("youtube")
      const randomUA = getRandomUserAgent()

      console.log(`🍪 Cookie info para ${strategy.name}:`, {
        cookieFile: cookieFile ? path.basename(cookieFile) : "SEM COOKIES",
        exists: cookieFile ? fs.existsSync(cookieFile) : false,
      })

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

      // Primeiro, tentar obter informações (metadata)
      const jsonArgs = [...baseArgs, "-j", url]
      let data = null

      try {
        const { stdout: jsonStdout, stderr: jsonStderr } = await executeSecureCommand(ytDlpPath, jsonArgs, {
          timeout: strategy.timeout,
        })
        const jsonLine = jsonStdout.split("\n").find((line) => line.trim().startsWith("{"))
        if (!jsonLine) {
          // Se falhar ao obter JSON, tentar obter informações básicas
          console.log("⚠️ JSON não obtido, tentando obter título/duração...")
          data = await getVideoInfoWithoutJson(url, randomUA, cookieFile, "youtube")
          if (!data.title || data.title === "Video") {
            throw new Error("Não foi possível extrair título ou duração mesmo com fallback.")
          }
        } else {
          data = JSON.parse(jsonLine)
          console.log(`[JSON_PARSED] Título: ${data.title?.substring(0, 60)}`)
        }
      } catch (e) {
        console.log(`Erro ao obter JSON/metadata: ${e.message}. Tentando fallback...`)
        data = await getVideoInfoWithoutJson(url, randomUA, cookieFile, "youtube")
        if (!data.title || data.title === "Video") {
          throw new Error("Não foi possível extrair título ou duração mesmo com fallback.")
        }
      }

      // Verificar duração (agora com limite de 1 hora para economia)
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
      const { stderr: downloadStderr } = await executeSecureCommand(ytDlpPath, downloadArgs, {
        timeout: 300000, // 5 minutos para download
      })

      if (downloadStderr) {
        if (isYouTubeCriticalError(downloadStderr)) {
          console.error("❌ Erro CRÍTICO do YouTube detectado:", downloadStderr.substring(0, 200))
          throw new Error(`YouTube Critical Error: ${downloadStderr.substring(0, 300)}`)
        } else if (isNonCriticalError(downloadStderr)) {
          console.log("⚠️ Avisos não críticos ignorados:", downloadStderr.substring(0, 100) + "...")
        } else if (isYouTubeEmptyFileError(downloadStderr)) {
          // Tratar erro de arquivo vazio especificamente para YouTube
          throw new Error(`YouTube Empty File Error: ${downloadStderr.substring(0, 300)}`)
        }
      }

      // Verificar se arquivo foi criado e não está vazio
      let finalFilePath = outputPath
      if (!fs.existsSync(finalFilePath)) {
        finalFilePath = findRecentFile(DOWNLOADS, Date.now(), [`.${format === "mp3" ? "mp3" : "mp4"}`])
        if (!finalFilePath) {
          throw new Error("Arquivo não foi criado após download bem-sucedido")
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
      lastError = error
      console.log(`❌ YouTube: ${strategy.name} falhou: ${error.message}`)

      if (isYouTubeCriticalError(error.message)) {
        console.log(`🚨 Erro crítico do YouTube detectado: ${error.message.substring(0, 100)}`)
      } else if (isYouTubeEmptyFileError(error.message)) {
        console.log(`🎯 Erro de arquivo vazio do YouTube detectado.`)
      }

      // Se for o último método, lançar erro
      if (strategy === strategies[strategies.length - 1]) {
        let errorMsg = lastError.message
        if (isYouTubeCriticalError(errorMsg) || isYouTubeEmptyFileError(errorMsg)) {
          errorMsg =
            "YouTube bloqueou o download ou o vídeo está indisponível. Verifique os cookies ou tente outro vídeo."
        }

        throw new Error(`Todas as estratégias do YouTube falharam. Erro: ${errorMsg}`)
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
      // Usar mtime (tempo de modificação) como critério principal para arquivos baixados
      const fileTime = stats.mtime.getTime()
      const timeDiff = Math.abs(fileTime - timestamp)

      return timeDiff < 300000 && extensions.some((ext) => file.toLowerCase().endsWith(ext))
    })

    if (recentFiles.length > 0) {
      recentFiles.sort((a, b) => {
        const aTime = fs.statSync(path.join(baseDir, a)).mtime.getTime()
        const bTime = fs.statSync(path.join(baseDir, b)).mtime.getTime()
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
    const oneHourAgo = Date.now() - 60 * 60 * 1000 // Arquivos com mais de 1 hora

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

// 🛡️ ROTA PRINCIPAL OTIMIZADA COM CORREÇÃO YOUTUBE - SEM SLEEP MODE
app.post("/download", async (req, res) => {
  const startTime = Date.now()
  let downloadStarted = false

  try {
    console.log(`🌐 POST /download - CORS OK`)

    // Checar o modo de economia de recursos
    resourceEconomizer.checkEconomyMode()
    if (resourceEconomizer.isEconomyMode) {
      return res.status(503).json({
        error: "Servidor em modo de economia de recursos. Tente novamente mais tarde.",
        type: "economy_mode_active",
        details: `Servidor inativo há ${Math.floor((Date.now() - resourceEconomizer.lastRequest) / 60000)} minutos.`,
      })
    }

    if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
      return res.status(429).json({
        error: "Servidor ocupado no momento. Tente novamente em alguns minutos.",
        type: "server_busy",
        tip: "Muitas pessoas estão usando o serviço agora. 😊",
        queue_info: `${activeDownloads}/${MAX_CONCURRENT_DOWNLOADS} downloads ativos`,
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

    activeDownloads++
    downloadStarted = true
    console.log(`🚀 Downloads ativos: ${activeDownloads}/${MAX_CONCURRENT_DOWNLOADS}`)

    // Limpeza preventiva de memória antes do download
    if (activeDownloads === 1) {
      ultraAggressiveMemoryCleanup()
    }

    const detectedPlatform = detectPlatform(url)
    const cookieFile = getSmartCookie(detectedPlatform)
    const randomUA = getRandomUserAgent()
    const uniqueId = crypto.randomBytes(8).toString("hex")

    console.log("🎯 Nova requisição:", {
      url: url.substring(0, 50) + "...",
      format,
      quality,
      platform: detectedPlatform,
    })

    console.log("🍪 Cookie info:", {
      platform: detectedPlatform,
      cookieFile: cookieFile ? path.basename(cookieFile) : "NENHUM",
      cookieExists: cookieFile ? fs.existsSync(cookieFile) : false,
    })

    // Tentar obter metadata primeiro para validar e obter informações
    const jsonArgs = [...buildSecureCommand(randomUA, cookieFile, detectedPlatform), "-j", url]

    console.log(`[YT_DLP_JSON] Executando: yt-dlp com ${jsonArgs.length} argumentos`)

    let data
    try {
      const { stdout: jsonStdout, stderr: jsonStderr } = await executeSecureCommand(ytDlpPath, jsonArgs, {
        timeout: 30000, // REDUZIDO: 30 segundos para metadata
      })

      console.log(`[JSON_RESPONSE] Recebido ${jsonStdout.length} bytes`)

      try {
        const jsonLine = jsonStdout.split("\n").find((line) => line.trim().startsWith("{"))
        if (!jsonLine) {
          console.log(`[JSON_ERROR] JSON não encontrado, usando fallback`)
          data = await getVideoInfoWithoutJson(url, randomUA, cookieFile, detectedPlatform)
        } else {
          data = JSON.parse(jsonLine)
          console.log(`[JSON_PARSED] Título: ${data.title?.substring(0, 60)}`)
        }
      } catch (e) {
        console.log(`[JSON_PARSE_ERROR] ${e.message}, usando fallback`)
        data = await getVideoInfoWithoutJson(url, randomUA, cookieFile, detectedPlatform)
      }

      const durationCheck = checkDuration(data.duration)
      if (!durationCheck.allowed) {
        console.log("🚫 Vídeo rejeitado por duração:", durationCheck.message)
        return res.status(400).json({
          error: durationCheck.message,
          type: "duration_exceeded",
          video_duration: durationCheck.duration_formatted,
          max_duration: durationCheck.max_duration,
          suggestion: "Tente um vídeo mais curto (máximo 1 hora para economia)",
        })
      }

      if (data.filesize && data.filesize > MAX_FILE_SIZE) {
        return res.status(400).json({
          error: "Arquivo muito grande. Máximo permitido: 512MB",
          type: "file_too_large",
        })
      }

      const safeTitle = generateSecureFilename(data.title, quality, format, uniqueId)
      const outputPath = path.join(DOWNLOADS, safeTitle)

      console.log("📁 Arquivo aprovado:", {
        title: data.title.substring(0, 30) + "...",
        duration: durationCheck.duration_formatted,
        filename: safeTitle,
      })

      let downloadArgs
      if (format === "mp3") {
        const q = Number.parseInt(quality || "128")
        downloadArgs = [
          ...buildSecureCommand(randomUA, cookieFile, detectedPlatform),
          "-f",
          "bestaudio/best",
          "-x",
          "--audio-format",
          "mp3",
          "--audio-quality",
          `${q}k`,
          "-o",
          outputPath,
          url,
        ]
      } else {
        const formatSelector = getFormatSelector("mp4", quality, detectedPlatform)

        downloadArgs = [
          ...buildSecureCommand(randomUA, cookieFile, detectedPlatform),
          "-f",
          formatSelector,
          "-o",
          outputPath,
          url,
        ]
      }

      console.log("🚀 Iniciando download...")

      try {
        const { stdout: downloadStdout, stderr: downloadStderr } = await executeSecureCommand(ytDlpPath, downloadArgs, {
          timeout: 300000, // 5 minutos para download
        })

        if (downloadStderr) {
          if (isYouTubeCriticalError(downloadStderr)) {
            console.error("❌ Erro CRÍTICO do YouTube detectado:", downloadStderr.substring(0, 200))
            return res.status(500).json({
              error: "YouTube: Não foi possível baixar este vídeo",
              type: "youtube_critical_error",
              details: "O YouTube bloqueou o download ou o vídeo está indisponível",
              possible_causes: [
                "Cookies do YouTube expiraram",
                "YouTube detectou acesso automatizado",
                "Vídeo com restrições de região",
                "Formato de vídeo não disponível",
              ],
              suggestions: [
                "Aguarde alguns minutos e tente novamente",
                "Tente outro vídeo do YouTube",
                "Verifique se o vídeo está disponível publicamente",
              ],
            })
          } else if (isNonCriticalError(downloadStderr)) {
            console.log("⚠️ Avisos não críticos ignorados:", downloadStderr.substring(0, 100) + "...")
          }
        }

        let finalFilePath = outputPath
        if (!fs.existsSync(finalFilePath)) {
          finalFilePath = findRecentFile(DOWNLOADS, startTime, [`.${format === "mp3" ? "mp3" : "mp4"}`])
          if (!finalFilePath) {
            return res.status(500).json({ error: "Arquivo não foi criado após download bem-sucedido" })
          }
        }

        const actualFilename = path.basename(finalFilePath)
        const stats = fs.statSync(finalFilePath)

        // 🎯 CORREÇÃO YOUTUBE: Verificar arquivo vazio e tentar estratégias de retry
        if (stats.size < 1000) {
          console.log(`⚠️ Arquivo muito pequeno detectado: ${stats.size} bytes`)

          if (detectedPlatform === "youtube") {
            console.log("🎯 YouTube arquivo vazio - iniciando sistema de retry...")

            try {
              // Deletar arquivo vazio
              if (fs.existsSync(finalFilePath)) {
                fs.unlinkSync(finalFilePath)
              }

              // Tentar estratégias de retry para YouTube
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
                console.log("✅ YouTube retry bem-sucedido!")
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

                // Limpeza de memória após download
                ultraAggressiveMemoryCleanup()

                console.log("✅ Download YouTube corrigido:", {
                  platform: detectedPlatform,
                  downloadKey: downloadKey,
                  size: `${(newStats.size / 1024 / 1024).toFixed(2)} MB`,
                  duration: durationCheck.duration_formatted,
                  retry_success: true,
                })

                return res.json({
                  file: `/downloads/${downloadKey}`,
                  filename: `${data.title.substring(0, 50)} - ${format === "mp3" ? quality + "kbps" : quality + "p"}.${format === "mp3" ? "mp3" : "mp4"}`,
                  size: newStats.size,
                  title: data.title,
                  duration: data.duration,
                  duration_formatted: durationCheck.duration_formatted,
                  platform: detectedPlatform,
                  quality_achieved: format === "mp3" ? `${quality}kbps` : `${quality}p`,
                  used_cookies: !!cookieFile,
                  economy_mode: resourceEconomizer.isEconomyMode, // Assumindo que existe essa variável
                  youtube_retry_applied: true,
                  retry_success: true,
                })
              }
            } catch (retryError) {
              console.error("❌ Todas as tentativas de retry falharam:", retryError.message)
              return res.status(500).json({
                error: "YouTube: Arquivo vazio mesmo após múltiplas tentativas. Tente outro vídeo.",
                type: "youtube_empty_file",
                suggestion: "Este vídeo específico está com problemas. Tente outro vídeo do YouTube.",
                technical_details: retryError.message.substring(0, 200),
              })
            }
          } else {
            // Para outras plataformas, retornar erro normal
            return res.status(500).json({ error: "Arquivo gerado está corrompido ou vazio" })
          }
        }

        const downloadKey = `download_${crypto.randomBytes(16).toString("hex")}.${format === "mp3" ? "mp3" : "mp4"}`
        fileMap.set(downloadKey, {
          actualPath: finalFilePath,
          actualFilename: actualFilename,
          userFriendlyName: `${data.title.substring(0, 50)} - ${format === "mp3" ? quality + "kbps" : quality + "p"}.${format === "mp3" ? "mp3" : "mp4"}`,
          size: stats.size,
          created: Date.now(),
        })

        // Limpeza de memória após download
        ultraAggressiveMemoryCleanup()

        console.log("✅ Download concluído:", {
          platform: detectedPlatform,
          downloadKey: downloadKey,
          size: `${(stats.size / 1024 / 1024).toFixed(2)} MB`,
          duration: durationCheck.duration_formatted,
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
          economy_mode: resourceEconomizer.isEconomyMode, // Assumindo que existe essa variável
        })
      } catch (downloadError) {
        console.error("❌ Erro no download:", downloadError.message)

        if (isYouTubeCriticalError(downloadError.message)) {
          console.error("❌ Erro CRÍTICO do YouTube:", downloadError.message)
          return res.status(500).json({
            error: "YouTube: Não foi possível baixar este vídeo",
            type: "youtube_critical_error",
            details: "O YouTube bloqueou o download ou o vídeo está indisponível",
            possible_causes: [
              "Cookies do YouTube expiraram",
              "YouTube detectou acesso automatizado",
              "Vídeo com restrições de região",
              "Formato de vídeo não disponível",
            ],
            suggestions: [
              "Aguarde alguns minutos e tente novamente",
              "Tente outro vídeo do YouTube",
              "Verifique se o vídeo está disponível publicamente",
            ],
          })
        }

        // 🎯 CORREÇÃO YOUTUBE: Verificar se é erro de arquivo vazio
        if (detectedPlatform === "youtube" && isYouTubeEmptyFileError(downloadError.message)) {
          console.log("🎯 YouTube erro de arquivo vazio detectado - iniciando retry...")

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
              console.log("✅ YouTube retry após erro bem-sucedido!")

              const downloadKey = `download_${crypto.randomBytes(16).toString("hex")}.${format === "mp3" ? "mp3" : "mp4"}`
              fileMap.set(downloadKey, {
                actualPath: retryResult.filePath,
                actualFilename: path.basename(retryResult.filePath),
                userFriendlyName: `${data.title.substring(0, 50)} - ${format === "mp3" ? quality + "kbps" : quality + "p"}.${format === "mp3" ? "mp3" : "mp4"}`,
                size: retryResult.size,
                created: Date.now(),
              })

              ultraAggressiveMemoryCleanup()

              return res.json({
                file: `/downloads/${downloadKey}`,
                filename: `${data.title.substring(0, 50)} - ${format === "mp3" ? quality + "kbps" : quality + "p"}.${format === "mp3" ? "mp3" : "mp4"}`,
                size: retryResult.size,
                title: data.title,
                duration: data.duration,
                duration_formatted: durationCheck.duration_formatted,
                platform: detectedPlatform,
                quality_achieved: format === "mp3" ? `${quality}kbps` : `${quality}p`,
                used_cookies: !!cookieFile,
                economy_mode: resourceEconomizer.isEconomyMode, // Assumindo que existe essa variável
                youtube_retry_applied: true,
                retry_success: true,
              })
            }
          } catch (retryError) {
            console.error("❌ YouTube retry após erro falhou:", retryError.message)
            return res.status(500).json({
              error: "YouTube: Problema persistente com este vídeo. Tente outro.",
              type: "youtube_persistent_error",
              suggestion: "Este vídeo específico está com problemas. Tente outro vídeo do YouTube.",
            })
          }
        }

        if (isNonCriticalError(downloadError.message)) {
          console.log("⚠️ Erro não crítico detectado, tentando continuar...")
        } else if (isAuthenticationError(downloadError.message)) {
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
      console.error("❌ Erro no metadata:", error.message)

      if (isYouTubeCriticalError(error.message)) {
        console.error("❌ Erro CRÍTICO do YouTube no metadata:", error.message)
        return res.status(500).json({
          error: "YouTube: Não foi possível acessar este vídeo",
          type: "youtube_critical_error",
          details: "O YouTube bloqueou o acesso ou o vídeo está indisponível",
          possible_causes: [
            "Cookies do YouTube expiraram",
            "YouTube detectou acesso automatizado",
            "Vídeo com restrições de região",
            "Vídeo foi removido ou está privado",
          ],
          suggestions: [
            "Aguarde alguns minutos e tente novamente",
            "Tente outro vídeo do YouTube",
            "Verifique se o vídeo está disponível publicamente",
          ],
        })
      }

      if (isNonCriticalError(error.message)) {
        console.log("⚠️ Erro não crítico detectado, tentando continuar...")
      } else if (isAuthenticationError(error.message)) {
        if (detectedPlatform === "instagram") {
          return res.status(400).json({
            error: "Instagram requer login. Configure cookies via environment variables.",
            type: "instagram_auth_required",
            platform: "instagram",
          })
        } else if (detectedPlatform === "twitter") {
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
        return res.status(500).json({ error: "Falha ao obter informações do vídeo" })
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

      // Limpeza após finalizar download
      if (activeDownloads === 0) {
        setTimeout(() => {
          ultraAggressiveMemoryCleanup()
        }, 5000) // 5 segundos após último download
      }
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
      twitter: twitterCookiePool.length, // 🐦 INCLUÍDO TWITTER
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
    message:
      "🧪 Teste de Cookies Completo - RAILWAY MEMORY OPTIMIZATION + YOUTUBE FIX + COOKIE VALIDATION FIXED + TWITTER SUPPORT + ECONOMY MODE ENABLED!",
    timestamp: new Date().toISOString(),
    summary: {
      env_vars_found: envVarsFound,
      cookies_loaded: results.pools.google + results.pools.instagram + results.pools.twitter,
      files_created: Object.keys(results.cookie_files).length,
      twitter_nsfw_ready: results.pools.twitter > 0,
      youtube_fix_applied: "✅ Estratégias múltiplas de bypass implementadas",
      memory_optimization_applied: "🧠 Sistema de limpeza agressiva de memória ativado (Railway compatible)",
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
    status:
      "OK - SECURE + RAILWAY MEMORY OPTIMIZED + YOUTUBE FIX + COOKIE VALIDATION FIXED + TWITTER SUPPORT + ECONOMY MODE ENABLED!",
    version:
      "6.2.1 - RAILWAY MEMORY OPTIMIZATION + YOUTUBE BYPASS STRATEGIES + COOKIE VALIDATION FIXED + TWITTER SUPPORT + ECONOMY MODE ENABLED",
    timestamp: new Date().toISOString(),
    limits: {
      max_duration: formatDuration(MAX_DURATION), // 2 horas
      max_file_size: "512MB", // Reduzido
      rate_limit: "20 downloads a cada 10 minutos",
      concurrent: "4 downloads simultâneos", // Reduzido
    },
    memory_optimization: {
      gc_available: typeof global.gc !== "undefined",
      railway_workaround: typeof global.gc === "undefined" ? "Manual cleanup active" : "Native GC active",
      current_memory: memoryStats,
      sleep_mode_enabled: false, // Desativado
      sleep_mode_tolerance: "N/A",
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
      "🧠 Aggressive cleanup on high memory usage",
      "🧠 No sleep mode",
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
      "🛡️ WaifuConvert Backend - RAILWAY MEMORY OPTIMIZED + YOUTUBE FIX + COOKIE VALIDATION FIXED + TWITTER SUPPORT + ECONOMY MODE ENABLED!",
    version: "6.2.1",
    status: "online - security active + railway memory optimized + youtube fix + cookie fix + economy mode enabled",
    security_level: "HIGH",
    limits: {
      duration: "2 horas máximo (MP3/MP4, qualquer qualidade)",
      file_size: "512MB máximo", // Reduzido
      rate_limit: "20 downloads a cada 10 minutos",
      concurrent: "4 downloads simultâneos", // Reduzido
    },
    quality_support: {
      mp3: "64kbps - 320kbps",
      mp4: "144p, 360p, 480p, 720p, 1080p",
    },
    memory_features: [
      "🧠 Railway-compatible garbage collection",
      "🧠 Multiple cleanup methods (native + manual)",
      "🧠 Memory usage monitoring",
      "🧠 Automatic cleanup triggered by high memory",
      "🧠 Aggressive cleanup before downloads",
      "🧠 No sleep mode active",
      "🧠 Memory limit enforcement (approx. 256MB)",
      "🧠 Real-time memory alerts",
      "🧠 Aggressive manual cleanup when GC unavailable",
    ],
    cors_features: [
      "🚨 Robust CORS configuration",
      "🚨 Explicit preflight handler",
      "🚨 No sleep mode compatibility needed",
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
      "🎯 Empty file error handler with retries",
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
      "🎯 System for fallback on blocked YouTube content",
      "🎯 Auto yt-dlp update system",
      "🧠 Railway memory optimization system implemented",
      "🧠 Multiple GC methods for compatibilidade Railway",
      "🚨 CORS sleep mode issue RESOLVIDO (sleep mode disabled)",
      "🚨 Explicit preflight handler added",
      "✅ Max concurrent downloads reduced to 4",
      "✅ Max file size reduced to 512MB",
      "✅ Max duration set to 1 hour for economy mode",
    ],
    features: [
      "✅ Input validation & sanitization",
      "✅ Command injection protection",
      "✅ Rate limiting (20 downloads/10min)",
      "✅ Duration limits (1h max for economy, 2h standard)",
      "✅ Concurrent download limits",
      "✅ Domain whitelist protection",
      "✅ Security headers (Helmet)",
      "✅ Safe cookie management",
      "✅ Fixed cookie validation for Netscape format",
      "🎯 Advanced YouTube bypass system",
      "🧠 Railway-intelligent memory management",
      "🚨 Robust CORS configuration",
      "⚡ Economy mode enabled",
    ],
    platform_support: {
      tiktok: "✅ Working perfectly",
      twitter: `🐦 Working with ${twitterCookiePool.length} dedicated cookies + ${googleCookiePool.length} fallback`,
      instagram: `✅ Working with ${instagramCookiePool.length} cookies`,
      youtube: `🎯 FIXED - Working with advanced bypass strategies + ${googleCookiePool.length} cookies`,
    },
    debug_endpoints: [
      "🧪 /test-cookies - Diagnóstico completo de cookies (incluindo Twitter)",
      "❤️ /health - Status do sistema",
      "🧠 /memory - Status de memória em tempo real (Railway compatible)",
    ],
    railway_optimizations: [
      "🚀 NODE_OPTIONS compatibility check",
      "🚀 Multiple GC fallback methods",
      "🚀 Aggressive manual cleanup",
      "🚀 Memory pressure detection",
      "🚀 No sleep mode",
      "🚨 CORS configuration active without sleep mode concerns",
    ],
    economy_mode: {
      enabled: true,
      description: "Recursos otimizados para menor consumo de memória e CPU.",
      limits: {
        max_duration: "1 hora", // Limite menor em modo de economia
      },
    },
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

// 🧠 LIMPEZA AUTOMÁTICA DE ARQUIVOS E MEMÓRIA - OTIMIZADO PARA ECONOMIA
// Intervalos ajustados para economia e sem sleep mode
const FILE_CLEANUP_INTERVAL = 15 * 60 * 1000 // Limpar arquivos a cada 15 minutos
const MEMORY_CLEANUP_INTERVAL = 5 * 60 * 1000 // Limpeza de memória a cada 5 minutos

// Iniciar os intervalos de limpeza
fileCleanupInterval = setInterval(cleanupOldFiles, FILE_CLEANUP_INTERVAL)
memoryCleanupInterval = setInterval(() => {
  console.log("🧠 Limpeza de memória periódica iniciada...")
  ultraAggressiveMemoryCleanup()
  logMemoryUsage()
}, MEMORY_CLEANUP_INTERVAL)

// Remover a lógica de sleep mode baseada em `lastActivity`
// O servidor agora roda continuamente com limpeza periódica.

app.listen(PORT, async () => {
  console.log(
    "🛡️ WaifuConvert Backend - RAILWAY MEMORY OPTIMIZED + YOUTUBE FIX + COOKIE VALIDATION FIXED + TWITTER SUPPORT + ECONOMY MODE ENABLED!",
  )
  console.log(`🌐 Porta: ${PORT}`)

  // 🧠 VERIFICAR VARIÁVEIS DE OTIMIZAÇÃO DE MEMÓRIA NA INICIALIZAÇÃO - RAILWAY
  checkOptimizationVariables()

  console.log("🔒 RECURSOS DE SEGURANÇA ATIVADOS:")
  console.log("  ✅ Validação rigorosa de entrada")
  console.log("  ✅ Proteção contra command injection")
  console.log("  ✅ Rate limiting inteligente")
  console.log("  ✅ Limite de duração: 1 hora (economia), 2 horas (padrão)")
  console.log("  ✅ Contador de downloads corrigido")
  console.log("  ✅ Suporte a 144p adicionado")
  console.log("  ✅ Tratamento de erros não críticos")
  console.log("  ✅ Sistema de debug de cookies")
  console.log("  🐦 Suporte completo ao Twitter NSFW")
  console.log("  🔧 CORREÇÃO APLICADA: Validação de cookies Netscape")
  console.log("  🎯 YOUTUBE FIX: Estratégias múltiplas de bypass + retry")
  console.log("  🎯 Auto-atualização do yt-dlp")
  console.log("  🧠 RAILWAY MEMORY OPTIMIZATION: Sistema de limpeza agressiva")
  console.log("  🧠 Múltiplos métodos de GC (nativo + manual)")
  console.log("  🧠 Limpeza automática a cada 5 minutos")
  console.log("  🧠 Sem sleep mode")
  console.log("  🚨 CORS SLEEP MODE FIX: Configuração robusta (sleep mode desativado)")
  console.log("  🚨 Explicit preflight handler")
  console.log("  ✅ Whitelist de domínios")
  console.log("  ✅ Limites de recursos (512MB, 4 downloads)")
  console.log("  ✅ Execução segura de comandos")
  console.log("  ✅ Gerenciamento seguro de arquivos")
  console.log("  ⚡ Modo de economia ativado")

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

  console.log("🎯 LIMITES DE ECONOMIA:")
  console.log(`  📹 Duração máxima (economia): 1 hora`)
  console.log(`  📁 Tamanho máximo (economia): 512MB`)
  console.log(`  🚀 Downloads simultâneos: 4`)

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
  console.log("  🎯 Tratamento de erro de arquivo vazio com retries")

  console.log("🧠 RECURSOS DE MEMÓRIA RAILWAY:")
  console.log("  🧠 Limpeza automática a cada 5 minutos")
  console.log("  🧠 Múltiplos métodos de GC (nativo + manual)")
  console.log("  🧠 Limpeza agressiva quando GC indisponível")
  console.log("  🧠 Monitoramento de uso de RAM")
  console.log("  🧠 Sem sleep mode")
  console.log("  🧠 Limite de memória: ~256MB")
  console.log("  🧠 Alertas de alto uso de memória")
  console.log("  🧠 Cache cleanup automático")

  console.log("🚨 RECURSOS DE CORS:")
  console.log("  🚨 Configuração robusta (sem sleep mode issues)")
  console.log("  🚨 Explicit preflight handler")
  console.log("  🚨 Sem sleep mode para evitar problemas de CORS")

  console.log("🔧 CORREÇÕES CRÍTICAS APLICADAS:")
  console.log("  ✅ Removida verificação incorreta de '=' nos cookies")
  console.log("  ✅ Cookies Netscape agora carregam corretamente")
  console.log("  🎯 YouTube bypass strategies implementadas + retries")
  console.log("  🎯 Sistema de fallback para YouTube bloqueado")
  console.log("  🧠 Sistema de otimização de memória Railway implementado")
  console.log("  🧠 Múltiplos métodos de GC para compatibilidade Railway")
  console.log("  🚨 CORS sleep mode issue RESOLVIDO (sleep mode desativado)")
  console.log("  🚨 Preflight handler explícito adicionado")
  console.log("  ⚡ Modo de economia ativado")
  console.log("  🚀 Limites reduzidos (downloads, tamanho, duração)")

  console.log("🔍 ENDPOINTS DE DEBUG:")
  console.log("  🧪 /test-cookies - Diagnóstico completo")
  console.log("  ❤️ /health - Status do sistema")
  console.log("  🧠 /memory - Status de memória em tempo real (Railway compatible)")

  // 🧠 LOG INICIAL DE MEMÓRIA E TESTE DE LIMPEZA
  console.log("🧠 Status inicial de memória:")
  logMemoryUsage()

  console.log("🧪 Testando limpeza agressiva na inicialização...")
  ultraAggressiveMemoryCleanup()

  console.log("🚨 CORS configurado para:")
  console.log("  🌐 https://www.waifuconvert.com")
  console.log("  🌐 https://waifuconvert.com")
  console.log("  🌐 https://waifuconvert.vercel.app")
  console.log("  🛡️ Explicit preflight handler ativo")

  // Limpeza de arquivos antigos na inicialização
  cleanupOldFiles()
})

process.on("uncaughtException", (error) => {
  console.error("❌ Erro não capturado:", error.message)
  console.log("🧠 Limpeza de emergência antes de sair...")
  ultraAggressiveMemoryCleanup()
  process.exit(1)
})

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Promise rejeitada:", reason)
})

// Limpeza de intervalos quando o processo é encerrado
function cleanupIntervals() {
  if (memoryCleanupInterval) clearInterval(memoryCleanupInterval)
  if (fileCleanupInterval) clearInterval(fileCleanupInterval)
  console.log("🧹 Intervalos de limpeza encerrados.")
}

process.on("SIGTERM", () => {
  console.log("🛑 Recebido SIGTERM, encerrando graciosamente...")
  cleanupIntervals()
  ultraAggressiveMemoryCleanup()
  process.exit(0)
})

process.on("SIGINT", () => {
  console.log("🛑 Recebido SIGINT, encerrando graciosamente...")
  cleanupIntervals()
  ultraAggressiveMemoryCleanup()
  process.exit(0)
})
