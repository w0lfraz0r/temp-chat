FROM node:22-alpine AS development
WORKDIR /workspace
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN npm ci
COPY . .
CMD ["npm", "run", "dev"]

FROM development AS build
RUN npm run build

FROM node:22-alpine AS api
ENV NODE_ENV=production
WORKDIR /workspace
COPY --from=build /workspace/package*.json ./
COPY --from=build /workspace/apps/api/package.json apps/api/package.json
COPY --from=build /workspace/apps/web/package.json apps/web/package.json
COPY --from=build /workspace/packages/protocol/package.json packages/protocol/package.json
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /workspace/apps/api/dist apps/api/dist
COPY --from=build /workspace/apps/api/migrations apps/api/migrations
COPY --from=build /workspace/packages/protocol/dist packages/protocol/dist
USER node
EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]
