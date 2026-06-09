FROM node:20-slim

# Install Tailscale and required tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl iptables iproute2 ca-certificates \
    && curl -fsSL https://tailscale.com/install.sh | sh \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY public ./public
COPY server.js .
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080

CMD ["/entrypoint.sh"]
