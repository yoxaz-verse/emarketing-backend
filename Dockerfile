# ---------- Builder stage ----------
FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# ---------- Runtime stage ----------
FROM node:24-alpine

RUN apk add --no-cache curl

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/src ./src

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=20s \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/ping" || exit 1

CMD ["npm", "run", "start"]
