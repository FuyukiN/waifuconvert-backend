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

// CONFIAR NO RAILWAY PROXY PARA RATE LIMITING CORRETO
app.set("trust proxy", true)

// CONFIGURACOES OTIMIZADAS PARA ECONOMIA
const PORT = process.env.PORT || 8080
const MAX_CONCURRENT_DOWNLOADS = 3 // REDUZIDO para economia
const MAX_FILE_SIZE = 400 * 1024 * 1024 // 400MB (reduzido)
const MAX_DURATION = 3600 // 1 HORA para economia

// SISTEMA DE LIMPEZA AGRESSIVA DE MEMORIA
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
    console.log(`MODO ECONOMIA ATIVADO - servidor inativo ha ${inactiveMinutes}min`)
    ultraAggressiveMemoryCleanup()
  }

  exitEconomyMode() {
    if (!this.isEconomyMode) return
    this.isEconomyMode = false
    console.log(`MODO NORMAL ATIVADO - nova requisicao detectada`)
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

// FUNCAO PARA GARBAGE COLLECTION FORCADO - RAILWAY COMPATIBLE
function forceGarbageCollection() {
  try {
    if (typeof global.gc === "function") {
      const before = process.memoryUsage().heapUsed
      global.gc()
      const after = process.memoryUsage().heapUsed
      const freed = Math.round((before - after) / 1024 / 1024)
      console.log(`GC (Method 1): Liberados ${freed}MB de RAM`)
      return freed
    }

    try {
      const v8 = require("v8")
      if (v8.getHeapStatistics) {
        const before = process.memoryUsage().heapUsed

        if (global.gc) {
          global.gc()
        } else {
          const dummy = new Array(1000000).fill("x")
          dummy.length = 0
        }

        const after = process.memoryUsage().heapUsed
        const freed = Math.round((before - after) / 1024 / 1024)
        console.log(`GC (Method 2): Liberados ${freed}MB de RAM`)
        return freed
      }
    } catch (v8Error) {
      console.log("V8 method failed:", v8Error.message)
    }

    console.log("GC nao disponivel - usando limpeza manual agressiva")

    if (global.Buffer) {
      global.Buffer.poolSize = 1
    }

    const before = process.memoryUsage().heapUsed

    for (let i = 0; i < 100; i++) {
      const temp = new Array(10000).fill(null)
      temp.length = 0
    }

    const after = process.memoryUsage().heapUsed
    const freed = Math.round((before - after) / 1024 / 1024)
    console.log(`Manual cleanup: ${freed}MB liberados`)
    return freed
  } catch (error) {
    console.log("Erro na limpeza de memoria:", error.message)
    return 0
  }
}

// FUNCAO DE LIMPEZA ULTRA-AGRESSIVA (PARA DOWNLOADS)
function ultraAggressiveMemoryCleanup() {
  console.log("=== LIMPEZA ULTRA-AGRESSIVA DE MEMORIA ===")
  const before = process.memoryUsage()

  try {
    forceGarbageCollection()

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
        "v8",
      ]
      let clearedCount = 0
      cacheKeys.forEach((key) => {
        const isEssential = essentialModules.some((mod) => key.includes(mod))
        if (!isEssential && !key.includes("node_modules") && key.startsWith(process.cwd())) {
          try {
            delete require.cache[key]
            clearedCount++
          } catch (e) {
            // Ignorar erros de limpeza
          }
        }
      })
      console.log(`Modulos do cache limpos: ${clearedCount}`)
    }

    const tempArrays = []
    for (let i = 0; i < 100; i++) {
      tempArrays.push(new Array(10000).fill(null))
    }
    tempArrays.length = 0

    const after = process.memoryUsage()
    const totalFreed = Math.round((before.heapUsed - after.heapUsed) / 1024 / 1024)

    console.log(`Limpeza ultra-agressiva completa: ${totalFreed}MB liberados`)
    console.log(
      `Antes: ${Math.round(before.heapUsed / 1024 / 1024)}MB -> Depois: ${Math.round(after.heapUsed / 1024 / 1024)}MB`,
    )
  } catch (error) {
    console.log("Erro na limpeza ultra-agressiva:", error.message)
  }
}

// MONITORAMENTO DE MEMORIA APRIMORADO
function logMemoryUsage() {
  const used = process.memoryUsage()
  const mb = (bytes) => Math.round(bytes / 1024 / 1024)

  console.log(`RAM: ${mb(used.heapUsed)}MB heap / ${mb(used.rss)}MB total`)
  console.log(`External: ${mb(used.external)}MB / ArrayBuffers: ${mb(used.arrayBuffers)}MB`)

  if (used.heapUsed > 200 * 1024 * 1024) {
    console.log("Alto uso de RAM - forcando limpeza...")
    ultraAggressiveMemoryCleanup()
  }

  return {
    heapUsed: mb(used.heapUsed),
    rss: mb(used.rss),
    external: mb(used.external),
    arrayBuffers: mb(used.arrayBuffers),
  }
}

// VERIFICAR VARIAVEIS DE OTIMIZACAO NA INICIALIZACAO - RAILWAY DEBUG
function checkOptimizationVariables() {
  console.log("=== VERIFICACAO DE OTIMIZACAO DE MEMORIA (RAILWAY) ===")
  console.log(`NODE_ENV: ${process.env.NODE_ENV || "NAO DEFINIDO"}`)
  console.log(`NODE_OPTIONS: ${process.env.NODE_OPTIONS || "NAO DEFINIDO"}`)
  console.log(`MAX_OLD_SPACE_SIZE: ${process.env.MAX_OLD_SPACE_SIZE || "NAO DEFINIDO"}MB`)

  const gcMethods = []

  if (typeof global.gc === "function") {
    gcMethods.push("global.gc() disponivel")
  } else {
    gcMethods.push("global.gc() nao disponivel")
  }

  try {
    const v8 = require("v8")
    if (v8.getHeapStatistics) {
      gcMethods.push("V8 heap statistics disponivel")
    }
  } catch (e) {
    gcMethods.push("V8 nao disponivel")
  }

  console.log("Metodos de GC disponiveis:")
  gcMethods.forEach((method) => console.log(`   ${method}`))

  if (typeof global.gc === "undefined") {
    console.log("RAILWAY ISSUE: NODE_OPTIONS pode nao estar sendo aplicado corretamente")
    console.log("WORKAROUND: Usando metodos alternativos de limpeza de memoria")
    console.log("TESTE: Executando limpeza manual...")

    const freed = forceGarbageCollection()
    console.log(`Teste de limpeza: ${freed}MB processados`)
  } else {
    console.log("GC esta funcionando - otimizacao ativa!")
    forceGarbageCollection()
  }

  console.log("============================================")
}

