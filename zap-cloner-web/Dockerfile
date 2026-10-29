FROM node:20-slim
# git é necessário porque o Baileys baixa uma dependência direto do GitHub
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
