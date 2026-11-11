FROM node:24-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
COPY library/package.json library/package.json
COPY demo/package.json demo/package.json
RUN npm ci

COPY library/ library/
COPY demo/ demo/
ARG NEXT_PUBLIC_SIGNALING_URL=ws://localhost:8080/ws
ENV NEXT_PUBLIC_SIGNALING_URL=$NEXT_PUBLIC_SIGNALING_URL
ENV SHADOWCAST_STANDALONE=1
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/demo/.next/standalone/ ./
COPY --from=build --chown=node:node /app/demo/.next/static/ ./demo/.next/static/
COPY --from=build --chown=node:node /app/demo/public/ ./demo/public/
USER node
EXPOSE 3000
CMD ["node", "demo/server.js"]
