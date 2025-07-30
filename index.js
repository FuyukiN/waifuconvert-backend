const express = require("express")
const cors = require("cors")
const { exec } = require("child_process")
const fs = require("fs")
const path = require("path")
const { promisify } = require("util")

const execAsync = promisify(exec)
const app = express()
const PORT = process.env.PORT || 8080
const DOWNLOADS = path.join(__dirname, "downloads")
const ytDlpPath = "yt-dlp"

// 🛡️ MÚLTIPLOS USER-AGENTS MAIS AGRESSIVOS
const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/131.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
]

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

app.use(express.json({ limit: "10mb" }))
app.use("/downloads", express.static(DOWNLOADS))

if (!fs.existsSync(DOWNLOADS)) {
  fs.mkdirSync(DOWNLOADS, { recursive: true })
  console.log("📁 Diretório downloads criado:", DOWNLOADS)
}

function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)]
}

function safeFilename(str) {
  return (str || "WaifuConvert")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "_")
    .replace(/[^\w\-_.()]/g, "")
    .trim()
    .substring(0, 80)
}

// 🔍 VERIFICAÇÃO DE INTEGRIDADE DE ARQUIVO
function verifyFileIntegrity(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { valid: false, reason: "File does not exist" }
    }

    const stats = fs.statSync(filePath)

    // Verificar tamanho mínimo
    if (stats.size < 1000) {
      return { valid: false, reason: "File too small" }
    }

    // Verificar se não é apenas headers
    if (stats.size < 10000) {
      return { valid: false, reason: "File suspiciously small" }
    }

    // Ler primeiros bytes para verificar formato
    const buffer = fs.readFileSync(filePath, { start: 0, end: 20 })
    const hex = buffer.toString("hex")

    // Verificar assinaturas de arquivo
    const isMP4 = hex.includes("667479") || hex.includes("6d646174") || hex.includes("6d6f6f76")
    const isMP3 = hex.startsWith("494433") || hex.startsWith("fff3") || hex.startsWith("fff2")

    if (filePath.endsWith(".mp4") && !isMP4) {
      return { valid: false, reason: "Invalid MP4 signature" }
    }

    if (filePath.endsWith(".mp3") && !isMP3) {
      return { valid: false, reason: "Invalid MP3 signature" }
    }

    return { valid: true, size: stats.size }
  } catch (error) {
    return { valid: false, reason: error.message }
  }
}

// 🛡️ COMANDO MÁXIMO ANTI-DETECÇÃO COM MÚLTIPLAS ESTRATÉGIAS
function getUltimateAntiDetectionCmd(userAgent, attempt = 1) {
  let baseCmd = `${ytDlpPath} --user-agent "${userAgent}" --no-playlist --no-check-certificates --prefer-insecure`

  // Configurações básicas anti-detecção
  baseCmd += ` --extractor-retries 5 --fragment-retries 5 --retry-sleep ${attempt} --no-call-home --geo-bypass`
  baseCmd += ` --socket-timeout 30 --sleep-interval ${attempt} --max-sleep-interval ${attempt * 2}`

  // Headers realistas
  baseCmd += ` --add-header "Accept-Language:en-US,en;q=0.9,pt;q=0.8"`
  baseCmd += ` --add-header "Accept-Encoding:gzip, deflate, br"`
  baseCmd += ` --add-header "Accept:text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8"`
  baseCmd += ` --add-header "Connection:keep-alive"`
  baseCmd += ` --add-header "Upgrade-Insecure-Requests:1"`
  baseCmd += ` --add-header "Sec-Fetch-Dest:document"`
  baseCmd += ` --add-header "Sec-Fetch-Mode:navigate"`
  baseCmd += ` --add-header "Sec-Fetch-Site:none"`
  baseCmd += ` --add-header "Cache-Control:max-age=0"`
  baseCmd += ` --add-header "DNT:1"`

  // Configurações específicas por tentativa
  if (attempt >= 2) {
    baseCmd += ` --force-ipv4 --no-warnings`
  }

  if (attempt >= 3) {
    baseCmd += ` --ignore-errors --no-abort-on-error`
  }

  return baseCmd
}

