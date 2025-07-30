const express = require("express")
const cors = require("cors")
const { exec } = require("child_process")
const fs = require("fs")
const path = require("path")

const app = express()
const PORT = process.env.PORT || 8080
const DOWNLOADS = path.join(__dirname, "downloads")
const ytDlpPath = "yt-dlp"

// User-Agents simples
const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
]

app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "https://waifuconvert.com",
      "https://www.waifuconvert.com",
      "https://waifuconvert.vercel.app",
    ],
    credentials: true,
  }),
)

app.use(express.json())
app.use("/downloads", express.static(DOWNLOADS))

if (!fs.existsSync(DOWNLOADS)) {
  fs.mkdirSync(DOWNLOADS, { recursive: true })
}

function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)]
}

function safeFilename(str) {
  return (str || "WaifuConvert")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "_")
    .trim()
    .substring(0, 60)
}

// Comando simples que funciona
function getSimpleCmd(userAgent) {
  return `${ytDlpPath} --user-agent "${userAgent}" --no-playlist --extractor-retries 3 --fragment-retries 3`
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
      }
    })
  } catch (error) {
    console.error("Erro ao limpar arquivos:", error.message)
  }
}

setInterval(cleanupOldFiles, 30 * 60 * 1000)

// ROTA PRINCIPAL SIMPLES
app.post("/download", async (req, res) => {
  const startTime = Date.now()

  try {
    const { url, format, quality } = req.body

    if (!url || !format) {
      return res.status(400).json({ error: "URL e formato são obrigatórios" })
    }

    console.log("🚀 Download:", { url, format, quality })

    const uniqueId = Date.now()
    const ext = format === "mp3" ? "mp3" : "mp4"
    const filename = `download_${uniqueId}.${ext}`
    const outputPath = path.join(DOWNLOADS, filename)

    const userAgent = getRandomUserAgent()
    const baseCmd = getSimpleCmd(userAgent)

    let downloadCmd
    if (format === "mp3") {
      const q = Number.parseInt(quality || "128")
      downloadCmd = `${baseCmd} -f "bestaudio" --extract-audio --audio-format mp3 --audio-quality ${q}k -o "${outputPath}" "${url}"`
    } else {
      downloadCmd = `${baseCmd} -f "best[height<=720]" -o "${outputPath}" "${url}"`
    }

    console.log("Executando:", downloadCmd)

    exec(downloadCmd, { timeout: 300000 }, (error, stdout, stderr) => {
      if (error) {
        console.error("Erro:", stderr)
        return res.status(500).json({ error: "Falha no download" })
      }

      if (!fs.existsSync(outputPath)) {
        return res.status(500).json({ error: "Arquivo não foi criado" })
      }

      const stats = fs.statSync(outputPath)
      if (stats.size < 1000) {
        return res.status(500).json({ error: "Arquivo muito pequeno" })
      }

      console.log("✅ Sucesso:", filename)

      res.json({
        success: true,
        file: `/downloads/${filename}`,
        filename: filename,
        size: stats.size,
        processing_time: Date.now() - startTime,
      })
    })
  } catch (error) {
    console.error("Erro geral:", error)
    res.status(500).json({ error: "Erro interno" })
  }
})

app.get("/downloads/:file", (req, res) => {
  const filePath = path.join(DOWNLOADS, req.params.file)
  if (fs.existsSync(filePath)) {
    res.setHeader("Content-Disposition", `attachment; filename="${req.params.file}"`)
    res.sendFile(filePath)
  } else {
    res.status(404).json({ error: "Arquivo não encontrado" })
  }
})

app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    version: "SIMPLE",
    timestamp: new Date().toISOString(),
  })
})

app.get("/", (req, res) => {
  res.json({
    message: "🎌 WaifuConvert Backend - SIMPLE VERSION",
    status: "FUNCIONANDO",
  })
})

app.listen(PORT, () => {
  console.log("🚀 WaifuConvert Backend SIMPLES rodando na porta:", PORT)
  cleanupOldFiles()
})
