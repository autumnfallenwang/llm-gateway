FROM node:26-alpine

WORKDIR /app

# Build deps for better-sqlite3 native module — installed transient, removed in same RUN to keep image slim.
RUN apk add --no-cache --virtual .build python3 make g++

COPY package.json package-lock.json ./
RUN npm ci && apk del .build

COPY tsconfig.json ./
COPY src/ src/

USER node
CMD ["npm", "start"]
