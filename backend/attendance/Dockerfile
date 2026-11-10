FROM node:22-slim AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY backend/identity/package.json backend/identity/
COPY backend/attendance/package.json backend/attendance/
COPY frontend/portal-web/package.json frontend/portal-web/
RUN npm ci
COPY backend/attendance backend/attendance
RUN npm run build -w @platform/attendance

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY backend/identity/package.json backend/identity/
COPY backend/attendance/package.json backend/attendance/
COPY frontend/portal-web/package.json frontend/portal-web/
RUN npm ci --omit=dev -w @platform/attendance
COPY --from=build /repo/backend/attendance/dist backend/attendance/dist
USER node
EXPOSE 3002
CMD ["node", "backend/attendance/dist/main.js"]
