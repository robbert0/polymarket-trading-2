FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist/apps/bull-board ./

EXPOSE 3100

CMD ["node", "main.js"]
