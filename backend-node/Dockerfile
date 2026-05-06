FROM node:22-bookworm-slim AS deps

WORKDIR /app/backend-node

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
  PORT=5679

WORKDIR /app/backend-node

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/backend-node/node_modules ./node_modules
COPY . .

RUN mkdir -p configs data logs

EXPOSE 5679

CMD ["npm", "start"]
