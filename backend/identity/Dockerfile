FROM node:22-slim AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY backend/identity/package.json backend/identity/
COPY backend/attendance/package.json backend/attendance/
COPY frontend/portal-web/package.json frontend/portal-web/
RUN npm ci
COPY backend/identity backend/identity
RUN npm run build -w @platform/identity

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY backend/identity/package.json backend/identity/
COPY backend/attendance/package.json backend/attendance/
COPY frontend/portal-web/package.json frontend/portal-web/
RUN npm ci --omit=dev -w @platform/identity
COPY --from=build /repo/backend/identity/dist backend/identity/dist
USER node
EXPOSE 3001
CMD ["node", "backend/identity/dist/main.js"]
