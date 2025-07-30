const express = require("express")
const cors = require("cors")
const { exec } = require("child_process")
const fs = require("fs")
const path = require("path")

const app = express()

// 🌐 PORTA DINÂMICA PARA DEPLOY
const PORT = process.env.PORT || 8080

const DOWNLOADS = path.join(__dirname, "downloads")
// 🍪 NOVO DIRETÓRIO PARA OS COOKIES
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

// 🍪 CARREGAR E GERENCIAR O POOL DE COOKIES
let cookiePool = []
let currentCookieIndex = 0

function loadCookiePool() {
  try {
    if (!fs.existsSync(COOKIES_DIR)) {
      fs.mkdirSync(COOKIES_DIR, { recursive: true })
      console.log("📁 Diretório de cookies criado:", COOKIES_DIR)
      return
    }

    const files = fs.readdirSync(COOKIES_DIR).filter((file) => file.endsWith(".txt"))
    cookiePool = files.map((file) => path.join(COOKIES_DIR, file))

    if (cookiePool.length > 0) {
      console.log(`🍪 ${cookiePool.length} arquivos de cookie carregados com sucesso!`)
    } else {
      console.warn("⚠️ Nenhum arquivo de cookie (.txt) encontrado no diretório /cookies.")
    }
  } catch (error) {
    console.error("❌ Erro ao carregar pool de cookies:", error)
  }
}

// Função para obter o próximo cookie do pool (rotação)
function getNextCookie() {
  if (cookiePool.length === 0) {
    return null
  }
  const cookieFile = cookiePool[currentCookieIndex]
  currentCookieIndex = (currentCookieIndex + 1) % cookiePool.length
  return cookieFile
}

// 🌐 CORS ATUALIZADO PARA SEU DOMÍNIO
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
  }),
)

app.use(express.json())
app.use("/downloads", express.static(DOWNLOADS))

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

// Limpa nome de arquivos de caracteres problemáticos
function safeFilename(str) {
  return (str || "WaifuConvert")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[^\x00-\x7F]/g, "") // Remove caracteres não-ASCII
    .trim()
    .substring(0, 80) // Reduzir tamanho
}

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
      }
    })
  } catch (error) {
    console.error("❌ Erro ao limpar arquivos:", error.message)
  }
}

// Função para detectar erros de autenticação - MELHORADA
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
  ]

  return authErrors.some((error) => errorMessage.toLowerCase().includes(error.toLowerCase()))
}