// LIMPEZA AGRESSIVA DE MEMORIA PARA RAILWAY
function aggressiveMemoryCleanup() {
  console.log("=== LIMPEZA AGRESSIVA DE MEMORIA ===")

  const before = process.memoryUsage()

  try {
    const gcFreed = forceGarbageCollection()

    if (require.cache) {
      const cacheKeys = Object.keys(require.cache)
      console.log(`Limpando ${cacheKeys.length} modulos do cache`)

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

    if (global.Buffer && global.Buffer.poolSize > 1) {
      global.Buffer.poolSize = 1
      console.log("Buffer pool size reduzido")
    }

    const tempArrays = []
    for (let i = 0; i < 50; i++) {
      tempArrays.push(new Array(1000).fill(null))
    }
    tempArrays.length = 0

    const after = process.memoryUsage()
    const totalFreed = Math.round((before.heapUsed - after.heapUsed) / 1024 / 1024)

    console.log(`Limpeza completa: ${totalFreed}MB liberados`)
    console.log(
      `Antes: ${Math.round(before.heapUsed / 1024 / 1024)}MB -> Depois: ${Math.round(after.heapUsed / 1024 / 1024)}MB`,
    )

    return totalFreed
  } catch (error) {
    console.log("Erro na limpeza agressiva:", error.message)
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

// CONTADOR DE DOWNLOADS ATIVOS
let activeDownloads = 0

// COOKIES ESSENCIAIS PARA TWITTER NSFW
const TWITTER_ESSENTIAL_COOKIES = [
  "auth_token",
  "ct0",
  "twid",
  "att",
  "personalization_id",
]

// CORRECAO YOUTUBE: User-Agents mais recentes e variados
const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/122.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:123.0) Gecko/20100101 Firefox/123.0",
]

// CORRECAO YOUTUBE: Funcao para atualizar yt-dlp automaticamente
async function ensureYtDlpUpdated() {
  try {
    console.log("Verificando/atualizando yt-dlp...")

    await executeSecureCommand("pip", ["install", "--upgrade", "yt-dlp"], { timeout: 60000 })
    console.log("yt-dlp atualizado com sucesso")

    const { stdout } = await executeSecureCommand("yt-dlp", ["--version"], { timeout: 10000 })
    console.log(`Versao do yt-dlp: ${stdout.trim()}`)

    return true
  } catch (error) {
    console.log("Nao foi possivel atualizar yt-dlp:", error.message)
    return false
  }
}

// =====================================================
// CORRECAO PRINCIPAL: FORMATO H.264 PARA YOUTUBE
// =====================================================
// O problema do AV1 e que o YouTube agora serve AV1 como "melhor" formato
// mas muitos players nao suportam AV1. Forcamos H.264 (avc1) que e universal.

// SELETOR DE FORMATO CORRIGIDO - FORCA H.264 (AVC) EM VEZ DE AV1
function getFormatSelector(format, quality, platform) {
  // Para MP3/audio: bestaudio com fallbacks
  if (format === "mp3") {
    return "bestaudio[acodec^=mp4a]/bestaudio/best"
  }

  // Para YouTube: FORCAR H.264 (avc1) - NAO AV1!
  // AV1 (av01) nao reproduz em muitos players
  // H.264 (avc1) e universal e funciona em todos os players
  if (platform === "youtube") {
    // Formato que FORCA H.264 e exclui AV1
    // bestvideo[vcodec^=avc1] = melhor video com codec H.264
    // bestaudio[acodec^=mp4a] = melhor audio AAC
    return "bestvideo[vcodec^=avc1][height<=1080]+bestaudio[acodec^=mp4a]/bestvideo[vcodec^=avc1]+bestaudio/best[vcodec^=avc1]/best"
  }
  
  // Para outras plataformas
  return "best"
}

// SELETOR DE FORMATO ULTRA SIMPLES (FALLBACK FINAL)
function getSimpleFormatSelector(format) {
  if (format === "mp3") {
    return "bestaudio[ext=m4a]/bestaudio/best"
  }
  // Fallback: ainda tenta H.264 primeiro, depois qualquer coisa
  return "bestvideo[vcodec^=avc1]+bestaudio/best"
}

// =====================================================
// CORRECAO: PLAYER CLIENTS DO YOUTUBE
// =====================================================
// tv_embedded foi BLOQUEADO pelo YouTube em Janeiro 2026
// Usar apenas "web" ou "ios" que ainda funcionam

// ESTRATEGIAS DE BYPASS PARA YOUTUBE - CORRIGIDAS
class YouTubeBypassStrategies {
  // Estrategia 1: Com cookies + headers otimizados
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
      "3",
      "--fragment-retries",
      "3",
      "--retry-sleep",
      "2",
      "--no-warnings",
      "--no-playlist",
      "--geo-bypass",
      "--ignore-errors",
      // CORRECAO: Usar apenas "web" - tv_embedded foi bloqueado!
      "--extractor-args",
      "youtube:player_client=web",
    ]

    if (cookieFile) {
      args.push("--cookies", cookieFile)
    }

    return args
  }

  // Estrategia 2: Sem cookies + bypass
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
      // CORRECAO: Usar apenas "web"
      "--extractor-args",
      "youtube:player_client=web",
    ]
  }

  // Estrategia 3: Modo compatibilidade + retries
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
      "5",
      "--fragment-retries",
      "5",
      "--retry-sleep",
      "5",
      "--no-warnings",
      "--no-playlist",
      "--geo-bypass",
      "--ignore-errors",
      // CORRECAO: Usar apenas "web"
      "--extractor-args",
      "youtube:player_client=web",
    ]

    if (cookieFile) {
      args.push("--cookies", cookieFile)
    }

    return args
  }
}

// FUNCAO SIMPLES PARA VERIFICAR DURACAO
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
      message: `Video muito longo! Maximo: ${maxFormatted}. Seu video: ${durationFormatted}`,
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

// FUNCAO PARA VALIDAR FORMATO DE COOKIES
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

    if (!line || line.startsWith("#")) {
      return
    }

    const fields = line.split("\t")

    if (fields.length >= 6) {
      validLines++

      if (!fields[0].includes(".")) {
        issues.push(`Linha ${index + 1}: Dominio suspeito: ${fields[0]}`)
      }

      const expiration = Number.parseInt(fields[4])
      if (expiration && expiration < Date.now() / 1000) {
        issues.push(`Linha ${index + 1}: Cookie expirado: ${fields[5]}`)
      }
    } else {
      invalidLines++
      issues.push(`Linha ${index + 1}: Formato invalido (${fields.length} campos, precisa >= 6)`)
    }
  })

  return {
    valid: validLines > 0,
    validLines,
    invalidLines,
    issues,
    reason: validLines === 0 ? "Nenhuma linha valida encontrada" : null,
  }
}

// FUNCAO PARA VALIDAR COOKIES ESPECIFICOS DO TWITTER
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
    recommendation:
      criticalMissing.length === 0 ? "Pronto para NSFW" : "Faltam cookies criticos - faca login novamente",
  }
}

// FUNCAO PARA DEBUGAR SISTEMA DE COOKIES
function debugCookieSystem() {
  console.log("\n=== DIAGNOSTICO COMPLETO DE COOKIES ===")

  console.log("VARIAVEIS DE AMBIENTE:")
  let envVarsFound = 0

  // Google Cookies
  for (let i = 1; i <= 10; i++) {
    const envVar = `GOOGLE_COOKIE_${i.toString().padStart(2, "0")}`
    const cookieContent = process.env[envVar]

    if (cookieContent) {
      envVarsFound++
      console.log(`${envVar}: ${cookieContent.length} caracteres`)

      const validation = validateCookieFormat(cookieContent, envVar)
      if (validation.valid) {
        console.log(`   Formato: OK (${validation.validLines} linhas validas)`)
      } else {
        console.log(`   Formato: ${validation.reason}`)
        validation.issues.slice(0, 3).forEach((issue) => console.log(`   ${issue}`))
      }

      console.log(`   Preview: ${cookieContent.substring(0, 80)}...`)
    }
  }

  // Instagram Cookies
  for (let i = 1; i <= 8; i++) {
    const envVar = `INSTAGRAM_COOKIE_${i.toString().padStart(2, "0")}`
    const cookieContent = process.env[envVar]

    if (cookieContent) {
      envVarsFound++
      console.log(`${envVar}: ${cookieContent.length} caracteres`)

      const validation = validateCookieFormat(cookieContent, envVar)
      if (validation.valid) {
        console.log(`   Formato: OK (${validation.validLines} linhas validas)`)
      } else {
        console.log(`   Formato: ${validation.reason}`)
      }
    }
  }

  // Twitter Cookies
  for (let i = 1; i <= 5; i++) {
    const envVar = `TWITTER_COOKIE_${i.toString().padStart(2, "0")}`
    const cookieContent = process.env[envVar]

    if (cookieContent) {
      envVarsFound++
      console.log(`${envVar}: ${cookieContent.length} caracteres`)

      const validation = validateCookieFormat(cookieContent, envVar)
      const twitterValidation = validateTwitterCookies(cookieContent)

      if (validation.valid) {
        console.log(`   Formato: OK (${validation.validLines} linhas validas)`)
      } else {
        console.log(`   Formato: ${validation.reason}`)
      }

      console.log(`   Twitter: ${twitterValidation.recommendation}`)
      if (twitterValidation.criticalMissing.length > 0) {
        console.log(`   Faltam criticos: ${twitterValidation.criticalMissing.join(", ")}`)
      }
    }
  }

  console.log(`Total de variaveis encontradas: ${envVarsFound}`)

  // Verificar arquivos criados
  console.log("\nARQUIVOS DE COOKIE:")
  try {
    if (fs.existsSync(COOKIES_DIR)) {
      const files = fs.readdirSync(COOKIES_DIR).filter((f) => f.endsWith(".txt"))

      if (files.length === 0) {
        console.log("Nenhum arquivo de cookie encontrado")
      } else {
        files.forEach((file) => {
          const filepath = path.join(COOKIES_DIR, file)
          const stats = fs.statSync(filepath)
          const content = fs.readFileSync(filepath, "utf8")
          const validation = validateCookieFormat(content, file)

          console.log(`${file}:`)
          console.log(`   Tamanho: ${stats.size} bytes`)
          console.log(`   Linhas: ${content.split("\n").length}`)
          console.log(`   ${validation.valid ? "OK" : "ERRO"} Formato: ${validation.valid ? "OK" : validation.reason}`)

          if (file.startsWith("twitter_")) {
            const twitterValidation = validateTwitterCookies(content)
            console.log(`   NSFW: ${twitterValidation.nsfwReady ? "PRONTO" : "FALTAM COOKIES"}`)
          }

          if (validation.issues.length > 0) {
            console.log(`   Problemas: ${validation.issues.length}`)
          }
        })
      }
    } else {
      console.log("Diretorio de cookies nao existe")
    }
  } catch (error) {
    console.error("Erro ao ler cookies:", error.message)
  }

  // Verificar pools
  console.log("\nPOOLS DE COOKIES:")
  console.log(`Google Pool: ${googleCookiePool.length} arquivos`)
  console.log(`Instagram Pool: ${instagramCookiePool.length} arquivos`)
  console.log(`Twitter Pool: ${twitterCookiePool.length} arquivos`)
  console.log(`General Pool: ${generalCookiePool.length} arquivos`)

  if (googleCookiePool.length === 0 && instagramCookiePool.length === 0 && twitterCookiePool.length === 0) {
    console.log("NENHUM COOKIE CARREGADO!")
    console.log("Verifique se as variaveis de ambiente estao corretas")
  }

  console.log("=== FIM DO DIAGNOSTICO ===\n")
}

