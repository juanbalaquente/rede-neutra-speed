FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci -w apps/api --include-workspace-root=false
COPY tsconfig.base.json ./
COPY apps/api apps/api
RUN npm run build -w apps/api

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci -w apps/api --omit=dev --include-workspace-root=false
COPY --from=build /app/apps/api/dist apps/api/dist
COPY apps/api/drizzle apps/api/drizzle
WORKDIR /app/apps/api
EXPOSE 3001
# O seed é idempotente: cria planos e admin só se faltarem.
CMD ["sh", "-c", "node dist/scripts/migrate.js && node dist/scripts/seed.js && node dist/server.js"]
