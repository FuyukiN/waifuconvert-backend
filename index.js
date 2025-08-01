const express = require("express")
const cors = require("cors")
const helmet = require("helmet")
const rateLimit = require("express-rate-limit")
const validator = require("validator")
const { exec } = require("child_process")
const fs = require("fs")
const path = require("path")

const app = express()

// 🌐 PORTA DINÂMICA PARA DEPLOY
const PORT = process.env.PORT || 8080

const DOWNLOADS = path.join(__dirname, "downloads")
// 🍪 DIRETÓRIO PARA OS COOKIES (AGORA CRIADOS DINAMICAMENTE)
const COOKIES_DIR = path.join(__dirname, "cookies")

// 🚀 YT-DLP PATH CORRIGIDO PARA PRODUÇÃO
const ytDlpPath = "yt-dlp"

// User-Agents rotativos para evitar bloqueios - ATUALIZADOS
const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/131.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0",
]

// 🛡️ SECURITY: Headers de segurança com Helmet
app.use(
  helmet({
    contentSecurityPolicy: false, // Desabilitar CSP para não quebrar downloads
    crossOriginEmbedderPolicy: false, // Permitir downloads cross-origin
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  }),
)

// 🛡️ SECURITY: Rate Limiting inteligente
const downloadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutos
  max: 25, // 25 downloads por 10 minutos (generoso)
  message: {
    error: "Muitas tentativas de download. Tente novamente em alguns minutos.",
    type: "rate_limit_exceeded",
    retry_after: "10 minutos",
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Bypass para desenvolvimento local
    const ip = req.ip || req.connection.remoteAddress
    return ip === "127.0.0.1" || ip === "::1" || ip.startsWith("192.168.") || ip.startsWith("10.")
  },
})

// Rate limiting mais permissivo para outras rotas
const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 100, // 100 requests por minuto
  message: {
    error: "Muitas requisições. Tente novamente em um minuto.",
  },
  skip: (req) => {
    const ip = req.ip || req.connection.remoteAddress
    return ip === "127.0.0.1" || ip === "::1" || ip.startsWith("192.168.") || ip.startsWith("10.")
  },
})

app.use(generalLimiter)

// 🛡️ SECURITY: Logging de eventos de segurança
function logSecurityEvent(event, details, req = null) {
  const logData = {
    timestamp: new Date().toISOString(),
    event,
    ip: req ? req.ip || req.connection.remoteAddress : "unknown",
    userAgent: req ? req.get("User-Agent") : "unknown",
    ...details,
  }
  console.warn(`🚨 SECURITY EVENT: ${event}`, logData)
}

// 🛡️ SECURITY: Validação rigorosa de URL
function isValidUrl(url) {
  try {
    if (!url || typeof url !== "string") return false

    // Validar com validator.js
    if (
      !validator.isURL(url, {
        protocols: ["http", "https"],
        require_protocol: true,
        require_valid_protocol: true,
      })
    ) {
      return false
    }

    const urlObj = new URL(url)
    const hostname = urlObj.hostname.toLowerCase()

    // Lista de domínios permitidos (whitelist)
    const allowedDomains = [
      "youtube.com",
      "youtu.be",
      "m.youtube.com",
      "www.youtube.com",
      "tiktok.com",
      "www.tiktok.com",
      "vm.tiktok.com",
      "twitter.com",
      "x.com",
      "www.twitter.com",
      "www.x.com",
      "instagram.com",
      "www.instagram.com",
      "reddit.com",
      "www.reddit.com",
      "old.reddit.com",
      "facebook.com",
      "www.facebook.com",
      "fb.watch",
    ]

    const isAllowed = allowedDomains.some((domain) => hostname === domain || hostname.endsWith("." + domain))

    if (!isAllowed) {
      return false
    }

    // Verificar caracteres suspeitos que podem indicar command injection
    const suspiciousChars = [";", "&", "|", "`", "$", "(", ")", "{", "}", "<", ">"]
    if (suspiciousChars.some((char) => url.includes(char))) {
      return false
    }

    return true
  } catch (error) {
    return false
  }
}

// 🛡️ SECURITY: Validação de input para downloads
function validateDownloadRequest(req, res, next) {
  const { url, format, quality } = req.body

  // Validar URL
  if (!isValidUrl(url)) {
    logSecurityEvent("INVALID_URL_ATTEMPT", { url }, req)
    return res.status(400).json({
      error: "URL inválida ou não suportada",
      type: "invalid_url",
    })
  }

  // Validar formato
  if (!format || !["mp3", "mp4"].includes(format)) {
    logSecurityEvent("INVALID_FORMAT_ATTEMPT", { format }, req)
    return res.status(400).json({
      error: "Formato deve ser 'mp3' ou 'mp4'",
      type: "invalid_format",
    })
  }

  // Validar qualidade (opcional)
  if (quality && !validator.isInt(quality.toString(), { min: 128, max: 1080 })) {
    logSecurityEvent("INVALID_QUALITY_ATTEMPT", { quality }, req)
    return res.status(400).json({
      error: "Qualidade inválida",
      type: "invalid_quality",
    })
  }

  next()
}