// MIDDLEWARE DE SEGURANCA
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

// CORS CONFIGURACAO
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

// CORS PREFLIGHT HANDLER
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

// RATE LIMITING
const downloadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15,
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
    error: "Muitas requisicoes. Tente novamente em 1 minuto.",
    type: "rate_limit_exceeded",
  },
})

app.use(generalLimiter)
app.use("/download", downloadLimiter)

// MIDDLEWARE PARA RASTREAR ATIVIDADE
app.use((req, res, next) => {
  resourceEconomizer.updateActivity()
  lastActivity = Date.now()
  console.log(`Request: ${req.method} ${req.path} - Activity updated`)
  next()
})

// VALIDACAO DE URL SEGURA
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
      console.warn(`Dominio nao permitido: ${hostname}`)
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
      console.warn(`IP privado/local bloqueado: ${hostname}`)
      return false
    }

    return true
  } catch (error) {
    console.error("Erro na validacao de URL:", error.message)
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

// VALIDACAO DE PARAMETROS
function validateDownloadParams(url, format, quality) {
  const errors = []

  if (!url || typeof url !== "string") {
    errors.push("Por favor, cole um link valido")
  } else if (!isValidUrl(url)) {
    try {
      const hostname = new URL(url).hostname.toLowerCase()
      if (hostname.includes("localhost") || hostname.startsWith("127.") || hostname.startsWith("192.168.")) {
        errors.push("Links locais nao sao permitidos por seguranca")
      } else {
        errors.push(
          `Este site nao e suportado ainda. Tente: TikTok, Twitter/X, Instagram, YouTube, Reddit, Facebook, Twitch, SoundCloud, Vimeo`,
        )
      }
    } catch {
      errors.push("Link invalido. Certifique-se de copiar a URL completa (com https://)")
    }
  }

  if (!format || !["mp3", "mp4"].includes(format)) {
    errors.push("Escolha MP3 (audio) ou MP4 (video)")
  }

  if (quality) {
    const q = Number.parseInt(quality)
    if (format === "mp3" && (q < 64 || q > 320)) {
      errors.push("Qualidade de audio deve estar entre 64 e 320 kbps")
    } else if (format === "mp4" && ![144, 240, 360, 480, 720, 1080].includes(q)) {
      errors.push("Qualidade de video deve ser 144p, 240p, 360p, 480p, 720p ou 1080p")
    }
  }

  return errors
}

function executeSecureCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || 600000

    console.log("Executando comando seguro:", command, args.slice(0, 3).join(" "), "...")

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
        reject(new Error(`Comando falhou com codigo ${code}: ${stderr}`))
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

// FUNCAO PARA CRIAR ARQUIVOS DE COOKIE
function createSecureCookieFiles() {
  console.log("Criando arquivos de cookie seguros...")

  if (!fs.existsSync(COOKIES_DIR)) {
    fs.mkdirSync(COOKIES_DIR, { recursive: true, mode: 0o700 })
  }

  let cookiesCreated = 0

  // Google Cookies
  for (let i = 1; i <= 10; i++) {
    const envVar = `GOOGLE_COOKIE_${i.toString().padStart(2, "0")}`
    const cookieContent = process.env[envVar]

    if (cookieContent) {
      console.log(`Processando ${envVar}: ${cookieContent.length} caracteres`)

      const filename = `google_conta${i.toString().padStart(2, "0")}.txt`
      const filepath = path.join(COOKIES_DIR, filename)

      if (cookieContent.length > 100) {
        const validation = validateCookieFormat(cookieContent, filename)

        fs.writeFileSync(filepath, cookieContent, { mode: 0o600 })
        console.log(`Cookie Google ${i} criado: ${filename}`)

        if (validation.valid) {
          console.log(`   Formato valido: ${validation.validLines} linhas`)
        } else {
          console.log(`   Formato suspeito: ${validation.reason}`)
        }

        cookiesCreated++
      } else {
        console.log(`Cookie ${envVar} muito pequeno: ${cookieContent.length} chars`)
      }
    }
  }

  // Instagram Cookies
  for (let i = 1; i <= 8; i++) {
    const envVar = `INSTAGRAM_COOKIE_${i.toString().padStart(2, "0")}`
    const cookieContent = process.env[envVar]

    if (cookieContent) {
      console.log(`Processando ${envVar}: ${cookieContent.length} caracteres`)

      const filename = `instagram_conta${i.toString().padStart(2, "0")}.txt`
      const filepath = path.join(COOKIES_DIR, filename)

      if (cookieContent.length > 100) {
        const validation = validateCookieFormat(cookieContent, filename)

        fs.writeFileSync(filepath, cookieContent, { mode: 0o600 })
        console.log(`Cookie Instagram ${i} criado: ${filename}`)

        if (validation.valid) {
          console.log(`   Formato valido: ${validation.validLines} linhas`)
        } else {
          console.log(`   Formato suspeito: ${validation.reason}`)
        }

        cookiesCreated++
      } else {
        console.log(`Cookie ${envVar} muito pequeno: ${cookieContent.length} chars`)
      }
    }
  }

  // Twitter Cookies
  for (let i = 1; i <= 5; i++) {
    const envVar = `TWITTER_COOKIE_${i.toString().padStart(2, "0")}`
    const cookieContent = process.env[envVar]

    if (cookieContent) {
      console.log(`Processando ${envVar}: ${cookieContent.length} caracteres`)

      const filename = `twitter_conta${i.toString().padStart(2, "0")}.txt`
      const filepath = path.join(COOKIES_DIR, filename)

      if (cookieContent.length > 100) {
        const validation = validateCookieFormat(cookieContent, filename)
        const twitterValidation = validateTwitterCookies(cookieContent)

        fs.writeFileSync(filepath, cookieContent, { mode: 0o600 })
        console.log(`Cookie Twitter ${i} criado: ${filename}`)

        if (validation.valid) {
          console.log(`   Formato valido: ${validation.validLines} linhas`)
        } else {
          console.log(`   Formato suspeito: ${validation.reason}`)
        }

        console.log(`   ${twitterValidation.recommendation}`)
        if (twitterValidation.nsfwReady) {
          console.log(`   NSFW habilitado - cookies criticos presentes`)
        } else {
          console.log(`   NSFW nao disponivel - faltam: ${twitterValidation.criticalMissing.join(", ")}`)
        }

        cookiesCreated++
      } else {
        console.log(`Cookie ${envVar} muito pequeno: ${cookieContent.length} chars`)
      }
    }
  }

  console.log(`Total de cookies criados: ${cookiesCreated}`)

  setTimeout(() => {
    debugCookieSystem()
  }, 2000)

  return cookiesCreated
}

let googleCookiePool = []
let instagramCookiePool = []
let twitterCookiePool = []
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
    twitterCookiePool = files.filter((f) => f.startsWith("twitter_")).map((f) => path.join(COOKIES_DIR, f))
    generalCookiePool = files.map((file) => path.join(COOKIES_DIR, file))

    console.log(`Google cookies: ${googleCookiePool.length}`)
    console.log(`Instagram cookies: ${instagramCookiePool.length}`)
    console.log(`Twitter cookies: ${twitterCookiePool.length}`)
    console.log(`Total cookies: ${generalCookiePool.length}`)
  } catch (error) {
    console.error("Erro ao carregar cookies:", error)
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

// FUNCAO PARA SELECIONAR COOKIE
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
    console.log(`Nenhum cookie ${poolName} disponivel para ${platform}`)
    return null
  }

  const selected = pool[Math.floor(Math.random() * pool.length)]
  console.log(`Cookie selecionado para ${platform}: ${path.basename(selected)} (pool: ${poolName})`)

  if (platform === "twitter" && poolName === "Twitter") {
    console.log(`   Cookie Twitter especifico - NSFW habilitado`)
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

// COMANDO SEGURO - CORRIGIDO SEM OPCOES DEPRECATED
function buildSecureCommand(userAgent, cookieFile, platform) {
  const baseArgs = [
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
    "--geo-bypass",
    "--socket-timeout",
    "30",
    "--no-warnings",
    "--ignore-errors",
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

  // YouTube: Configuracao CORRIGIDA - sem tv_embedded bloqueado
  if (platform === "youtube") {
    baseArgs.push(
      // CORRECAO: Usar apenas "web" - tv_embedded foi bloqueado!
      "--extractor-args",
      "youtube:player_client=web",
      "--no-abort-on-error",
      "--ignore-no-formats-error"
    )
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
    "unable to download video data",
    "no video formats found",
    "This video is unavailable",
    "Video unavailable",
    "This video has been removed",
    "This video is private",
    "Sign in to confirm",
    "bot",
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
    "The following content is not available on this app",
    "Watch on the latest version of YouTube",
    "Could not authenticate you",
    "Error(s) while querying API",
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
    "Signature solving failed",
    "Deprecated Feature",
    "deprecated",
    "n challenge solving failed",
    "Only images are available",
  ]

  return nonCriticalErrors.some((error) => errorMessage.toLowerCase().includes(error.toLowerCase()))
}

function isFormatNotAvailableError(errorMessage) {
  return errorMessage.toLowerCase().includes("requested format is not available") ||
         errorMessage.toLowerCase().includes("no video formats found")
}

function isYouTubeEmptyFileError(errorMessage) {
  const emptyFileErrors = [
    "did not get any data blocks",
    "no data blocks received",
    "failed to download any fragments",
    "unable to download webpage",
    "File is too short",
  ]
  return emptyFileErrors.some((error) => errorMessage.toLowerCase().includes(error.toLowerCase()))
}

// Classe para lidar com erros de arquivo vazio no YouTube com retries
class YouTubeEmptyFileHandler {
  static async handleEmptyFile(url, format, quality, userAgent, cookieFile, platform, outputPath) {
    console.log("YouTube Empty File Handler: Iniciando retries...")
    const maxRetries = 3
    let retryCount = 0
    let lastError = null

    while (retryCount < maxRetries) {
      retryCount++
      console.log(`YouTube Empty File Handler: Tentativa ${retryCount}/${maxRetries}`)

      try {
        // Na primeira tentativa, usar formato H.264 especifico
        // Nas tentativas seguintes, usar formato simplificado
        const formatToUse = retryCount === 1 
          ? getFormatSelector(format, quality, platform)
          : getSimpleFormatSelector(format)
        
        console.log(`Usando formato: ${formatToUse}`)
        
        // Recriar o comando com parametros mais robustos
        const retryArgs = [
          ...buildSecureCommand(userAgent, cookieFile, platform),
          "-f",
          formatToUse,
          ...(format === "mp3" 
            ? ["-x", "--audio-format", "mp3", "--audio-quality", `${Number.parseInt(quality || "128")}k`]
            : ["--merge-output-format", "mp4"]),
          "--add-metadata",
          "-o",
          outputPath,
          url,
        ]

        const { stderr: downloadStderr } = await executeSecureCommand(ytDlpPath, retryArgs, {
          timeout: 300000,
        })

        if (downloadStderr) {
          console.log("stderror durante retry:", downloadStderr.substring(0, 100) + "...")
          
          if (isFormatNotAvailableError(downloadStderr) && retryCount < maxRetries) {
            console.log("Formato nao disponivel, tentando formato simplificado na proxima tentativa...")
            throw new Error("Formato nao disponivel, tentando fallback")
          }
          
          if (isYouTubeCriticalError(downloadStderr)) {
            throw new Error(`YouTube critical error during retry: ${downloadStderr}`)
          }
        }

        // Verificar o arquivo novamente apos o retry
        if (!fs.existsSync(outputPath)) {
          const recentFilePath = findRecentFile(DOWNLOADS, Date.now(), [`.${format === "mp3" ? "mp3" : "mp4"}`])
          if (recentFilePath) {
            console.log(`Arquivo encontrado via findRecentFile: ${path.basename(recentFilePath)}`)
            const stats = fs.statSync(recentFilePath)
            if (stats.size < 1000) {
              throw new Error("Arquivo gerado no retry ainda esta muito pequeno.")
            }
            return { success: true, filePath: recentFilePath, size: stats.size }
          } else {
            throw new Error("Arquivo ainda nao foi criado apos retry.")
          }
        } else {
          const stats = fs.statSync(outputPath)
          if (stats.size < 1000) {
            throw new Error("Arquivo gerado no retry ainda esta muito pequeno.")
          }
          return { success: true, filePath: outputPath, size: stats.size }
        }
      } catch (error) {
        lastError = error
        console.error(`Erro no YouTube Empty File Handler (Tentativa ${retryCount}):`, error.message)
        await new Promise((resolve) => setTimeout(resolve, 3000 * retryCount))
      }
    }

    throw new Error(`Todas as tentativas de retry falharam. Ultimo erro: ${lastError.message}`)
  }
}

// MELHORANDO EXTRACAO DE INFORMACOES DE VIDEO SEM JSON
async function getVideoInfoWithoutJson(url, userAgent, cookieFile, platform) {
  console.log(`[INFO_FALLBACK] Tentando extracao sem JSON`)

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

// FUNCAO PARA TENTAR MULTIPLAS ESTRATEGIAS DE DOWNLOAD (PARA YOUTUBE)
async function tryYouTubeDownloadStrategies(url, format, quality, uniqueId) {
  const strategies = [
    { name: "Estrategia 1: Cookies + Headers Otimizados", useStrategy: 1, timeout: 45000 },
    { name: "Estrategia 2: Sem Cookies + Bypass", useStrategy: 2, timeout: 30000 },
    { name: "Estrategia 3: Modo Compatibilidade + Retries", useStrategy: 3, timeout: 60000 },
  ]

  let lastError = null

  for (const strategy of strategies) {
    try {
      console.log(`YouTube: Tentando ${strategy.name}`)

      const cookieFile = strategy.useStrategy === 2 ? null : getSmartCookie("youtube")
      const randomUA = getRandomUserAgent()

      console.log(`Cookie info para ${strategy.name}:`, {
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

      // Primeiro, tentar obter informacoes (metadata)
      const jsonArgs = [...baseArgs, "-j", url]
      let data = null

      try {
        const { stdout: jsonStdout, stderr: jsonStderr } = await executeSecureCommand(ytDlpPath, jsonArgs, {
          timeout: strategy.timeout,
        })
        const jsonLine = jsonStdout.split("\n").find((line) => line.trim().startsWith("{"))
        if (!jsonLine) {
          console.log("JSON nao obtido, tentando obter titulo/duracao...")
          data = await getVideoInfoWithoutJson(url, randomUA, cookieFile, "youtube")
          if (!data.title || data.title === "Video") {
            throw new Error("Nao foi possivel extrair titulo ou duracao mesmo com fallback.")
          }
        } else {
          data = JSON.parse(jsonLine)
          console.log(`[JSON_PARSED] Titulo: ${data.title?.substring(0, 60)}`)
        }
      } catch (e) {
        console.log(`Erro ao obter JSON/metadata: ${e.message}. Tentando fallback...`)
        data = await getVideoInfoWithoutJson(url, randomUA, cookieFile, "youtube")
        if (!data.title || data.title === "Video") {
          throw new Error("Nao foi possivel extrair titulo ou duracao mesmo com fallback.")
        }
      }

      // Verificar duracao
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
        // CORRECAO: Usar formato H.264 (avc1) em vez de AV1
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

      console.log(`YouTube: Executando download com ${strategy.name}`)
      const { stderr: downloadStderr } = await executeSecureCommand(ytDlpPath, downloadArgs, {
        timeout: 300000,
      })

      if (downloadStderr) {
        if (isFormatNotAvailableError(downloadStderr)) {
          console.log("Formato nao disponivel, tentando fallback com formato simplificado...")
          
          // Tentar com formato simplificado (ainda forca H.264)
          const fallbackArgs = [
            ...baseArgs,
            "-f",
            getSimpleFormatSelector(format),
            ...(format === "mp3" 
              ? ["--extract-audio", "--audio-format", "mp3", "--audio-quality", `${Number.parseInt(quality || "128")}k`]
              : ["--merge-output-format", "mp4"]),
            "--add-metadata",
            "-o",
            outputPath,
            url,
          ]
          
          const { stderr: fallbackStderr } = await executeSecureCommand(ytDlpPath, fallbackArgs, {
            timeout: 300000,
          })
          
          if (fallbackStderr && isYouTubeCriticalError(fallbackStderr)) {
            throw new Error(`YouTube Critical Error after fallback: ${fallbackStderr.substring(0, 300)}`)
          }
          
          console.log("Download com formato fallback bem-sucedido!")
        } else if (isYouTubeCriticalError(downloadStderr)) {
          console.error("Erro CRITICO do YouTube detectado:", downloadStderr.substring(0, 200))
          throw new Error(`YouTube Critical Error: ${downloadStderr.substring(0, 300)}`)
        } else if (isNonCriticalError(downloadStderr)) {
          console.log("Avisos nao criticos ignorados:", downloadStderr.substring(0, 100) + "...")
        } else if (isYouTubeEmptyFileError(downloadStderr)) {
          throw new Error(`YouTube Empty File Error: ${downloadStderr.substring(0, 300)}`)
        }
      }

      // Verificar se arquivo foi criado e nao esta vazio
      let finalFilePath = outputPath
      if (!fs.existsSync(finalFilePath)) {
        finalFilePath = findRecentFile(DOWNLOADS, Date.now(), [`.${format === "mp3" ? "mp3" : "mp4"}`])
        if (!finalFilePath) {
          throw new Error("Arquivo nao foi criado apos download bem-sucedido")
        }
      }

      const stats = fs.statSync(finalFilePath)
      if (stats.size < 1000) {
        throw new Error("Arquivo gerado esta corrompido ou vazio")
      }

      console.log(`YouTube: Sucesso com ${strategy.name}!`)
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
      console.log(`YouTube: ${strategy.name} falhou: ${error.message}`)

      if (isYouTubeCriticalError(error.message)) {
        console.log(`Erro critico do YouTube detectado: ${error.message.substring(0, 100)}`)
      } else if (isYouTubeEmptyFileError(error.message)) {
        console.log(`Erro de arquivo vazio do YouTube detectado.`)
      }

      if (strategy === strategies[strategies.length - 1]) {
        let errorMsg = lastError.message
        if (isYouTubeCriticalError(errorMsg) || isYouTubeEmptyFileError(errorMsg)) {
          errorMsg =
            "YouTube bloqueou o download ou o video esta indisponivel. Verifique os cookies ou tente outro video."
        }

        throw new Error(`Todas as estrategias do YouTube falharam. Erro: ${errorMsg}`)
      }

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
    console.error("Erro ao procurar arquivo:", error)
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
        console.log("Arquivo antigo removido:", file)

        for (const [key, value] of fileMap.entries()) {
          if (value.actualPath === filePath) {
            fileMap.delete(key)
            break
          }
        }
      }
    })
  } catch (error) {
    console.error("Erro ao limpar arquivos:", error.message)
  }
}

app.use(express.json({ limit: "10mb" }))

if (!fs.existsSync(DOWNLOADS)) {
  fs.mkdirSync(DOWNLOADS, { recursive: true, mode: 0o755 })
}

if (!fs.existsSync(COOKIES_DIR)) {
  fs.mkdirSync(COOKIES_DIR, { recursive: true, mode: 0o700 })
}

// ROTA PRINCIPAL OTIMIZADA
app.post("/download", async (req, res) => {
  const startTime = Date.now()
  let downloadStarted = false

  try {
    console.log(`POST /download - CORS OK`)

    resourceEconomizer.checkEconomyMode()
    if (resourceEconomizer.isEconomyMode) {
      return res.status(503).json({
        error: "Servidor em modo de economia de recursos. Tente novamente mais tarde.",
        type: "economy_mode_active",
        details: `Servidor inativo ha ${Math.floor((Date.now() - resourceEconomizer.lastRequest) / 60000)} minutos.`,
      })
    }

    if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
      return res.status(429).json({
        error: "Servidor ocupado no momento. Tente novamente em alguns minutos.",
        type: "server_busy",
        tip: "Muitas pessoas estao usando o servico agora.",
        queue_info: `${activeDownloads}/${MAX_CONCURRENT_DOWNLOADS} downloads ativos`,
      })
    }

    const { url, format, quality } = req.body

    const validationErrors = validateDownloadParams(url, format, quality)
    if (validationErrors.length > 0) {
      return res.status(400).json({
        error: "Parametros invalidos",
        details: validationErrors,
      })
    }

    activeDownloads++
    downloadStarted = true
    console.log(`Downloads ativos: ${activeDownloads}/${MAX_CONCURRENT_DOWNLOADS}`)

    if (activeDownloads === 1) {
      ultraAggressiveMemoryCleanup()
    }

    const detectedPlatform = detectPlatform(url)
    const cookieFile = getSmartCookie(detectedPlatform)
    const randomUA = getRandomUserAgent()
    const uniqueId = crypto.randomBytes(8).toString("hex")

    console.log("Nova requisicao:", {
      url: url.substring(0, 50) + "...",
      format,
      quality,
      platform: detectedPlatform,
    })

    console.log("Cookie info:", {
      platform: detectedPlatform,
      cookieFile: cookieFile ? path.basename(cookieFile) : "NENHUM",
      cookieExists: cookieFile ? fs.existsSync(cookieFile) : false,
    })

    // Para YouTube: usar comando CORRIGIDO sem tv_embedded
    let jsonArgs
    if (detectedPlatform === "youtube") {
      jsonArgs = [
        "--user-agent", randomUA,
        "--no-playlist",
        "--no-warnings",
        "--ignore-errors",
        "--ignore-no-formats-error",
        "--skip-download",
        "--dump-single-json",
        "--flat-playlist",
        // CORRECAO: Usar apenas "web" - tv_embedded foi bloqueado!
        "--extractor-args", "youtube:player_client=web",
      ]
      if (cookieFile) {
        jsonArgs.push("--cookies", cookieFile)
      }
      jsonArgs.push(url)
    } else {
      jsonArgs = [...buildSecureCommand(randomUA, cookieFile, detectedPlatform), "-j", "--skip-download", url]
    }

    console.log(`[YT_DLP_JSON] Executando: yt-dlp com ${jsonArgs.length} argumentos`)

    let data
    try {
      const { stdout: jsonStdout, stderr: jsonStderr } = await executeSecureCommand(ytDlpPath, jsonArgs, {
        timeout: 30000,
      })

      console.log(`[JSON_RESPONSE] Recebido ${jsonStdout.length} bytes`)

      try {
        const jsonLine = jsonStdout.split("\n").find((line) => line.trim().startsWith("{"))
        if (!jsonLine) {
          console.log(`[JSON_ERROR] JSON nao encontrado, usando fallback`)
          data = await getVideoInfoWithoutJson(url, randomUA, cookieFile, detectedPlatform)
        } else {
          data = JSON.parse(jsonLine)
          console.log(`[JSON_PARSED] Titulo: ${data.title?.substring(0, 60)}`)
        }
      } catch (e) {
        console.log(`[JSON_PARSE_ERROR] ${e.message}, usando fallback`)
        data = await getVideoInfoWithoutJson(url, randomUA, cookieFile, detectedPlatform)
      }

      const durationCheck = checkDuration(data.duration)
      if (!durationCheck.allowed) {
        console.log("Video rejeitado por duracao:", durationCheck.message)
        return res.status(400).json({
          error: durationCheck.message,
          type: "duration_exceeded",
          video_duration: durationCheck.duration_formatted,
          max_duration: durationCheck.max_duration,
          suggestion: "Tente um video mais curto (maximo 1 hora)",
        })
      }

      if (data.filesize && data.filesize > MAX_FILE_SIZE) {
        return res.status(400).json({
          error: "Arquivo muito grande. Maximo permitido: 400MB",
          type: "file_too_large",
        })
      }

      const safeTitle = generateSecureFilename(data.title, quality, format, uniqueId)
      const outputPath = path.join(DOWNLOADS, safeTitle)

      console.log("Arquivo aprovado:", {
        title: data.title.substring(0, 30) + "...",
        duration: durationCheck.duration_formatted,
        filename: safeTitle,
      })

      let downloadArgs
      
      // YOUTUBE: Usar comandos CORRIGIDOS que FORCAM H.264
      if (detectedPlatform === "youtube") {
        if (format === "mp3") {
          const q = Number.parseInt(quality || "128")
          downloadArgs = [
            "--user-agent", randomUA,
            "--no-playlist",
            "--no-warnings",
            "--ignore-errors",
            "--ignore-no-formats-error",
            // CORRECAO: Usar apenas "web"
            "--extractor-args", "youtube:player_client=web",
            // CORRECAO: Forcar audio AAC
            "-f", "bestaudio[acodec^=mp4a]/bestaudio/best",
            "-x",
            "--audio-format", "mp3",
            "--audio-quality", `${q}k`,
            "-o", outputPath,
          ]
          if (cookieFile) {
            downloadArgs.splice(downloadArgs.length - 2, 0, "--cookies", cookieFile)
          }
          downloadArgs.push(url)
        } else {
          // YouTube MP4: FORCAR H.264 (avc1) - NAO AV1!
          downloadArgs = [
            "--user-agent", randomUA,
            "--no-playlist",
            "--no-warnings",
            "--ignore-errors",
            "--ignore-no-formats-error",
            // CORRECAO: Usar apenas "web"
            "--extractor-args", "youtube:player_client=web",
            // CORRECAO PRINCIPAL: Forcar H.264 em vez de AV1
            "-f", "bestvideo[vcodec^=avc1][height<=1080]+bestaudio[acodec^=mp4a]/bestvideo[vcodec^=avc1]+bestaudio/best[vcodec^=avc1]/best",
            "--merge-output-format", "mp4",
            "-o", outputPath,
          ]
          if (cookieFile) {
            downloadArgs.splice(downloadArgs.length - 2, 0, "--cookies", cookieFile)
          }
          downloadArgs.push(url)
        }
      } else if (format === "mp3") {
        // Outras plataformas - MP3
        const q = Number.parseInt(quality || "128")
        downloadArgs = [
          ...buildSecureCommand(randomUA, cookieFile, detectedPlatform),
          "-f", "bestaudio/best",
          "-x",
          "--audio-format", "mp3",
          "--audio-quality", `${q}k`,
          "-o", outputPath,
          url,
        ]
      } else {
        // Outras plataformas - MP4
        downloadArgs = [
          ...buildSecureCommand(randomUA, cookieFile, detectedPlatform),
          "-f", "best",
          "-o", outputPath,
          url,
        ]
      }

      console.log("Iniciando download...")

      try {
        const { stdout: downloadStdout, stderr: downloadStderr } = await executeSecureCommand(ytDlpPath, downloadArgs, {
          timeout: 300000,
        })

        if (downloadStderr) {
          if (isFormatNotAvailableError(downloadStderr) && detectedPlatform === "youtube") {
            console.log("Formato nao disponivel - tentando fallback...")
            
            // Tentar com formato ainda mais simplificado
            const fallbackArgs = [
              ...buildSecureCommand(randomUA, cookieFile, detectedPlatform),
              "-f",
              getSimpleFormatSelector(format),
              ...(format === "mp3" 
                ? ["-x", "--audio-format", "mp3", "--audio-quality", `${Number.parseInt(quality || "128")}k`]
                : ["--merge-output-format", "mp4"]),
              "-o",
              outputPath,
              url,
            ]
            
            const { stderr: fallbackStderr } = await executeSecureCommand(ytDlpPath, fallbackArgs, {
              timeout: 300000,
            })
            
            if (fallbackStderr && isYouTubeCriticalError(fallbackStderr)) {
              throw new Error(fallbackStderr)
            }
            
            console.log("Download com formato fallback bem-sucedido!")
          } else if (isYouTubeCriticalError(downloadStderr)) {
            console.error("Erro CRITICO do YouTube:", downloadStderr.substring(0, 200))
            return res.status(500).json({
              error: "YouTube: Nao foi possivel baixar este video",
              type: "youtube_critical_error",
              details: "O YouTube bloqueou o download ou o video esta indisponivel",
              possible_causes: [
                "Cookies do YouTube expiraram",
                "YouTube detectou acesso automatizado",
                "Video com restricoes de regiao",
                "Formato de video nao disponivel",
              ],
              suggestions: [
                "Aguarde alguns minutos e tente novamente",
                "Tente outro video do YouTube",
                "Verifique se o video esta disponivel publicamente",
              ],
            })
          } else if (isNonCriticalError(downloadStderr)) {
            console.log("Avisos nao criticos ignorados:", downloadStderr.substring(0, 100) + "...")
          }
        }

        let finalFilePath = outputPath
        if (!fs.existsSync(finalFilePath)) {
          finalFilePath = findRecentFile(DOWNLOADS, startTime, [`.${format === "mp3" ? "mp3" : "mp4"}`])
          if (!finalFilePath) {
            return res.status(500).json({ error: "Arquivo nao foi criado apos download bem-sucedido" })
          }
        }

        const actualFilename = path.basename(finalFilePath)
        const stats = fs.statSync(finalFilePath)

        if (stats.size < 1000) {
          console.log(`Arquivo muito pequeno detectado: ${stats.size} bytes`)

          if (detectedPlatform === "youtube") {
            console.log("YouTube arquivo vazio - iniciando sistema de retry...")

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
                console.log("YouTube retry bem-sucedido!")
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

                console.log("Download YouTube corrigido:", {
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
                  economy_mode: resourceEconomizer.isEconomyMode,
                  youtube_retry_applied: true,
                  retry_success: true,
                })
              }
            } catch (retryError) {
              console.error("Todas as tentativas de retry falharam:", retryError.message)
              return res.status(500).json({
                error: "YouTube: Arquivo vazio mesmo apos multiplas tentativas. Tente outro video.",
                type: "youtube_empty_file",
                suggestion: "Este video especifico esta com problemas. Tente outro video do YouTube.",
                technical_details: retryError.message.substring(0, 200),
              })
            }
          } else {
            return res.status(500).json({ error: "Arquivo gerado esta corrompido ou vazio" })
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

        ultraAggressiveMemoryCleanup()

        console.log("Download concluido:", {
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
          economy_mode: resourceEconomizer.isEconomyMode,
        })
      } catch (downloadError) {
        console.error("Erro no download:", downloadError.message)

        if (isYouTubeCriticalError(downloadError.message)) {
          console.error("Erro CRITICO do YouTube:", downloadError.message)
          return res.status(500).json({
            error: "YouTube: Nao foi possivel baixar este video",
            type: "youtube_critical_error",
            details: "O YouTube bloqueou o download ou o video esta indisponivel",
            possible_causes: [
              "Cookies do YouTube expiraram",
              "YouTube detectou acesso automatizado",
              "Video com restricoes de regiao",
              "Formato de video nao disponivel",
            ],
            suggestions: [
              "Aguarde alguns minutos e tente novamente",
              "Tente outro video do YouTube",
              "Verifique se o video esta disponivel publicamente",
            ],
          })
        }

        if (detectedPlatform === "youtube" && isFormatNotAvailableError(downloadError.message)) {
          console.log("YouTube erro de formato detectado - tentando formato simplificado...")
          
          try {
            const fallbackArgs = [
              ...buildSecureCommand(randomUA, cookieFile, detectedPlatform),
              "-f",
              getSimpleFormatSelector(format),
              ...(format === "mp3" 
                ? ["-x", "--audio-format", "mp3", "--audio-quality", `${Number.parseInt(quality || "128")}k`]
                : ["--merge-output-format", "mp4"]),
              "-o",
              outputPath,
              url,
            ]
            
            const { stderr: fallbackStderr } = await executeSecureCommand(ytDlpPath, fallbackArgs, {
              timeout: 300000,
            })
            
            if (fallbackStderr && isYouTubeCriticalError(fallbackStderr)) {
              throw new Error(fallbackStderr)
            }
            
            let finalFilePath = outputPath
            if (!fs.existsSync(finalFilePath)) {
              finalFilePath = findRecentFile(DOWNLOADS, startTime, [`.${format === "mp3" ? "mp3" : "mp4"}`])
            }
            
            if (finalFilePath && fs.existsSync(finalFilePath)) {
              const stats = fs.statSync(finalFilePath)
              if (stats.size > 1000) {
                const downloadKey = `download_${crypto.randomBytes(16).toString("hex")}.${format === "mp3" ? "mp3" : "mp4"}`
                fileMap.set(downloadKey, {
                  actualPath: finalFilePath,
                  actualFilename: path.basename(finalFilePath),
                  userFriendlyName: `${data.title.substring(0, 50)} - ${format === "mp3" ? quality + "kbps" : quality + "p"}.${format === "mp3" ? "mp3" : "mp4"}`,
                  size: stats.size,
                  created: Date.now(),
                })
                
                ultraAggressiveMemoryCleanup()
                
                return res.json({
                  file: `/downloads/${downloadKey}`,
                  filename: `${data.title.substring(0, 50)} - ${format === "mp3" ? quality + "kbps" : quality + "p"}.${format === "mp3" ? "mp3" : "mp4"}`,
                  size: stats.size,
                  title: data.title,
                  duration: data.duration,
                  duration_formatted: durationCheck.duration_formatted,
                  platform: detectedPlatform,
                  quality_achieved: "best",
                  format_fallback_applied: true,
                })
              }
            }
            
            throw new Error("Arquivo nao criado apos fallback")
          } catch (fallbackError) {
            console.error("YouTube fallback de formato falhou:", fallbackError.message)
            return res.status(500).json({
              error: "YouTube: Nenhum formato de video disponivel",
              type: "youtube_format_error",
              suggestions: [
                "Tente uma qualidade diferente (ex: 720p)",
                "Tente baixar apenas o audio (MP3)",
                "Alguns videos tem formatos limitados",
              ],
            })
          }
        }
        
        if (detectedPlatform === "youtube" && isYouTubeEmptyFileError(downloadError.message)) {
          console.log("YouTube erro de arquivo vazio detectado - iniciando retry...")

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
              console.log("YouTube retry apos erro bem-sucedido!")

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
                economy_mode: resourceEconomizer.isEconomyMode,
                youtube_retry_applied: true,
                retry_success: true,
              })
            }
          } catch (retryError) {
            console.error("YouTube retry apos erro falhou:", retryError.message)
            return res.status(500).json({
              error: "YouTube: Problema persistente com este video. Tente outro.",
              type: "youtube_persistent_error",
              suggestion: "Este video especifico esta com problemas. Tente outro video do YouTube.",
            })
          }
        }

        if (isNonCriticalError(downloadError.message)) {
          console.log("Erro nao critico detectado, tentando continuar...")
        } else if (isAuthenticationError(downloadError.message)) {
          if (detectedPlatform === "instagram") {
            return res.status(400).json({
              error: "Instagram requer login. Configure cookies via environment variables.",
              type: "instagram_auth_required",
              platform: "instagram",
            })
          } else if (detectedPlatform === "twitter") {
            return res.status(400).json({
              error: "Twitter/X: Cookies de autenticacao expiraram ou invalidos.",
              type: "twitter_auth_error",
              platform: "twitter",
              details: "Os cookies do Twitter precisam ser atualizados no servidor.",
              suggestion: "Entre em contato com o administrador para atualizar os cookies do Twitter.",
            })
          }
          return res.status(400).json({
            error: "Conteudo privado ou requer login.",
            type: "private_content",
          })
        } else {
          return res.status(500).json({ error: "Falha no download/conversao" })
        }
      }
    } catch (error) {
      console.error("Erro no metadata:", error.message)

      if (detectedPlatform === "youtube" && isFormatNotAvailableError(error.message)) {
        console.log("YouTube: Erro de formato durante metadata - tentando sem validacao de formato...")
        
        try {
          const metadataOnlyArgs = [
            "--user-agent", randomUA,
            "--no-playlist",
            "--no-warnings",
            "--ignore-errors",
            "--ignore-no-formats-error",
            // CORRECAO: Usar apenas "web"
            "--extractor-args", "youtube:player_client=web",
            "--dump-single-json",
            "--skip-download",
          ]
          
          if (cookieFile) {
            metadataOnlyArgs.push("--cookies", cookieFile)
          }
          metadataOnlyArgs.push(url)
          
          const { stdout: metaStdout } = await executeSecureCommand(ytDlpPath, metadataOnlyArgs, {
            timeout: 30000,
          })
          
          const jsonLine = metaStdout.split("\n").find((line) => line.trim().startsWith("{"))
          if (jsonLine) {
            const metaData = JSON.parse(jsonLine)
            console.log("Metadata obtido com sucesso via fallback!")
            
            const safeTitle = generateSecureFilename(metaData.title, quality, format, uniqueId)
            const outputPath = path.join(DOWNLOADS, safeTitle)
            
            // Usar comandos YouTube especificos que FORCAM H.264
            let downloadArgs
            if (format === "mp3") {
              const q = Number.parseInt(quality || "128")
              downloadArgs = [
                "--user-agent", randomUA,
                "--no-playlist",
                "--no-warnings",
                "--ignore-errors",
                "--ignore-no-formats-error",
                // CORRECAO: Usar apenas "web"
                "--extractor-args", "youtube:player_client=web",
                "-f", "bestaudio[acodec^=mp4a]/bestaudio/best",
                "-x",
                "--audio-format", "mp3",
                "--audio-quality", `${q}k`,
                "-o", outputPath,
              ]
            } else {
              downloadArgs = [
                "--user-agent", randomUA,
                "--no-playlist",
                "--no-warnings",
                "--ignore-errors",
                "--ignore-no-formats-error",
                // CORRECAO: Usar apenas "web"
                "--extractor-args", "youtube:player_client=web",
                // CORRECAO PRINCIPAL: Forcar H.264 em vez de AV1
                "-f", "bestvideo[vcodec^=avc1][height<=1080]+bestaudio[acodec^=mp4a]/bestvideo[vcodec^=avc1]+bestaudio/best[vcodec^=avc1]/best",
                "--merge-output-format", "mp4",
                "-o", outputPath,
              ]
            }
            if (cookieFile) {
              downloadArgs.splice(downloadArgs.length - 2, 0, "--cookies", cookieFile)
            }
            downloadArgs.push(url)
            
            const { stderr: dlStderr } = await executeSecureCommand(ytDlpPath, downloadArgs, {
              timeout: 300000,
            })
            
            if (dlStderr && isYouTubeCriticalError(dlStderr)) {
              throw new Error(dlStderr)
            }
            
            let finalFilePath = outputPath
            if (!fs.existsSync(finalFilePath)) {
              finalFilePath = findRecentFile(DOWNLOADS, startTime, [`.${format === "mp3" ? "mp3" : "mp4"}`])
            }
            
            if (finalFilePath && fs.existsSync(finalFilePath)) {
              const stats = fs.statSync(finalFilePath)
              if (stats.size > 1000) {
                const downloadKey = `download_${crypto.randomBytes(16).toString("hex")}.${format === "mp3" ? "mp3" : "mp4"}`
                fileMap.set(downloadKey, {
                  actualPath: finalFilePath,
                  actualFilename: path.basename(finalFilePath),
                  userFriendlyName: `${metaData.title.substring(0, 50)} - ${format === "mp3" ? quality + "kbps" : quality + "p"}.${format === "mp3" ? "mp3" : "mp4"}`,
                  size: stats.size,
                  created: Date.now(),
                })
                
                ultraAggressiveMemoryCleanup()
                
                return res.json({
                  file: `/downloads/${downloadKey}`,
                  filename: `${metaData.title.substring(0, 50)} - ${format === "mp3" ? quality + "kbps" : quality + "p"}.${format === "mp3" ? "mp3" : "mp4"}`,
                  size: stats.size,
                  title: metaData.title,
                  duration: metaData.duration,
                  platform: detectedPlatform,
                  quality_achieved: "best",
                  format_fallback_applied: true,
                })
              }
            }
          }
          
          throw new Error("Metadata fallback nao produziu resultados")
        } catch (metaFallbackError) {
          console.error("Fallback de metadata tambem falhou:", metaFallbackError.message)
          return res.status(500).json({
            error: "YouTube: Este video tem formatos restritos",
            type: "youtube_format_restricted",
            suggestions: [
              "Tente baixar em uma qualidade diferente",
              "Alguns videos do YouTube tem formatos limitados",
              "Tente baixar apenas o audio (MP3)",
            ],
          })
        }
      }

      if (isYouTubeCriticalError(error.message)) {
        console.error("Erro CRITICO do YouTube no metadata:", error.message)
        return res.status(500).json({
          error: "YouTube: Nao foi possivel acessar este video",
          type: "youtube_critical_error",
          details: "O YouTube bloqueou o acesso ou o video esta indisponivel",
          possible_causes: [
            "Video privado ou removido",
            "Restricoes de regiao",
            "YouTube detectou acesso automatizado",
          ],
          suggestions: [
            "Verifique se o video esta disponivel publicamente",
            "Tente outro video do YouTube",
            "Aguarde alguns minutos e tente novamente",
          ],
        })
      }

      if (isAuthenticationError(error.message)) {
        if (detectedPlatform === "instagram") {
          return res.status(400).json({
            error: "Instagram requer login para este conteudo",
            type: "instagram_auth_required",
            details: "Configure os cookies do Instagram para acessar este conteudo",
          })
        } else if (detectedPlatform === "twitter") {
          return res.status(400).json({
            error: "Twitter/X requer autenticacao para este conteudo",
            type: "twitter_auth_required",
            details: "Este conteudo pode ser NSFW ou privado. Certifique-se de que os cookies do Twitter estao configurados.",
          })
        }
        return res.status(400).json({
          error: "Este conteudo requer login ou esta privado",
          type: "authentication_required",
        })
      }

      return res.status(500).json({
        error: "Nao foi possivel obter informacoes do video",
        details: error.message.substring(0, 200),
      })
    }
  } catch (error) {
    console.error("Erro geral:", error.message)
    return res.status(500).json({
      error: "Erro interno do servidor",
      details: error.message.substring(0, 200),
    })
  } finally {
    if (downloadStarted) {
      activeDownloads = Math.max(0, activeDownloads - 1)
      console.log(`Download finalizado. Ativos: ${activeDownloads}/${MAX_CONCURRENT_DOWNLOADS}`)
    }
  }
})

