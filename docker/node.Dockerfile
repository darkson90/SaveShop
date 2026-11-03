# Immagine unica per tutti i microservizi Node: docker build --build-arg SERVICE=list .
FROM node:22-alpine AS build
ARG SERVICE
WORKDIR /repo
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages ./packages
COPY services/${SERVICE} ./services/${SERVICE}
RUN npm install --workspaces --include-workspace-root=false --no-audit --no-fund \
 && npm run build -w @spesa/common \
 && npm run build -w services/${SERVICE} \
 && npm prune --omit=dev --workspaces

FROM node:22-alpine
ARG SERVICE
ENV NODE_ENV=production PORT=3000
WORKDIR /repo
COPY --from=build /repo /repo
WORKDIR /repo/services/${SERVICE}
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
