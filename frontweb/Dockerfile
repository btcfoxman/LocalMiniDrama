FROM node:22-bookworm-slim AS builder

WORKDIR /app/frontweb

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM nginx:stable-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/frontweb/dist /usr/share/nginx/html

EXPOSE 80