// ROTA DE TESTE DE COOKIES
app.get("/test-cookies", async (req, res) => {
  console.log("=== TESTE DE COOKIES INICIADO ===")

  const results = {
    pools: {
      google: googleCookiePool.length,
      instagram: instagramCookiePool.length,
      twitter: twitterCookiePool.length,
      total: generalCookiePool.length,
    },
    environment_variables: {},
    cookie_files: {},
    tests: {},
    recommendations: [],
  }

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
        has_equals: cookieContent.includes("="),
        format_valid: validation.valid,
        valid_lines: validation.validLines,
        invalid_lines: validation.invalidLines,
      }
    } else {
      results.environment_variables[envVar] = { exists: false }
    }
  }

  // Twitter
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

  // Verificar arquivos criados
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

  // Testar selecao de cookies
  const platforms = ["youtube", "instagram", "twitter"]

  for (const platform of platforms) {
    const selectedCookie = getSmartCookie(platform)

    results.tests[platform] = {
      cookie_selected: !!selectedCookie,
      cookie_path: selectedCookie ? path.basename(selectedCookie) : null,
      cookie_exists: selectedCookie ? fs.existsSync(selectedCookie) : false,
    }

    if (platform === "twitter" && selectedCookie) {
      const isTwitterSpecific = path.basename(selectedCookie).startsWith("twitter_")
      results.tests[platform].twitter_specific = isTwitterSpecific
      results.tests[platform].nsfw_capable = isTwitterSpecific
    }
  }

  // Gerar recomendacoes
  if (envVarsFound === 0) {
    results.recommendations.push("Nenhuma variavel de ambiente encontrada - configure GOOGLE_COOKIE_01, etc.")
  } else {
    results.recommendations.push(`${envVarsFound} variaveis de ambiente encontradas`)
  }

  if (results.pools.google === 0 && results.pools.instagram === 0 && results.pools.twitter === 0) {
    results.recommendations.push("Nenhum cookie carregado - verifique formato e variaveis")
  } else {
    results.recommendations.push(
      `${results.pools.google + results.pools.instagram + results.pools.twitter} cookies carregados`,
    )
  }

  if (results.pools.twitter === 0) {
    results.recommendations.push("Nenhum cookie Twitter - conteudo NSFW nao disponivel")
  } else {
    results.recommendations.push(`${results.pools.twitter} cookies Twitter - NSFW habilitado`)
  }

  const hasFormatIssues = Object.values(results.environment_variables).some((v) => v.exists && !v.format_valid)
  if (hasFormatIssues) {
    results.recommendations.push("Alguns cookies tem formato invalido - use formato Netscape do Cookie Editor")
  } else {
    results.recommendations.push("Formato dos cookies OK")
  }

  console.log("=== TESTE DE COOKIES CONCLUIDO ===")

  res.json({
    message: "Teste de Cookies Completo - CORRECAO H.264 + PLAYER_CLIENT WEB APLICADA!",
    timestamp: new Date().toISOString(),
    summary: {
      env_vars_found: envVarsFound,
      cookies_loaded: results.pools.google + results.pools.instagram + results.pools.twitter,
      files_created: Object.keys(results.cookie_files).length,
      twitter_nsfw_ready: results.pools.twitter > 0,
      youtube_fix_applied: "H.264 forcado (AV1 removido) + player_client=web (tv_embedded removido)",
      memory_optimization_applied: "Sistema de limpeza agressiva de memoria ativado",
    },
    results: results,
  })
})

