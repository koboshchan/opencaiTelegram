FROM node:lts-alpine

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm install

COPY . .
RUN npm run build

CMD ["node", "dist/index.js"]
