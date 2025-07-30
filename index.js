const express = require("express")
const cors = require("cors")
const { exec } = require("child_process")
const fs = require("fs")
const path = require("path")

const app = express()

// 🌐 PORTA DINÂMICA PARA DEPLOY
const PORT = process.env.PORT || 8080

const DOWNLOADS = path.join(__dirname, "downloads")

// 🚀 YT-DLP PATH CORRIGIDO PARA PRODUÇÃO
const ytDlpPath = "yt-dlp" // Sempre usar comando global no Railway

// User-Agents rotativos para evitar bloqueios
const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/120.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
]

// 🌐 CORS ATUALIZADO PARA SEU DOMÍNIO
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "https://www.waifuconvert.com", // ← SEU DOMÍNIO PRINCIPAL
      "https://waifuconvert.com", // ← SEU DOMÍNIO SEM WWW
      "https://waifuconvert.vercel.app", // ← SEU DOMÍNIO VERCEL
    ],
    credentials: true,
  }),
)

app.use(express.json())
app.use("/downloads", express.static(DOWNLOADS))

// Criar diretório se não existir
if (!fs.existsSync(DOWNLOADS)) {
  fs.mkdirSync(DOWNLOADS, { recursive: true })
  console.log("📁 Diretório downloads criado:", DOWNLOADS)
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

// Função para detectar erros de autenticação
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

setInterval(cleanupOldFiles, 30 * 60 * 1000)

// Rota principal de download/conversão
app.post("/download", async (req, res) => {
  const startTime = Date.now()
  const randomUA = getRandomUserAgent()

  try {
    const { url, format, quality, platform } = req.body

    console.log("🎯 Nova requisição:", { url, format, quality, platform })
    console.log("🕵️ User-Agent:", randomUA.substring(0, 50) + "...")

    if (!url || !format) {
      console.error("❌ Faltando campos no request:", req.body)
      return res.status(400).json({ error: "URL e formato são obrigatórios" })
    }

    // Gera nome único mais simples
    const uniqueId = Date.now() + "-" + Math.floor(Math.random() * 100000)
    const ext = format === "mp3" ? "mp3" : "mp4"
    const qualLabel = format === "mp3" ? `${quality || "best"}kbps` : `${quality || "best"}p`

    console.log("📋 Obtendo informações do vídeo...")

    // Comando base com User-Agent e configurações anti-bloqueio
    const baseCmd = `${ytDlpPath} --user-agent "${randomUA}" --no-playlist --no-check-certificates --prefer-insecure`

    // Passo 1: Obter informações JSON
    const jsonCmd = `${baseCmd} -j "${url}"`

    console.log("🚀 Executando comando:", jsonCmd)

    exec(jsonCmd, { timeout: 30000 }, (jsonErr, jsonStdout, jsonStderr) => {
      if (jsonErr) {
        console.error("❌ Erro ao obter informações:", jsonStderr || jsonStdout)

        // Verificar se é erro de autenticação
        if (isAuthenticationError(jsonStderr || jsonStdout)) {
          console.log("🔒 Conteúdo requer autenticação")
          return res.status(400).json({
            error:
              "Este conteúdo é privado ou requer login. Por questões de segurança e privacidade, não suportamos este tipo de conteúdo.",
            type: "private_content",
            suggestion: "Tente com um vídeo público da mesma plataforma.",
          })
        }

        return res.status(500).json({ error: "Falha ao obter informações do vídeo" })
      }

      let data
      try {
        const jsonLine = jsonStdout.split("\n").find((line) => line.trim().startsWith("{"))
        if (!jsonLine) {
          throw new Error("Nenhuma linha JSON encontrada")
        }
        data = JSON.parse(jsonLine)
        console.log("✅ Informações obtidas:", data.title)
        console.log(
          "📊 Duração:",
          data.duration
            ? `${Math.floor(data.duration / 60)}:${(data.duration % 60).toString().padStart(2, "0")}`
            : "N/A",
        )
      } catch (e) {
        console.error("❌ Erro ao parsear JSON:", e)
        return res.status(500).json({ error: "Resposta JSON inválida" })
      }

      // Nome de arquivo mais seguro
      const safeTitle = safeFilename(data.title)
      const outputFilename = `${safeTitle}-${qualLabel}-${uniqueId}.${ext}`
      const outputPath = path.join(DOWNLOADS, outputFilename)

      let cmd
      if (format === "mp3") {
        console.log("🎵 Configurando conversão para MP3...")

        const q = Number.parseInt(quality || "128")
        const formatSelector = getFormatSelector("mp3", quality)

        cmd = `${baseCmd} -f "${formatSelector}" --extract-audio --audio-format mp3 --audio-quality ${q}k --add-metadata --embed-thumbnail -o "${outputPath}" "${url}"`
      } else {
        console.log("🎬 Configurando download para MP4...")

        const formatSelector = getFormatSelector("mp4", quality)

        cmd = `${baseCmd} -f "${formatSelector}" --merge-output-format mp4 --add-metadata --embed-subs --write-auto-subs --sub-langs "pt,en" -o "${outputPath}" "${url}"`
      }

      console.log("🚀 Iniciando download/conversão...")
      console.log("📝 Comando completo:", cmd)

      // Passo 2: Fazer o download
      exec(cmd, { timeout: 600000 }, (error, stdout2, stderr2) => {
        if (error) {
          console.error("❌ Erro no download:", stderr2 || stdout2)
          console.error("❌ Código de erro:", error.code)

          // Verificar novamente se é erro de autenticação durante download
          if (isAuthenticationError(stderr2 || stdout2)) {
            return res.status(400).json({
              error: "Conteúdo privado detectado durante o download. Tente com um vídeo público.",
              type: "private_content",
            })
          }

          return res.status(500).json({ error: "Falha no download/conversão" })
        }

        console.log("📤 Download concluído")

        // Estratégia 1: Verificar se o arquivo esperado existe
        let finalFilePath = outputPath

        if (!fs.existsSync(finalFilePath)) {
          console.log("🔍 Arquivo esperado não encontrado, procurando arquivos recentes...")

          // Estratégia 2: Procurar arquivo criado recentemente
          finalFilePath = findRecentFile(DOWNLOADS, startTime, [`.${ext}`])

          if (!finalFilePath) {
            console.error("❌ Nenhum arquivo encontrado")
            return res.status(500).json({ error: "Arquivo não foi criado" })
          }
        }

        const filename = path.basename(finalFilePath)
        const userFriendlyName = `${safeTitle} - ${qualLabel}.${ext}`
        const fileSize = fs.statSync(finalFilePath).size

        // Verificar se o arquivo não está vazio
        if (fileSize < 1000) {
          console.error("❌ Arquivo muito pequeno, possível erro")
          return res.status(500).json({ error: "Arquivo gerado está corrompido ou vazio" })
        }

        console.log("✅ Download concluído:", {
          filename: filename,
          userFriendlyName: userFriendlyName,
          size: `${(fileSize / 1024 / 1024).toFixed(2)} MB`,
          path: finalFilePath,
        })

        // Resposta JSON para frontend
        res.json({
          file: `/downloads/${filename}`,
          filename: userFriendlyName,
          size: fileSize,
          title: data.title,
          duration: data.duration,
          quality_achieved: format === "mp3" ? `${quality}kbps` : `${quality}p`,
        })

        console.log(
          `[${new Date().toLocaleString()}] ✅ Download pronto: ${userFriendlyName} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`,
        )
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
    message: "🎌 WaifuConvert Backend está funcionando!",
    version: "1.0.0",
    status: "online",
    endpoints: {
      health: "/health",
      download: "/download (POST)",
      files: "/files",
      test_ua: "/test-ua",
    },
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
  console.log("🚀 WaifuConvert Backend rodando na porta:", PORT)
  console.log("📁 Diretório de downloads:", DOWNLOADS)
  console.log("🛠️ yt-dlp path:", ytDlpPath)
  console.log("🌐 CORS habilitado para:", [
    "localhost:3000",
    "www.waifuconvert.com",
    "waifuconvert.com",
    "waifuconvert.vercel.app",
  ])
  console.log("🕵️ User-Agents disponíveis:", userAgents.length)
  console.log("🛡️ Proteções ativadas: Anti-bloqueio + Detecção de conteúdo privado")
  console.log("🌍 Ambiente:", process.env.NODE_ENV || "development")

  cleanupOldFiles()
})

process.on("uncaughtException", (error) => {
  console.error("❌ Erro não capturado:", error)
})

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Promise rejeitada:", reason)
})