app.get("/downloads/:fileKey", (req, res) => {
  const fileKey = sanitizeInput(req.params.fileKey, 100)

  console.log("Download solicitado:", fileKey)

  const fileInfo = fileMap.get(fileKey)
  if (!fileInfo) {
    return res.status(404).json({ error: "Arquivo nao encontrado ou expirado" })
  }

  const { actualPath, userFriendlyName, size } = fileInfo

  if (!fs.existsSync(actualPath)) {
    fileMap.delete(fileKey)
    return res.status(404).json({ error: "Arquivo nao encontrado no disco" })
  }

  try {
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(userFriendlyName)}"`)
    res.setHeader("Content-Type", "application/octet-stream")
    res.setHeader("Content-Length", size)
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate")
    res.setHeader("Pragma", "no-cache")
    res.setHeader("Expires", "0")
    res.setHeader("X-Content-Type-Options", "nosniff")

    console.log("Enviando arquivo seguro:", userFriendlyName)

    const fileStream = fs.createReadStream(actualPath)

    fileStream.on("error", (error) => {
      console.error("Erro ao ler arquivo:", error)
      if (!res.headersSent) {
        res.status(500).json({ error: "Erro ao ler arquivo" })
      }
    })

    fileStream.pipe(res)
  } catch (error) {
    console.error("Erro na rota de download:", error)
    if (!res.headersSent) {
      res.status(500).json({ error: "Erro interno do servidor" })
    }
  }
})

