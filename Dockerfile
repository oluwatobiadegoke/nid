FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN pnpm install --frozen-lockfile
COPY packages ./packages
RUN pnpm --filter nid-inbox build && pnpm --filter nid-inbox deploy --prod --legacy /app

FROM node:22-alpine
ENV NODE_ENV=production \
    NID_HOST=0.0.0.0 \
    NID_PORT=4400 \
    NID_SMTP_PORT=1025
WORKDIR /app
COPY --from=build /app /app
USER node
EXPOSE 4400 1025
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 CMD ["node", "dist/cli.js", "healthcheck"]
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve"]
