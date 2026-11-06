FROM node:22-slim AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY services/identity/package.json services/identity/
COPY services/attendance/package.json services/attendance/
COPY apps/portal-web/package.json apps/portal-web/
RUN npm ci
COPY services/identity services/identity
RUN npm run build -w @platform/identity

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY services/identity/package.json services/identity/
COPY services/attendance/package.json services/attendance/
COPY apps/portal-web/package.json apps/portal-web/
RUN npm ci --omit=dev -w @platform/identity
COPY --from=build /repo/services/identity/dist services/identity/dist
USER node
EXPOSE 3001
CMD ["node", "services/identity/dist/main.js"]