// 🛡️ NOVO: CRIAR COOKIES SEGUROS A PARTIR DE ENVIRONMENT VARIABLES
function createSecureCookieFiles() {
  console.log("🛡️ Criando arquivos de cookie seguros a partir de environment variables...")

  if (!fs.existsSync(COOKIES_DIR)) {
    fs.mkdirSync(COOKIES_DIR, { recursive: true })
  }

  let cookiesCreated = 0

  // 🔵 COOKIES GOOGLE (para YouTube + Twitter + Reddit)
  for (let i = 1; i <= 10; i++) {
    const envVar = `GOOGLE_COOKIE_${i.toString().padStart(2, "0")}`
    const cookieContent = process.env[envVar]

    if (cookieContent) {
      const filename = `google_conta${i.toString().padStart(2, "0")}.txt`
      const filepath = path.join(COOKIES_DIR, filename)

      fs.writeFileSync(filepath, cookieContent)
      console.log(`✅ Cookie Google ${i} criado: ${filename}`)
      cookiesCreated++
    }
  }

  // 📸 COOKIES INSTAGRAM
  for (let i = 1; i <= 8; i++) {
    const envVar = `INSTAGRAM_COOKIE_${i.toString().padStart(2, "0")}`
    const cookieContent = process.env[envVar]

    if (cookieContent) {
      const filename = `instagram_conta${i.toString().padStart(2, "0")}.txt`
      const filepath = path.join(COOKIES_DIR, filename)

      fs.writeFileSync(filepath, cookieContent)
      console.log(`✅ Cookie Instagram ${i} criado: ${filename}`)
      cookiesCreated++
    }
  }

  // 📘 COOKIES FACEBOOK (opcional)
  for (let i = 1; i <= 3; i++) {
    const envVar = `FACEBOOK_COOKIE_${i.toString().padStart(2, "0")}`
    const cookieContent = process.env[envVar]

    if (cookieContent) {
      const filename = `facebook_conta${i.toString().padStart(2, "0")}.txt`
      const filepath = path.join(COOKIES_DIR, filename)

      fs.writeFileSync(filepath, cookieContent)
      console.log(`✅ Cookie Facebook ${i} criado: ${filename}`)
      cookiesCreated++
    }
  }

  console.log(`🎯 Total de cookies criados: ${cookiesCreated}`)
  return cookiesCreated
}

// 🍪 POOLS DE COOKIES ORGANIZADOS POR PLATAFORMA (NOVO)
let googleCookiePool = []
let instagramCookiePool = []
let facebookCookiePool = []
let generalCookiePool = [] // Para compatibilidade com código existente

// 🍪 CARREGAR E GERENCIAR O POOL DE COOKIES (MELHORADO)
let currentCookieIndex = 0

function loadCookiePool() {
  try {
    if (!fs.existsSync(COOKIES_DIR)) {
      fs.mkdirSync(COOKIES_DIR, { recursive: true })
      console.log("📁 Diretório de cookies criado:", COOKIES_DIR)
      return
    }

    const files = fs.readdirSync(COOKIES_DIR).filter((file) => file.endsWith(".txt"))

    // 🔵 SEPARAR COOKIES POR PLATAFORMA
    googleCookiePool = files.filter((f) => f.startsWith("google_")).map((f) => path.join(COOKIES_DIR, f))
    instagramCookiePool = files.filter((f) => f.startsWith("instagram_")).map((f) => path.join(COOKIES_DIR, f))
    facebookCookiePool = files.filter((f) => f.startsWith("facebook_")).map((f) => path.join(COOKIES_DIR, f))

    // Pool geral para compatibilidade
    generalCookiePool = files.map((file) => path.join(COOKIES_DIR, file))

    console.log(`🔵 Google cookies carregados: ${googleCookiePool.length}`)
    console.log(`📸 Instagram cookies carregados: ${instagramCookiePool.length}`)
    console.log(`📘 Facebook cookies carregados: ${facebookCookiePool.length}`)
    console.log(`🍪 Total de cookies: ${generalCookiePool.length}`)

    if (generalCookiePool.length > 0) {
      console.log(`🍪 ${generalCookiePool.length} arquivos de cookie carregados com sucesso!`)
    } else {
      console.warn("⚠️ Nenhum cookie encontrado. Adicione cookies via environment variables.")
    }
  } catch (error) {
    console.error("❌ Erro ao carregar pool de cookies:", error)
  }
}

