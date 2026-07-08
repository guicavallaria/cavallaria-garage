FROM node:20-slim

RUN apt-get update && apt-get install -y \
  chromium \
  fonts-liberation \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdbus-1-3 \
  libgdk-pixbuf2.0-0 \
  libnspr4 \
  libnss3 \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  xdg-utils \
  python3 \
  make \
  g++ \
  --no-install-recommends && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

# Chrome for Testing (versão estável testada pelo Puppeteer). O chromium 150 do
# Debian trava com SIGTRAP (exit 133) neste runtime, independente de flags/headless.
# Mantemos o pacote apt "chromium" acima só pelas libs de runtime; usamos este binário.
RUN npx -y @puppeteer/browsers install chrome@stable --path /opt/chrome \
  && ln -sf "$(find /opt/chrome -type f -name chrome | head -n1)" /usr/local/bin/chrome-stable \
  && /usr/local/bin/chrome-stable --version

COPY . .

ENV NODE_ENV=production
ENV CHROME_PATH=/usr/local/bin/chrome-stable
ENV DATA_DIR=/data

RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "server.js"]
