# NEARAuth agent service. Build from the repository root: docker build -f agent/Dockerfile .
FROM node:22-slim
WORKDIR /app
COPY extension/lib ./extension/lib
COPY tests/e2e/mock-simplelogin.js ./tests/e2e/mock-simplelogin.js
COPY agent/package.json agent/package-lock.json ./agent/
RUN cd agent && npm ci --omit=dev && npm install --no-save tsx@4
COPY agent/src ./agent/src
COPY agent/tsconfig.json ./agent/
WORKDIR /app/agent
USER node
ENV NEARAUTH_AGENT_HOST=0.0.0.0 NEARAUTH_DATA_DIR=/tmp/nearauth
EXPOSE 8787
CMD ["npx", "tsx", "src/server.ts"]