app.get("/health", (req, res) => {
  const memoryStats = logMemoryUsage()

  const stats = {
    status: "OK - CORRECAO H.264 + PLAYER_CLIENT WEB APLICADA!",
    version: "7.0.0 - H.264 FORCED + tv_embedded REMOVED + ECONOMY MODE",
    timestamp: new Date().toISOString(),
    limits: {
      max_duration: formatDuration(MAX_DURATION),
      max_file_size: "400MB",
      rate_limit: "15 downloads a cada 10 minutos",
      concurrent: "3 downloads simultaneos",
    },
    youtube_fixes: {
      av1_removed: "Videos agora baixam em H.264 (compativel com todos os players)",
      tv_embedded_removed: "player_client=tv_embedded foi removido (bloqueado pelo YouTube)",
      current_player_client: "web",
      format_selector: "bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/best",
    },
    memory_optimization: {
      gc_available: typeof global.gc !== "undefined",
      railway_workaround: typeof global.gc === "undefined" ? "Manual cleanup active" : "Native GC active",
      current_memory: memoryStats,
      auto_cleanup_enabled: true,
    },
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
    message: "WaifuConvert Backend - CORRECAO H.264 + PLAYER_CLIENT WEB APLICADA!",
    version: "7.0.0",
    status: "online",
    security_level: "HIGH",
    limits: {
      duration: "1 hora maximo",
      file_size: "400MB maximo",
      rate_limit: "15 downloads a cada 10 minutos",
      concurrent: "3 downloads simultaneos",
    },
    quality_support: {
      mp3: "64kbps - 320kbps",
      mp4: "144p, 360p, 480p, 720p, 1080p (H.264)",
    },
    youtube_fixes: [
      "H.264 forcado em vez de AV1 (videos reproduzem corretamente)",
      "player_client=web (tv_embedded foi bloqueado pelo YouTube)",
      "Multiplas estrategias de fallback",
      "Sistema de retry para arquivos vazios",
    ],
    platform_support: {
      tiktok: "Funcionando",
      twitter: `Funcionando com ${twitterCookiePool.length} cookies`,
      instagram: `Funcionando com ${instagramCookiePool.length} cookies`,
      youtube: `CORRIGIDO - H.264 + player_client=web + ${googleCookiePool.length} cookies`,
    },
    debug_endpoints: [
      "/test-cookies - Diagnostico completo de cookies",
      "/health - Status do sistema",
    ],
  })
})

