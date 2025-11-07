FROM node:18-bullseye-slim

RUN apt-get update && apt-get install -y \
    python3.11 \
    python3-pip \
    ffmpeg \
    curl \
    wget \
    && rm -rf /var/lib/apt/lists/*

RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1

# Atualizar pip primeiro
RUN python3 -m pip install --upgrade pip

# Instalar yt-dlp (sem a flag --break-system-packages)
RUN pip3 install yt-dlp

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