// 🎯 NOVO: SELETOR INTELIGENTE DE COOKIE POR PLATAFORMA
function getSmartCookie(platform) {
  switch (platform.toLowerCase()) {
    case "youtube":
    case "twitter":
    case "reddit":
      return getRandomFromPool(googleCookiePool)

    case "instagram":
      return getRandomFromPool(instagramCookiePool)

    case "facebook":
      return getRandomFromPool(facebookCookiePool)

    case "tiktok":
    default:
      // TikTok funciona sem cookies, mas se tiver cookies gerais, usar
      return getRandomFromPool(generalCookiePool)
  }
}

function getRandomFromPool(pool) {
  if (pool.length === 0) return null
  return pool[Math.floor(Math.random() * pool.length)]
}

// Função para obter o próximo cookie do pool (rotação) - MANTIDA PARA COMPATIBILIDADE
function getNextCookie() {
  if (generalCookiePool.length === 0) {
    return null
  }
  const cookieFile = generalCookiePool[currentCookieIndex]
  currentCookieIndex = (currentCookieIndex + 1) % generalCookiePool.length
  return cookieFile
}

// 🎯 DETECTAR PLATAFORMA PARA OTIMIZAÇÕES ESPECÍFICAS
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

// 🛡️ SECURITY: CORS dinâmico baseado no ambiente
app.use(
  cors({
    origin: (origin, callback) => {
      const allowedOrigins =
        process.env.NODE_ENV === "production"
          ? ["https://www.waifuconvert.com", "https://waifuconvert.com", "https://waifuconvert.vercel.app"]
          : [
              "http://localhost:3000",
              "http://127.0.0.1:3000",
              "https://www.waifuconvert.com",
              "https://waifuconvert.com",
              "https://waifuconvert.vercel.app",
            ]

      // Permitir requests sem origin (Postman, curl, etc.) apenas em desenvolvimento
      if (!origin && process.env.NODE_ENV !== "production") {
        return callback(null, true)
      }

      if (allowedOrigins.includes(origin)) {
        callback(null, true)
      } else {
        logSecurityEvent("CORS_VIOLATION", { origin })
        callback(new Error("Não permitido pelo CORS"))
      }
    },
    credentials: true,
  }),
)

app.use(express.json({ limit: "10mb" })) // Limitar tamanho do JSON

// Criar diretórios se não existirem
if (!fs.existsSync(DOWNLOADS)) {
  fs.mkdirSync(DOWNLOADS, { recursive: true })
  console.log("📁 Diretório downloads criado:", DOWNLOADS)
}

if (!fs.existsSync(COOKIES_DIR)) {
  fs.mkdirSync(COOKIES_DIR, { recursive: true })
  console.log("📁 Diretório cookies criado:", COOKIES_DIR)
}

// Função para obter User-Agent aleatório
function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)]
}

