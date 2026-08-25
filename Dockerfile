# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY webview-ui/package.json webview-ui/package.json
RUN npm ci

COPY . .
RUN npm run package

FROM node:22-bookworm-slim AS production-dependencies
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY webview-ui/package.json webview-ui/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PIXEL_AGENTS_DEBUG=0
WORKDIR /app

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json

USER node
VOLUME ["/home/node/.pixel-agents"]
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--provider", "hermes", "--host", "0.0.0.0", "--port", "3000"]
