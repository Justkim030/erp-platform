FROM node:22-slim AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY services/identity/package.json services/identity/
COPY services/attendance/package.json services/attendance/
COPY apps/portal-web/package.json apps/portal-web/
RUN npm ci
COPY services/attendance services/attendance
RUN npm run build -w @platform/attendance

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY services/identity/package.json services/identity/
COPY services/attendance/package.json services/attendance/
COPY apps/portal-web/package.json apps/portal-web/
RUN npm ci --omit=dev -w @platform/attendance
COPY --from=build /repo/services/attendance/dist services/attendance/dist
USER node
EXPOSE 3002
CMD ["node", "services/attendance/dist/main.js"]
