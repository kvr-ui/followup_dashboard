# syntax=docker/dockerfile:1

# ============================================================
# Stage 1 — build the React (Vite) frontend
# ============================================================
FROM node:22-alpine AS frontend-build
WORKDIR /app/frontend

# Install deps (cached unless package files change)
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

# Build -> /app/frontend/dist
COPY frontend/ ./
RUN npm run build


# ============================================================
# Stage 2 — backend runtime (serves API + built frontend)
# ============================================================
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app/backend

# Production dependencies only
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

# Backend source
COPY backend/ ./

# Bring in the built frontend at ../frontend/dist (app.js serves this path)
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist

# Run as the built-in non-root user
USER node

ENV PORT=7007
EXPOSE 7007

# Basic container healthcheck against the /health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7007)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