// 🎯 MÚLTIPLAS ESTRATÉGIAS DE FORMATO
function getFormatStrategies(format, quality) {
  const strategies = []

  if (format === "mp3") {
    const q = Number.parseInt(quality || "128")
    strategies.push(
      `bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/best`,
      `bestaudio[abr<=${q}]/bestaudio/best`,
      `best[ext=m4a]/best[ext=mp3]/best`,
      `worst[ext=m4a]/worst[ext=mp3]/worst`,
    )
  } else {
    const q = Number.parseInt(quality || "720")
    strategies.push(
      `bestvideo[height<=${q}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${q}][ext=mp4]`,
      `bestvideo[height<=${q}]+bestaudio/best[height<=${q}]`,
      `best[height<=${q}][ext=mp4]/best[height<=${q}]`,
      `best[ext=mp4]/best`,
      `worst[ext=mp4]/worst`,
    )
  }

  return strategies
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
      }
    })
  } catch (error) {
    console.error("❌ Erro ao limpar arquivos:", error.message)
  }
}

setInterval(cleanupOldFiles, 30 * 60 * 1000)

// 🚀 ROTA PRINCIPAL COM MÚLTIPLAS TENTATIVAS E VERIFICAÇÃO DE INTEGRIDADE
app.post("/download", async (req, res) => {
  const startTime = Date.now()
  const requestId = `req_${startTime}_${Math.random().toString(36).substr(2, 9)}`

  console.log(`🎯 [${requestId}] Nova requisição iniciada`)

  try {
    const { url, format, quality } = req.body

    if (!url || !format) {
      return res.status(400).json({ error: "URL e formato são obrigatórios" })
    }

    console.log(`📋 [${requestId}] URL: ${url}`)
    console.log(`📋 [${requestId}] Formato: ${format} ${quality || "auto"}`)

    const uniqueId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const ext = format === "mp3" ? "mp3" : "mp4"

    // 🔄 MÚLTIPLAS TENTATIVAS COM DIFERENTES ESTRATÉGIAS
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`🚀 [${requestId}] Tentativa ${attempt}/3`)

      const userAgent = getRandomUserAgent()
      const baseCmd = getUltimateAntiDetectionCmd(userAgent, attempt)

      try {
        // Passo 1: Obter informações
        console.log(`📊 [${requestId}] Obtendo informações (tentativa ${attempt})...`)
        const infoCmd = `${baseCmd} --print "%(title)s|||%(duration)s|||%(ext)s" "${url}"`

        const { stdout: infoStdout, stderr: infoStderr } = await execAsync(infoCmd, {
          timeout: 45000,
          maxBuffer: 1024 * 1024,
        })

        if (infoStderr && infoStderr.includes("ERROR")) {
          throw new Error(`Info error: ${infoStderr}`)
        }

        const [title, duration, originalExt] = infoStdout.trim().split("|||")
        const safeTitle = safeFilename(title || "Unknown")

        console.log(`✅ [${requestId}] Info obtida: ${title}`)

        // 🎯 TENTAR MÚLTIPLAS ESTRATÉGIAS DE FORMATO
        const formatStrategies = getFormatStrategies(format, quality)

        for (let strategyIndex = 0; strategyIndex < formatStrategies.length; strategyIndex++) {
          const formatSelector = formatStrategies[strategyIndex]
          const filename = `${safeTitle}_${format}_${quality || "auto"}_${uniqueId}_s${strategyIndex}.${ext}`
          const outputPath = path.join(DOWNLOADS, filename)

          console.log(`🎬 [${requestId}] Tentando estratégia ${strategyIndex + 1}: ${formatSelector}`)

          try {
            let downloadCmd
            if (format === "mp3") {
              const q = Number.parseInt(quality || "128")
              downloadCmd = `${baseCmd} -f "${formatSelector}" --extract-audio --audio-format mp3 --audio-quality ${q}k --add-metadata -o "${outputPath}" "${url}"`
            } else {
              downloadCmd = `${baseCmd} -f "${formatSelector}" --merge-output-format mp4 --add-metadata -o "${outputPath}" "${url}"`
            }

            console.log(`⬇️ [${requestId}] Executando download...`)

            const { stdout: downloadStdout, stderr: downloadStderr } = await execAsync(downloadCmd, {
              timeout: 600000, // 10 minutos
              maxBuffer: 50 * 1024 * 1024,
            })

            // Verificar integridade do arquivo
            const integrity = verifyFileIntegrity(outputPath)

            if (integrity.valid) {
              const processingTime = Date.now() - startTime
              console.log(
                `✅ [${requestId}] SUCESSO! Arquivo válido: ${filename} (${(integrity.size / 1024 / 1024).toFixed(2)}MB)`,
              )

              return res.json({
                success: true,
                file: `/downloads/${filename}`,
                filename: `${safeTitle}.${ext}`,
                size: integrity.size,
                title: title,
                duration: duration,
                processing_time: processingTime,
                attempt: attempt,
                strategy: strategyIndex + 1,
                request_id: requestId,
              })
            } else {
              console.log(`❌ [${requestId}] Arquivo inválido (${integrity.reason}), tentando próxima estratégia...`)
              // Limpar arquivo inválido
              if (fs.existsSync(outputPath)) {
                fs.unlinkSync(outputPath)
              }
            }
          } catch (strategyError) {
            console.log(`❌ [${requestId}] Estratégia ${strategyIndex + 1} falhou: ${strategyError.message}`)
            // Limpar arquivo parcial
            if (fs.existsSync(outputPath)) {
              try {
                fs.unlinkSync(outputPath)
              } catch {}
            }
          }
        }
      } catch (attemptError) {
        console.log(`❌ [${requestId}] Tentativa ${attempt} falhou: ${attemptError.message}`)

        if (attempt === 3) {
          // Última tentativa - retornar erro
          return res.status(500).json({
            error: "Todas as tentativas falharam",
            details: attemptError.message.substring(0, 200),
            request_id: requestId,
            attempts: 3,
          })
        }

        // Aguardar antes da próxima tentativa
        await new Promise((resolve) => setTimeout(resolve, attempt * 2000))
      }
    }
  } catch (error) {
    console.error(`❌ [${requestId}] Erro geral:`, error)
    res.status(500).json({
      error: "Erro interno do servidor",
      request_id: requestId,
    })
  }
})

