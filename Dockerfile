FROM node:18-bullseye-slim

# Instalar dependências do sistema
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Instalar yt-dlp via pip (funciona no Linux)
RUN pip3 install --break-system-packages yt-dlp

# Verificar se foi instalado
RUN yt-dlp --version

# Criar diretório da aplicação
WORKDIR /app

# Copiar package.json
COPY package*.json ./

# Instalar dependências Node.js
RUN npm install --production

# Copiar código da aplicação
COPY . .

# Criar diretórios necessários
RUN mkdir -p downloads temp

# Expor porta
EXPOSE 8080

# Comando para iniciar
CMD ["npm", "start"]
