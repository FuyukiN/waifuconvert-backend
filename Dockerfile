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

# Instalar yt-dlp COM suporte a JavaScript runtime (yt-dlp-ejs incluso)
RUN pip install -U "yt-dlp[default]"

# Instalar yt-dlp-ejs explicitamente e verificar
RUN pip install --no-cache-dir -U yt-dlp-ejs && python3 -c "import yt_dlp_ejs; print('yt-dlp-ejs OK')"

# Verificar instalação
RUN yt-dlp --version

# Criar diretório da aplicação
WORKDIR /app

# Copiar package.json
COPY package*.json ./

# Instalar dependências Node.js
RUN npm install --production

# Copiar código da aplicação
COPY . .

# Criar diretorios necessarios
RUN mkdir -p downloads temp cookies

# Expor porta
EXPOSE 8080

# Comando para iniciar com GC exposto para limpeza de memoria
CMD ["node", "--expose-gc", "--max-old-space-size=256", "index.js"]