app.use((error, req, res, next) => {
  console.error("Erro nao tratado:", error.message)
  res.status(500).json({
    error: "Erro interno do servidor",
    timestamp: new Date().toISOString(),
  })
})

app.use("*", (req, res) => {
  res.status(404).json({
    error: "Rota nao encontrada",
    available_endpoints: ["/", "/health", "/download", "/test-cookies"],
  })
})

// LIMPEZA AUTOMATICA DE ARQUIVOS E MEMORIA
const FILE_CLEANUP_INTERVAL = 15 * 60 * 1000
const MEMORY_CLEANUP_INTERVAL = 5 * 60 * 1000

fileCleanupInterval = setInterval(cleanupOldFiles, FILE_CLEANUP_INTERVAL)
memoryCleanupInterval = setInterval(() => {
  console.log("Limpeza de memoria periodica iniciada...")
  ultraAggressiveMemoryCleanup()
  logMemoryUsage()
}, MEMORY_CLEANUP_INTERVAL)

app.listen(PORT, async () => {
  console.log("WaifuConvert Backend - CORRECAO H.264 + PLAYER_CLIENT WEB APLICADA!")
  console.log(`Porta: ${PORT}`)

  checkOptimizationVariables()

  console.log("CORRECOES APLICADAS:")
  console.log("  - H.264 forcado (AV1 removido) - videos reproduzem corretamente")
  console.log("  - player_client=web (tv_embedded foi bloqueado pelo YouTube)")
  console.log("  - Multiplas estrategias de fallback")
  console.log("  - Sistema de retry para arquivos vazios")
  console.log("  - Limite de duracao: 1 hora")
  console.log("  - Limite de tamanho: 400MB")
  console.log("  - Downloads simultaneos: 3")

  console.log("Verificando yt-dlp na inicializacao...")
  await ensureYtDlpUpdated()

  const cookiesCreated = createSecureCookieFiles()
  loadCookiePool()

  console.log("COOKIES:")
  console.log(`  Google: ${googleCookiePool.length}`)
  console.log(`  Instagram: ${instagramCookiePool.length}`)
  console.log(`  Twitter: ${twitterCookiePool.length}`)
  console.log(`  Total: ${generalCookiePool.length}`)

  console.log("ENDPOINTS:")
  console.log("  /test-cookies - Diagnostico completo")
  console.log("  /health - Status do sistema")
  console.log("  /download - Download de videos")

  console.log("Servidor pronto!")
})