// Outras rotas mantidas...
app.get("/downloads/:file", (req, res) => {
  const filePath = path.join(DOWNLOADS, req.params.file)

  if (fs.existsSync(filePath)) {
    const stats = fs.statSync(filePath)

    // Verificar integridade antes de enviar
    const integrity = verifyFileIntegrity(filePath)
    if (!integrity.valid) {
      console.error("❌ Arquivo corrompido detectado:", req.params.file)
      return res.status(404).json({ error: "Arquivo corrompido" })
    }

    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(req.params.file)}"`)
    res.setHeader("Content-Type", "application/octet-stream")
    res.setHeader("Content-Length", stats.size)
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate")

    console.log("✅ Enviando arquivo verificado:", req.params.file, `(${(stats.size / 1024 / 1024).toFixed(2)} MB)`)
    res.sendFile(filePath)
  } else {
    res.status(404).json({ error: "Arquivo não encontrado" })
  }
})

app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    version: "3.0.0 - Bulletproof Edition",
    timestamp: new Date().toISOString(),
    features: [
      "Multiple retry attempts",
      "File integrity verification",
      "Multiple format strategies",
      "Advanced anti-detection",
    ],
  })
})

app.get("/files", (req, res) => {
  try {
    const files = fs.readdirSync(DOWNLOADS).map((file) => {
      const filePath = path.join(DOWNLOADS, file)
      const stats = fs.statSync(filePath)
      const integrity = verifyFileIntegrity(filePath)

      return {
        name: file,
        size: stats.size,
        size_mb: (stats.size / 1024 / 1024).toFixed(2),
        created: stats.birthtime,
        age_minutes: Math.floor((Date.now() - stats.birthtime.getTime()) / 60000),
        integrity: integrity.valid ? "✅ Valid" : `❌ ${integrity.reason}`,
      }
    })

    res.json({
      files,
      total_files: files.length,
      valid_files: files.filter((f) => f.integrity.includes("✅")).length,
      total_size_mb: files.reduce((sum, f) => sum + Number.parseFloat(f.size_mb), 0).toFixed(2),
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

app.get("/", (req, res) => {
  res.json({
    message: "🎌 WaifuConvert Backend - Bulletproof Edition",
    version: "3.0.0",
    status: "online",
    features: [
      "✅ Multiple retry attempts (3x)",
      "✅ File integrity verification",
      "✅ Multiple format strategies (5x)",
      "✅ Advanced anti-detection",
      "✅ Corruption prevention",
    ],
  })
})

app.listen(PORT, () => {
  console.log("🚀 WaifuConvert Backend - BULLETPROOF EDITION")
  console.log(`🌐 Porta: ${PORT}`)
  console.log("🛡️ Recursos ativados:")
  console.log("  ✅ 3 tentativas por requisição")
  console.log("  ✅ 5 estratégias de formato por tentativa")
  console.log("  ✅ Verificação de integridade de arquivo")
  console.log("  ✅ Anti-detecção avançado")
  console.log("  ✅ Prevenção de corrupção")

  cleanupOldFiles()
})

process.on("uncaughtException", (error) => {
  console.error("❌ Erro não capturado:", error)
})

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Promise rejeitada:", reason)
})
process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Promise rejeitada:", reason)
})
