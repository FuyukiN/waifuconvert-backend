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

# Comando para iniciar
CMD ["npm", "start"]
