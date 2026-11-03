# Private-research temporary container. Attach a persistent Railway volume at /data.
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY . /app
RUN node --check collector/research-cloud-worker.mjs && node --check collector/orchestrate.mjs
CMD ["node", "collector/research-cloud-worker.mjs"]
