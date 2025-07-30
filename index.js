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

// Rota principal de download/conversão
app.post("/download", async (req, res) => {
  const startTime = Date.now()
  const randomUA = getRandomUserAgent()
  // 🍪 PEGA O PRÓXIMO COOKIE DA ROTAÇÃO
  const cookieFile = getNextCookie()

  try {
    const { url, format, quality, platform } = req.body

    // 🎯 DETECTAR PLATAFORMA AUTOMATICAMENTE
    const detectedPlatform = detectPlatform(url)

    console.log("🎯 Nova requisição:", { url, format, quality, platform: detectedPlatform })
    console.log("🕵️ User-Agent:", randomUA.substring(0, 50) + "...")
    if (cookieFile) {
      console.log("🍪 Usando cookie:", path.basename(cookieFile))
    } else {
      console.warn("⚠️ Nenhuma conta/cookie disponível, tentando sem autenticação.")

      // 📸 AVISO ESPECÍFICO PARA INSTAGRAM SEM COOKIES
      if (detectedPlatform === "instagram") {
        console.warn("🚨 INSTAGRAM SEM COOKIES: Taxa de sucesso será muito baixa!")
      }
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
    const baseCmd = getAntiDetectionCmd(randomUA, cookieFile, detectedPlatform)

    const jsonCmd = `${baseCmd} -j "${url}"`

    console.log("🚀 Executando comando:", jsonCmd)

    exec(jsonCmd, { timeout: 45000 }, (jsonErr, jsonStdout, jsonStderr) => {
      // ← Timeout aumentado para Instagram
      if (jsonErr) {
        console.error("❌ Erro ao obter informações:", jsonStderr || jsonStdout)
        if (isAuthenticationError(jsonStderr || jsonStdout)) {
          console.log("🔒 Conteúdo requer autenticação")

          // 📸 MENSAGEM ESPECÍFICA PARA INSTAGRAM
          if (detectedPlatform === "instagram") {
            return res.status(400).json({
              error: "Instagram requer login. Adicione cookies do Instagram para acessar este conteúdo.",
              type: "instagram_auth_required",
              suggestion: "Faça login no Instagram no seu navegador e exporte os cookies para o diretório /cookies.",
              platform: "instagram",
            })
          }

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
          if (isAuthenticationError(stderr2 || stdout2)) {
            // 📸 MENSAGEM ESPECÍFICA PARA INSTAGRAM
            if (detectedPlatform === "instagram") {
              return res.status(400).json({
                error: "Instagram bloqueou o acesso. Cookies necessários ou expirados.",
                type: "instagram_blocked",
                suggestion: "Atualize os cookies do Instagram ou tente com outro vídeo público.",
                platform: "instagram",
              })
            }

            return res.status(400).json({
              error: "Conteúdo privado ou bloqueado. O cookie pode ter falhado.",
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
        })
      })
    })
  } catch (e) {
    console.error("❌ Erro inesperado:", e)
    res.status(500).json({ error: "Erro interno do servidor" })
  }
})

// 📥 ROTA DE DOWNLOAD COMPLETAMENTE REESCRITA
app.get("/downloads/:fileKey", (req, res) => {
  const fileKey = req.params.fileKey

  console.log("📥 Solicitação de download:", fileKey)

  // 🔍 BUSCAR NO MAPA DE ARQUIVOS
  const fileInfo = fileMap.get(fileKey)

  if (!fileInfo) {
    console.error("❌ Chave de arquivo não encontrada:", fileKey)
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
    if (!res.headersSent) {
      res.status(500).json({ error: "Erro interno do servidor" })
    }
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
    optimizations: {
      tiktok: "enabled - anti-corruption",
      instagram: "enabled - requires cookies",
      twitter: "enabled",
      filename_mapping: "enabled",
    },
    active_files: fileMap.size,
  }

  // Verificar se yt-dlp existe
  stats.yt_dlp_status = "Using global yt-dlp"

  res.json(stats)
})

// Rota para listar arquivos (debug)
app.get("/files", (req, res) => {
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
    message: "🎌 WaifuConvert Backend - Instagram Support Added!",
    version: "3.4.0",
    status: "online",
    cookies_loaded: cookiePool.length,
    platform_support: {
      tiktok: "✅ Working perfectly",
      twitter: "✅ Working perfectly",
      instagram: "✅ Working with cookies",
      youtube: "⚠️ Requires cookies",
      reddit: "✅ Usually works",
      facebook: "⚠️ Requires cookies",
    },
    active_downloads: fileMap.size,
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
  console.log("🚀 WaifuConvert Backend - INSTAGRAM SUPPORT ADDED")
  console.log(`🌐 Porta: ${PORT}`)
  console.log("📁 Diretório de downloads:", DOWNLOADS)
  console.log("🍪 Diretório de cookies:", COOKIES_DIR)

  // Carrega os cookies na inicialização
  loadCookiePool()

  console.log("🛡️ Proteções ativadas:")
  console.log("  ✅ Rotação de Cookies + Anti-detecção")
  console.log("  ✅ TikTok: Otimizações anti-corrupção")
  console.log("  ✅ Instagram: Suporte com cookies obrigatórios")
  console.log("  ✅ Twitter/X: Funcionando perfeitamente")
  console.log("  ✅ Sistema de mapeamento de arquivos")
  console.log("  ✅ Limpeza de caracteres especiais")
  console.log("🌍 Ambiente:", process.env.NODE_ENV || "development")

  cleanupOldFiles()
})

process.on("uncaughtException", (error) => {
  console.error("❌ Erro não capturado:", error)
})

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Promise rejeitada:", reason)
})
