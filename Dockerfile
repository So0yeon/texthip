# READ ME — onpod 배포용 (서버에서 빌드됨)
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js index.html ./
COPY assets ./assets
EXPOSE 8080
CMD ["node", "server.js"]
