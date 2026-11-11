# S.P.R.U.C.E+ Mail Protection (Cloud Run). One image, two services: ROLE=worker and ROLE=admin
# (docs/DEPLOY.md).
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
# .npmrc: the native AI engine (onnxruntime-node) installs without downloading GPU libraries. Only its
# Linux x64 files are kept (its package carries every system's: about 250 MB more).
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev \
    && find node_modules/onnxruntime-node/bin -mindepth 2 -maxdepth 2 ! -path '*/linux' -exec rm -rf {} + \
    && rm -rf node_modules/onnxruntime-node/bin/*/linux/arm64 \
    && npm cache clean --force
COPY src ./src
COPY public ./public
COPY vendor ./vendor
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