// Função para obter seletor de formato otimizado
function getFormatSelector(format, quality) {
  if (format === "mp3") {
    return "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/best"
  }

  const q = Number.parseInt(quality)

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

// 🛡️ FUNÇÃO DE COMANDO ATUALIZADA PARA USAR COOKIES
function getAntiDetectionCmd(userAgent, cookieFile) {
  let cmd = `${ytDlpPath} --user-agent "${userAgent}" --no-playlist --no-check-certificates --prefer-insecure --extractor-retries 3 --fragment-retries 3 --retry-sleep 1 --no-call-home --geo-bypass --add-header "Accept-Language:en-US,en;q=0.9" --add-header "Accept-Encoding:gzip, deflate" --add-header "Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" --add-header "Connection:keep-alive" --add-header "Upgrade-Insecure-Requests:1" --add-header "Sec-Fetch-Dest:document" --add-header "Sec-Fetch-Mode:navigate" --add-header "Sec-Fetch-Site:none"`

  // Adiciona o cookie se um arquivo for fornecido
  if (cookieFile) {
    cmd += ` --cookies "${cookieFile}"`
  }

  return cmd
}

setInterval(cleanupOldFiles, 30 * 60 * 1000)

// Rota principal de download/conversão
app.post("/download", async (req, res) => {
  const startTime = Date.now()
  const randomUA = getRandomUserAgent()
  // 🍪 PEGA O PRÓXIMO COOKIE DA ROTAÇÃO
  const cookieFile = getNextCookie()

  try {
    const { url, format, quality, platform } = req.body

    console.log("🎯 Nova requisição:", { url, format, quality, platform })
    console.log("🕵️ User-Agent:", randomUA.substring(0, 50) + "...")
    if (cookieFile) {
      console.log("🍪 Usando cookie:", path.basename(cookieFile))
    } else {
      console.warn("⚠️ Nenhuma conta/cookie disponível, tentando sem autenticação.")
    }

    if (!url || !format) {
      console.error("❌ Faltando campos no request:", req.body)
      return res.status(400).json({ error: "URL e formato são obrigatórios" })
    }

    const uniqueId = Date.now() + "-" + Math.floor(Math.random() * 100000)
    const ext = format === "mp3" ? "mp3" : "mp4"
    const qualLabel = format === "mp3" ? `${quality || "best"}kbps` : `${quality || "best"}p`

    console.log("📋 Obtendo informações do vídeo...")

    // Comando base com proteções e o cookie selecionado
    const baseCmd = getAntiDetectionCmd(randomUA, cookieFile)

    const jsonCmd = `${baseCmd} -j "${url}"`

    console.log("🚀 Executando comando:", jsonCmd)

    exec(jsonCmd, { timeout: 30000 }, (jsonErr, jsonStdout, jsonStderr) => {
      if (jsonErr) {
        console.error("❌ Erro ao obter informações:", jsonStderr || jsonStdout)
        if (isAuthenticationError(jsonStderr || jsonStdout)) {
          console.log("🔒 Conteúdo requer autenticação")
          return res.status(400).json({
            error: "Este conteúdo é privado ou requer login. O cookie usado pode ter expirado ou sido inválido.",
            type: "private_content",
            suggestion: "Verifique se seus arquivos de cookie estão atualizados.",
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
        return res.status(500).json({ error: "Resposta JSON inválida" })
      }

      const safeTitle = safeFilename(data.title)
      const outputFilename = `${safeTitle}-${qualLabel}-${uniqueId}.${ext}`
      const outputPath = path.join(DOWNLOADS, outputFilename)

      let cmd
      if (format === "mp3") {
        const q = Number.parseInt(quality || "128")
        const formatSelector = getFormatSelector("mp3", quality)
        cmd = `${baseCmd} -f "${formatSelector}" --extract-audio --audio-format mp3 --audio-quality ${q}k --add-metadata --embed-thumbnail -o "${outputPath}" "${url}"`
      } else {
        const formatSelector = getFormatSelector("mp4", quality)
        cmd = `${baseCmd} -f "${formatSelector}" --merge-output-format mp4 --add-metadata --embed-subs --write-auto-subs --sub-langs "pt,en" -o "${outputPath}" "${url}"`
      }

      console.log("🚀 Iniciando download/conversão...")
      exec(cmd, { timeout: 600000 }, (error, stdout2, stderr2) => {
        if (error) {
          console.error("❌ Erro no download:", stderr2 || stdout2)
          if (isAuthenticationError(stderr2 || stdout2)) {
            return res.status(400).json({
              error: "Conteúdo privado ou bloqueado. O cookie pode ter falhado.",
              type: "private_content",
            })
          }
          return res.status(500).json({ error: "Falha no download/conversão" })
        }

        let finalFilePath = outputPath
        if (!fs.existsSync(finalFilePath)) {
          finalFilePath = findRecentFile(DOWNLOADS, startTime, [`.${ext}`])
          if (!finalFilePath) {
            return res.status(500).json({ error: "Arquivo não foi criado" })
          }
        }

        const filename = path.basename(finalFilePath)
        const userFriendlyName = `${safeTitle} - ${qualLabel}.${ext}`
        const fileSize = fs.statSync(finalFilePath).size

        if (fileSize < 1000) {
          return res.status(500).json({ error: "Arquivo gerado está corrompido ou vazio" })
        }

        res.json({
          file: `/downloads/${filename}`,
          filename: userFriendlyName,
          size: fileSize,
          title: data.title,
          duration: data.duration,
          quality_achieved: format === "mp3" ? `${quality}kbps` : `${quality}p`,
        })
      })
    })
  } catch (e) {
    console.error("❌ Erro inesperado:", e)
    res.status(500).json({ error: "Erro interno do servidor" })
  }
})

// Rota de download (força "salvar como")
app.get("/downloads/:file", (req, res) => {
  const filePath = path.join(DOWNLOADS, req.params.file)

  console.log("📥 Solicitação de download:", req.params.file)

  if (fs.existsSync(filePath)) {
    const stats = fs.statSync(filePath)

    // Headers otimizados para forçar download
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(req.params.file)}"`)
    res.setHeader("Content-Type", "application/octet-stream")
    res.setHeader("Content-Length", stats.size)
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate")
    res.setHeader("Pragma", "no-cache")
    res.setHeader("Expires", "0")

    console.log("✅ Enviando arquivo:", req.params.file, `(${(stats.size / 1024 / 1024).toFixed(2)} MB)`)
    res.sendFile(filePath)
  } else {
    console.error("❌ Arquivo não encontrado:", filePath)
    res.status(404).json({ error: "Arquivo não encontrado" })
  }
})

// Rota para verificar status do servidor
app.get("/health", (req, res) => {
  const stats = {
    status: "OK",
    timestamp: new Date().toISOString(),
    downloads_dir: DOWNLOADS,
    cookies_dir: COOKIES_DIR,
    cookies_loaded: cookiePool.length,
    current_cookie_index: currentCookieIndex,
    yt_dlp_path: ytDlpPath,
    user_agents_count: userAgents.length,
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || "development",
  }

  // Verificar se yt-dlp existe
  stats.yt_dlp_status = "Using global yt-dlp"

  res.json(stats)
})

// Rota para listar arquivos (debug)
app.get("/files", (req, res) => {
  try {
    const files = fs.readdirSync(DOWNLOADS).map((file) => {
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

    res.json({
      files,
      total_files: files.length,
      total_size_mb: files.reduce((sum, f) => sum + Number.parseFloat(f.size_mb), 0).toFixed(2),
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// Rota para testar User-Agent (debug)
app.get("/test-ua", (req, res) => {
  res.json({
    current_ua: getRandomUserAgent(),
    available_uas: userAgents.length,
    sample_uas: userAgents.slice(0, 2),
  })
})

// 🏠 ROTA RAIZ PARA VERIFICAR SE ESTÁ FUNCIONANDO
app.get("/", (req, res) => {
  res.json({
    message: "🎌 WaifuConvert Backend - Cookie Rotation Edition!",
    version: "3.0.0",
    status: "online",
    cookies_loaded: cookiePool.length,
  })
})

// Middleware de tratamento de erros
app.use((error, req, res, next) => {
  console.error("❌ Erro não tratado:", error)
  res.status(500).json({
    error: "Erro interno do servidor",
  })
})

// 🚀 INICIAR SERVIDOR
app.listen(PORT, () => {
  console.log("🚀 WaifuConvert Backend - COOKIE ROTATION EDITION")
  console.log(`🌐 Porta: ${PORT}`)
  console.log("📁 Diretório de downloads:", DOWNLOADS)
  console.log("🍪 Diretório de cookies:", COOKIES_DIR)

  // Carrega os cookies na inicialização
  loadCookiePool()

  console.log("🛡️ Proteções ativadas: Rotação de Cookies + Anti-detecção")
  console.log("🌍 Ambiente:", process.env.NODE_ENV || "development")

  cleanupOldFiles()
})

process.on("uncaughtException", (error) => {
  console.error("❌ Erro não capturado:", error)
})

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Promise rejeitada:", reason)
})