// 🔧 FUNÇÃO MELHORADA PARA LIMPAR NOMES DE ARQUIVO
function safeFilename(str) {
  return (str || "WaifuConvert")
    .replace(/[\\/:*?"<>|#]/g, "") // ← ADICIONADO # na lista de caracteres proibidos
    .replace(/\s+/g, "_") // ← TROCAR ESPAÇOS POR UNDERSCORE
    .replace(/[^\w\-_.()]/g, "") // ← MANTER APENAS CARACTERES SEGUROS
    .replace(/_{2,}/g, "_") // ← REMOVER UNDERSCORES DUPLOS
    .trim()
    .substring(0, 60) // ← REDUZIR MAIS O TAMANHO
}

// 📁 MAPA PARA RASTREAR ARQUIVOS CRIADOS
const fileMap = new Map()

// Função para encontrar arquivo criado recentemente
function findRecentFile(baseDir, timestamp, extensions = [".mp4", ".mp3"]) {
  try {
    const files = fs.readdirSync(baseDir)
    const recentFiles = files.filter((file) => {
      const filePath = path.join(baseDir, file)
      const stats = fs.statSync(filePath)
      const fileTime = stats.birthtime.getTime()
      const timeDiff = Math.abs(fileTime - timestamp)

      // Arquivo criado nos últimos 5 minutos e tem extensão correta
      return timeDiff < 300000 && extensions.some((ext) => file.toLowerCase().endsWith(ext))
    })

    // Retornar o mais recente
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

// Função para limpar arquivos antigos
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

        // Remover do mapa também
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

// 🔍 FUNÇÃO MELHORADA PARA DETECTAR ERROS DE AUTENTICAÇÃO
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
    "cookies-from-browser",
    "not a bot",
    "captcha",
    "verification",
    "blocked",
    "rate limit",
    // 📸 ERROS ESPECÍFICOS DO INSTAGRAM
    "requested content is not available",
    "rate-limit reached",
    "General metadata extraction failed",
    "unable to extract shared data",
    "Instagram login required",
  ]

  return authErrors.some((error) => errorMessage.toLowerCase().includes(error.toLowerCase()))
}

// 🎯 FUNÇÃO OTIMIZADA PARA SELETOR DE FORMATO POR PLATAFORMA
function getFormatSelector(format, quality, platform) {
  if (format === "mp3") {
    return "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/best"
  }

  const q = Number.parseInt(quality)

  // 🎵 CONFIGURAÇÕES ESPECÍFICAS PARA TIKTOK (CORRIGE CORRUPÇÃO)
  if (platform === "tiktok") {
    console.log("🎵 Aplicando configurações específicas do TikTok para evitar corrupção...")

    // TikTok funciona melhor com formatos específicos e sem merge complexo
    if (q >= 1080) {
      return "best[height<=1080][ext=mp4]/best[height<=1080]/best[ext=mp4]/best"
    } else if (q >= 720) {
      return "best[height<=720][ext=mp4]/best[height<=720]/best[ext=mp4]/best"
    } else if (q >= 480) {
      return "best[height<=480][ext=mp4]/best[height<=480]/best[ext=mp4]/best"
    } else {
      return "best[height<=360][ext=mp4]/best[height<=360]/best[ext=mp4]/best"
    }
  }

  // 📸 CONFIGURAÇÕES ESPECÍFICAS PARA INSTAGRAM
  if (platform === "instagram") {
    console.log("📸 Aplicando configurações específicas do Instagram...")

    // Instagram funciona melhor com formatos simples
    if (q >= 1080) {
      return "best[height<=1080][ext=mp4]/best[height<=1080]/best[ext=mp4]/best"
    } else if (q >= 720) {
      return "best[height<=720][ext=mp4]/best[height<=720]/best[ext=mp4]/best"
    } else if (q >= 480) {
      return "best[height<=480][ext=mp4]/best[height<=480]/best[ext=mp4]/best"
    } else {
      return "best[height<=360][ext=mp4]/best[height<=360]/best[ext=mp4]/best"
    }
  }

  // Configurações padrão para outras plataformas
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

// 🛡️ FUNÇÃO DE COMANDO ATUALIZADA COM OTIMIZAÇÕES POR PLATAFORMA
function getAntiDetectionCmd(userAgent, cookieFile, platform) {
  let cmd = `${ytDlpPath} --user-agent "${userAgent}" --no-playlist --no-check-certificates --prefer-insecure --extractor-retries 3 --fragment-retries 3 --retry-sleep 1 --no-call-home --geo-bypass --add-header "Accept-Language:en-US,en;q=0.9" --add-header "Accept-Encoding:gzip, deflate" --add-header "Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" --add-header "Connection:keep-alive" --add-header "Upgrade-Insecure-Requests:1" --add-header "Sec-Fetch-Dest:document" --add-header "Sec-Fetch-Mode:navigate" --add-header "Sec-Fetch-Site:none"`

  // 🎵 CONFIGURAÇÕES ESPECÍFICAS PARA TIKTOK
  if (platform === "tiktok") {
    console.log("🎵 Aplicando configurações anti-corrupção para TikTok...")
    // Configurações específicas para TikTok evitarem corrupção
    cmd += ` --fragment-retries 10 --retry-sleep 2`
    cmd += ` --http-chunk-size 10485760` // 10MB chunks para evitar fragmentação
    cmd += ` --no-part` // Não usar arquivos .part que podem corromper
    cmd += ` --concurrent-fragments 1` // Download sequencial para TikTok
  }

  // 📸 CONFIGURAÇÕES ESPECÍFICAS PARA INSTAGRAM
  if (platform === "instagram") {
    console.log("📸 Aplicando configurações específicas do Instagram...")

    // Instagram precisa de configurações especiais para evitar rate-limit
    cmd += ` --sleep-interval 2 --max-sleep-interval 5` // Delay entre requests
    cmd += ` --extractor-retries 5 --fragment-retries 5` // Mais tentativas
    cmd += ` --retry-sleep 3` // Mais tempo entre tentativas

    // Headers específicos do Instagram
    cmd += ` --add-header "X-Requested-With:XMLHttpRequest"`
    cmd += ` --add-header "X-Instagram-AJAX:1"`
    cmd += ` --add-header "X-CSRFToken:missing"`

    // ⚠️ FORÇAR USO DE COOKIES PARA INSTAGRAM
    if (!cookieFile) {
      console.warn("⚠️ Instagram REQUER cookies! Sem cookies, a taxa de sucesso será muito baixa.")
    }
  }

  // Adiciona o cookie se um arquivo for fornecido
  if (cookieFile) {
    cmd += ` --cookies "${cookieFile}"`
    console.log(`🍪 Cookie aplicado para ${platform}:`, path.basename(cookieFile))
  }

  return cmd
}

setInterval(cleanupOldFiles, 30 * 60 * 1000)

// 🛡️ SECURITY: Rota principal de download/conversão com validação
app.post("/download", downloadLimiter, validateDownloadRequest, async (req, res) => {
  const startTime = Date.now()
  const randomUA = getRandomUserAgent()

  try {
    const { url, format, quality, platform } = req.body

    // 🎯 DETECTAR PLATAFORMA AUTOMATICAMENTE
    const detectedPlatform = detectPlatform(url)

    // 🍪 NOVO: USAR COOKIE INTELIGENTE POR PLATAFORMA
    const cookieFile = getSmartCookie(detectedPlatform)

    console.log("🎯 Nova requisição:", { url, format, quality, platform: detectedPlatform })
    console.log("🕵️ User-Agent:", randomUA.substring(0, 50) + "...")

    if (cookieFile) {
      console.log(`🍪 Usando cookie ${detectedPlatform}:`, path.basename(cookieFile))
    } else {
      console.warn(`⚠️ Nenhum cookie disponível para ${detectedPlatform}`)

      // 📸 AVISO ESPECÍFICO PARA INSTAGRAM SEM COOKIES
      if (detectedPlatform === "instagram") {
        console.warn("🚨 INSTAGRAM SEM COOKIES: Taxa de sucesso será muito baixa!")
      }
    }

    const uniqueId = Date.now() + "-" + Math.floor(Math.random() * 100000)
    const ext = format === "mp3" ? "mp3" : "mp4"
    const qualLabel = format === "mp3" ? `${quality || "best"}kbps` : `${quality || "best"}p`

    console.log("📋 Obtendo informações do vídeo...")

    // Comando base com proteções e o cookie selecionado
    const baseCmd = getAntiDetectionCmd(randomUA, cookieFile, detectedPlatform)

    const jsonCmd = `${baseCmd} -j "${url}"`

    console.log("🚀 Executando comando:", jsonCmd)

    exec(jsonCmd, { timeout: 45000 }, (jsonErr, jsonStdout, jsonStderr) => {
      // ← Timeout aumentado para Instagram
      if (jsonErr) {
        console.error("❌ Erro ao obter informações:", jsonStderr || jsonStdout)
        logSecurityEvent("DOWNLOAD_ERROR", { url, error: jsonStderr || jsonStdout }, req)

        if (isAuthenticationError(jsonStderr || jsonStdout)) {
          console.log("🔒 Conteúdo requer autenticação")

          // 📸 MENSAGEM ESPECÍFICA PARA INSTAGRAM
          if (detectedPlatform === "instagram") {
            return res.status(400).json({
              error: "Instagram requer login. Adicione cookies do Instagram via environment variables.",
              type: "instagram_auth_required",
              suggestion: "Configure INSTAGRAM_COOKIE_01, INSTAGRAM_COOKIE_02, etc. no Railway.",
              platform: "instagram",
            })
          }

          return res.status(400).json({
            error: "Este conteúdo é privado ou requer login. Configure cookies via environment variables.",
            type: "private_content",
            suggestion: "Adicione cookies apropriados no Railway Dashboard.",
          })
        }
        return res.status(500).json({ error: "Falha ao obter informações do vídeo" })
      }

      let data
      try {
        const jsonLine = jsonStdout.split("\n").find((line) => line.trim().startsWith("{"))
        if (!jsonLine) throw new Error("Nenhuma linha JSON encontrada")
        data = JSON.parse(jsonLine)
        console.log("✅ Informações obtidas:", data.title)
      } catch (e) {
        console.error("❌ Erro ao parsear JSON:", e)
        logSecurityEvent("JSON_PARSE_ERROR", { url, error: e.message }, req)
        return res.status(500).json({ error: "Resposta JSON inválida" })
      }

      const safeTitle = safeFilename(data.title)
      const outputFilename = `${safeTitle}-${qualLabel}-${uniqueId}.${ext}`
      const outputPath = path.join(DOWNLOADS, outputFilename)

      console.log("📁 Nome do arquivo limpo:", outputFilename)
      console.log("📁 Caminho completo:", outputPath)

      let cmd
      if (format === "mp3") {
        const q = Number.parseInt(quality || "128")
        const formatSelector = getFormatSelector("mp3", quality, detectedPlatform)
        cmd = `${baseCmd} -f "${formatSelector}" --extract-audio --audio-format mp3 --audio-quality ${q}k --add-metadata --embed-thumbnail -o "${outputPath}" "${url}"`
      } else {
        const formatSelector = getFormatSelector("mp4", quality, detectedPlatform)

        // 🎵 COMANDO ESPECÍFICO PARA TIKTOK (EVITA CORRUPÇÃO)
        if (detectedPlatform === "tiktok") {
          console.log("🎵 Usando comando otimizado para TikTok...")
          // Para TikTok, não usar merge complexo que pode corromper
          cmd = `${baseCmd} -f "${formatSelector}" --add-metadata -o "${outputPath}" "${url}"`
        }
        // 📸 COMANDO ESPECÍFICO PARA INSTAGRAM
        else if (detectedPlatform === "instagram") {
          console.log("📸 Usando comando otimizado para Instagram...")
          // Para Instagram, usar comando simples sem merge complexo
          cmd = `${baseCmd} -f "${formatSelector}" --add-metadata -o "${outputPath}" "${url}"`
        } else {
          // Comando padrão para outras plataformas
          cmd = `${baseCmd} -f "${formatSelector}" --merge-output-format mp4 --add-metadata --embed-subs --write-auto-subs --sub-langs "pt,en" -o "${outputPath}" "${url}"`
        }
      }

      console.log("🚀 Iniciando download/conversão...")
      console.log("📝 Plataforma detectada:", detectedPlatform)

      exec(cmd, { timeout: 600000 }, (error, stdout2, stderr2) => {
        if (error) {
          console.error("❌ Erro no download:", stderr2 || stdout2)
          logSecurityEvent("CONVERSION_ERROR", { url, error: stderr2 || stdout2 }, req)

          if (isAuthenticationError(stderr2 || stdout2)) {
            // 📸 MENSAGEM ESPECÍFICA PARA INSTAGRAM
            if (detectedPlatform === "instagram") {
              return res.status(400).json({
                error: "Instagram bloqueou o acesso. Configure cookies via environment variables.",
                type: "instagram_blocked",
                suggestion: "Adicione INSTAGRAM_COOKIE_01, INSTAGRAM_COOKIE_02, etc. no Railway.",
                platform: "instagram",
              })
            }

            return res.status(400).json({
              error: "Conteúdo privado ou bloqueado. Configure cookies apropriados.",
              type: "private_content",
            })
          }
          return res.status(500).json({ error: "Falha no download/conversão" })
        }

        // 🔍 VERIFICAR ARQUIVO CRIADO
        let finalFilePath = outputPath
        if (!fs.existsSync(finalFilePath)) {
          finalFilePath = findRecentFile(DOWNLOADS, startTime, [`.${ext}`])
          if (!finalFilePath) {
            return res.status(500).json({ error: "Arquivo não foi criado" })
          }
        }

        const actualFilename = path.basename(finalFilePath)
        const stats = fs.statSync(finalFilePath)

        if (stats.size < 1000) {
          return res.status(500).json({ error: "Arquivo gerado está corrompido ou vazio" })
        }

        // 📁 MAPEAR ARQUIVO PARA DOWNLOAD SEGURO
        const downloadKey = `download_${uniqueId}.${ext}`
        fileMap.set(downloadKey, {
          actualPath: finalFilePath,
          actualFilename: actualFilename,
          userFriendlyName: `${safeTitle} - ${qualLabel}.${ext}`,
          size: stats.size,
          created: Date.now(),
        })

        console.log("✅ Download concluído:", {
          platform: detectedPlatform,
          downloadKey: downloadKey,
          actualFilename: actualFilename,
          userFriendlyName: `${safeTitle} - ${qualLabel}.${ext}`,
          size: `${(stats.size / 1024 / 1024).toFixed(2)} MB`,
          path: finalFilePath,
          used_cookies: !!cookieFile,
          cookie_type: cookieFile ? path.basename(cookieFile).split("_")[0] : "none",
        })

        res.json({
          file: `/downloads/${downloadKey}`, // ← USAR CHAVE SEGURA
          filename: `${safeTitle} - ${qualLabel}.${ext}`,
          size: stats.size,
          title: data.title,
          duration: data.duration,
          platform: detectedPlatform,
          quality_achieved: format === "mp3" ? `${quality}kbps` : `${quality}p`,
          used_cookies: !!cookieFile,
          cookie_type: cookieFile ? path.basename(cookieFile).split("_")[0] : "none",
        })
      })
    })
  } catch (e) {
    console.error("❌ Erro inesperado:", e)
    logSecurityEvent("UNEXPECTED_ERROR", { error: e.message }, req)
    res.status(500).json({ error: "Erro interno do servidor" })
  }
})

// 🛡️ SECURITY: Rota de download com validação rigorosa de fileKey
app.get("/downloads/:fileKey", (req, res) => {
  const fileKey = req.params.fileKey

  console.log("📥 Solicitação de download:", fileKey)

  // 🛡️ SECURITY: Validar formato do fileKey para prevenir path traversal
  if (!/^download_\d+-\d+\.(mp4|mp3)$/.test(fileKey)) {
    logSecurityEvent("INVALID_FILE_KEY", { fileKey }, req)
    return res.status(400).json({ error: "Chave de arquivo inválida" })
  }

  // 🔍 BUSCAR NO MAPA DE ARQUIVOS
  const fileInfo = fileMap.get(fileKey)

  if (!fileInfo) {
    console.error("❌ Chave de arquivo não encontrada:", fileKey)
    logSecurityEvent("FILE_KEY_NOT_FOUND", { fileKey }, req)
    return res.status(404).json({ error: "Arquivo não encontrado ou expirado" })
  }

  const { actualPath, userFriendlyName, size } = fileInfo

  // Verificar se arquivo ainda existe no disco
  if (!fs.existsSync(actualPath)) {
    console.error("❌ Arquivo físico não encontrado:", actualPath)
    fileMap.delete(fileKey) // Limpar do mapa
    return res.status(404).json({ error: "Arquivo não encontrado no disco" })
  }

  try {
    // Headers otimizados para forçar download
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(userFriendlyName)}"`)
    res.setHeader("Content-Type", "application/octet-stream")
    res.setHeader("Content-Length", size)
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate")
    res.setHeader("Pragma", "no-cache")
    res.setHeader("Expires", "0")
    res.setHeader("Accept-Ranges", "bytes")

    console.log("✅ Enviando arquivo:", userFriendlyName, `(${(size / 1024 / 1024).toFixed(2)} MB)`)
    console.log("📁 Caminho real:", actualPath)

    // Usar stream para arquivos grandes
    const fileStream = fs.createReadStream(actualPath)

    fileStream.on("error", (error) => {
      console.error("❌ Erro ao ler arquivo:", error)
      if (!res.headersSent) {
        res.status(500).json({ error: "Erro ao ler arquivo" })
      }
    })

    fileStream.on("end", () => {
      console.log("✅ Download concluído com sucesso:", userFriendlyName)
    })

    fileStream.pipe(res)
  } catch (error) {
    console.error("❌ Erro na rota de download:", error)
    logSecurityEvent("DOWNLOAD_STREAM_ERROR", { error: error.message }, req)
    if (!res.headersSent) {
      res.status(500).json({ error: "Erro interno do servidor" })
    }
  }
})

// 🛡️ SECURITY: Health check seguro (sem vazar informações sensíveis)
app.get("/health", (req, res) => {
  const stats = {
    status: "OK - SECURE EDITION",
    version: "4.0.0 - SECURE",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || "development",
    cookies_loaded: {
      google: googleCookiePool.length,
      instagram: instagramCookiePool.length,
      facebook: facebookCookiePool.length,
      total: generalCookiePool.length,
    },
    security_features: [
      "✅ Input validation",
      "✅ Rate limiting",
      "✅ CORS protection",
      "✅ Security headers",
      "✅ Path traversal protection",
      "✅ Command injection protection",
      "✅ Security event logging",
    ],
    active_files: fileMap.size,
  }

  res.json(stats)
})

// Rota para listar arquivos (debug) - apenas em desenvolvimento
app.get("/files", (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(403).json({ error: "Endpoint não disponível em produção" })
  }

  try {
    const diskFiles = fs.readdirSync(DOWNLOADS).map((file) => {
      const filePath = path.join(DOWNLOADS, file)
      const stats = fs.statSync(filePath)
      return {
        name: file,
        size: stats.size,
        size_mb: (stats.size / 1024 / 1024).toFixed(2),
        created: stats.birthtime,
        modified: stats.mtime,
        age_minutes: Math.floor((Date.now() - stats.birthtime.getTime()) / 60000),
      }
    })

    const mappedFiles = Array.from(fileMap.entries()).map(([key, info]) => ({
      key,
      userFriendlyName: info.userFriendlyName,
      actualFilename: info.actualFilename,
      size_mb: (info.size / 1024 / 1024).toFixed(2),
      age_minutes: Math.floor((Date.now() - info.created) / 60000),
    }))

    res.json({
      disk_files: diskFiles,
      mapped_files: mappedFiles,
      total_disk_files: diskFiles.length,
      total_mapped_files: mappedFiles.length,
      total_size_mb: diskFiles.reduce((sum, f) => sum + Number.parseFloat(f.size_mb), 0).toFixed(2),
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// 🍪 NOVA ROTA: Verificar cookies carregados - apenas em desenvolvimento
app.get("/cookies", (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(403).json({ error: "Endpoint não disponível em produção" })
  }

  try {
    const cookieStats = {
      google: {
        count: googleCookiePool.length,
        files: googleCookiePool.map((f) => path.basename(f)),
        platforms: ["YouTube", "Twitter", "Reddit"],
      },
      instagram: {
        count: instagramCookiePool.length,
        files: instagramCookiePool.map((f) => path.basename(f)),
        platforms: ["Instagram"],
      },
      facebook: {
        count: facebookCookiePool.length,
        files: facebookCookiePool.map((f) => path.basename(f)),
        platforms: ["Facebook"],
      },
      total: generalCookiePool.length,
      security: "✅ Loaded from environment variables",
    }

    res.json(cookieStats)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// Rota para testar User-Agent (debug) - apenas em desenvolvimento
app.get("/test-ua", (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(403).json({ error: "Endpoint não disponível em produção" })
  }

  res.json({
    current_ua: getRandomUserAgent(),
    available_uas: userAgents.length,
    sample_uas: userAgents.slice(0, 2),
  })
})

// 🏠 ROTA RAIZ PARA VERIFICAR SE ESTÁ FUNCIONANDO
app.get("/", (req, res) => {
  res.json({
    message: "🛡️ WaifuConvert Backend - SECURE EDITION!",
    version: "4.0.0 - SECURE",
    status: "online - security enhanced",
    cookies_loaded: {
      google: googleCookiePool.length,
      instagram: instagramCookiePool.length,
      facebook: facebookCookiePool.length,
      total: generalCookiePool.length,
    },
    platform_support: {
      tiktok: "✅ Working perfectly (no cookies needed)",
      twitter: `✅ Working with ${googleCookiePool.length} Google cookies`,
      instagram: `✅ Working with ${instagramCookiePool.length} Instagram cookies`,
      youtube: `✅ Working with ${googleCookiePool.length} Google cookies`,
      reddit: `✅ Working with ${googleCookiePool.length} Google cookies`,
      facebook: `✅ Working with ${facebookCookiePool.length} Facebook cookies`,
    },
    security_features: [
      "✅ Input validation & sanitization",
      "✅ Rate limiting (25 downloads/10min)",
      "✅ CORS protection",
      "✅ Security headers (Helmet)",
      "✅ Path traversal protection",
      "✅ Command injection protection",
      "✅ Security event logging",
      "✅ Environment-based CORS",
      "✅ Production endpoint restrictions",
    ],
    active_downloads: fileMap.size,
  })
})

// 🛡️ SECURITY: Middleware de tratamento de erros
app.use((error, req, res, next) => {
  console.error("❌ Erro não tratado:", error)
  logSecurityEvent("UNHANDLED_ERROR", { error: error.message }, req)
  res.status(500).json({
    error: "Erro interno do servidor",
  })
})

// 🛡️ SECURITY: Middleware para rotas não encontradas
app.use((req, res) => {
  logSecurityEvent("ROUTE_NOT_FOUND", { path: req.path, method: req.method }, req)
  res.status(404).json({
    error: "Rota não encontrada",
  })
})

// 🚀 INICIAR SERVIDOR
app.listen(PORT, () => {
  console.log("🛡️ WaifuConvert Backend - SECURE EDITION")
  console.log(`🌐 Porta: ${PORT}`)
  console.log("📁 Diretório de downloads:", DOWNLOADS)
  console.log("🍪 Diretório de cookies:", COOKIES_DIR)

  // 🛡️ 1. CRIAR COOKIES SEGUROS A PARTIR DE ENV VARS
  const cookiesCreated = createSecureCookieFiles()

  // 🍪 2. CARREGAR POOLS DE COOKIES
  loadCookiePool()

  console.log("🔒 SEGURANÇA ATIVADA:")
  console.log("  ✅ Input validation & sanitization")
  console.log("  ✅ Rate limiting (25 downloads/10min)")
  console.log("  ✅ CORS protection")
  console.log("  ✅ Security headers (Helmet)")
  console.log("  ✅ Path traversal protection")
  console.log("  ✅ Command injection protection")
  console.log("  ✅ Security event logging")
  console.log("  ✅ Environment-based configuration")
  console.log("  ✅ Production endpoint restrictions")

  console.log("🛡️ Proteções ativadas:")
  console.log("  ✅ Rotação de Cookies + Anti-detecção")
  console.log("  ✅ TikTok: Otimizações anti-corrupção")
  console.log("  ✅ Instagram: Suporte com cookies obrigatórios")
  console.log("  ✅ Twitter/X: Funcionando perfeitamente")
  console.log("  ✅ Sistema de mapeamento de arquivos")
  console.log("  ✅ Limpeza de caracteres especiais")

  console.log("🍪 COOKIES CARREGADOS:")
  console.log(`  🔵 Google: ${googleCookiePool.length} (YouTube + Twitter + Reddit)`)
  console.log(`  📸 Instagram: ${instagramCookiePool.length}`)
  console.log(`  📘 Facebook: ${facebookCookiePool.length}`)
  console.log(`  🎵 TikTok: Não precisa de cookies`)
  console.log(`  📊 Total: ${generalCookiePool.length} cookies`)

  console.log("🌍 Ambiente:", process.env.NODE_ENV || "development")

  cleanupOldFiles()
})

process.on("uncaughtException", (error) => {
  console.error("❌ Erro não capturado:", error)
  logSecurityEvent("UNCAUGHT_EXCEPTION", { error: error.message })
})

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Promise rejeitada:", reason)
  logSecurityEvent("UNHANDLED_REJECTION", { reason: reason.toString() })
})
