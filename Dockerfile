FROM node:20-bookworm-slim

# Instalar dependências do sistema
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    curl \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Criar e ativar ambiente virtual Python
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Atualizar pip no ambiente virtual
RUN pip install --upgrade pip

# Instalar yt-dlp no ambiente virtual
RUN pip install -U yt-dlp

# Verificar instalação
RUN yt-dlp --version

# Criar diretório da aplicação
WORKDIR /app

# Copiar package.json primeiro (para cache de dependências)
COPY package*.json ./

# Instalar dependências Node.js
RUN npm install --production

# Copiar código da aplicação
COPY . .

# Criar diretórios necessários
RUN mkdir -p downloads temp cookies

# Variáveis de ambiente para otimização de memória
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=256 --expose-gc"

# Expor porta
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

# Comando para iniciar (usa node direto, não npm)
CMD ["node", "index.js"]
