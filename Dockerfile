FROM node:18-alpine

WORKDIR /usr/src/app

# install dependencies (production)
COPY package.json package-lock.json* ./
RUN npm install --production --silent || true

# copy app
COPY . .

EXPOSE 3000

CMD ["npm", "start"]
