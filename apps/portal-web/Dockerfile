FROM node:22-slim AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY services/identity/package.json services/identity/
COPY services/attendance/package.json services/attendance/
COPY apps/portal-web/package.json apps/portal-web/
RUN npm ci
COPY apps/portal-web apps/portal-web
ARG NEXT_PUBLIC_MAP_TILE_URL
ARG NEXT_PUBLIC_MAP_TILE_API_KEY
ARG NEXT_PUBLIC_MAP_TILE_ATTRIBUTION
ENV NEXT_PUBLIC_MAP_TILE_URL=$NEXT_PUBLIC_MAP_TILE_URL \
    NEXT_PUBLIC_MAP_TILE_API_KEY=$NEXT_PUBLIC_MAP_TILE_API_KEY \
    NEXT_PUBLIC_MAP_TILE_ATTRIBUTION=$NEXT_PUBLIC_MAP_TILE_ATTRIBUTION
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w @platform/portal-web

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /repo/apps/portal-web/.next/standalone ./
COPY --from=build /repo/apps/portal-web/.next/static apps/portal-web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/portal-web/server.js"]
