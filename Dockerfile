# S.P.R.U.C.E+ Mail Protection (Cloud Run). One image, two services: ROLE=worker and ROLE=admin
# (docs/DEPLOY.md).
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY vendor ./vendor
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
