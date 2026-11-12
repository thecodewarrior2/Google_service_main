# S.P.R.U.C.E Mail Protection Service (Cloud Run). One image, two services: ROLE=worker and ROLE=admin
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
# The AI model (phish-tiny) from TinyPhishLLM, its own public repository, at the commit VENDOR.json pins,
# each file checked against its SHA-256 (tools/fetch-model.js): the build stops if a file differs or can't
# be downloaded. Files already here with the right SHA-256 are kept. Nothing is downloaded at run time.
COPY tools/fetch-model.js ./tools/fetch-model.js
RUN node tools/fetch-model.js && rm -rf tools
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
