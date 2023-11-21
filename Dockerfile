FROM node:18-slim
ENV NODE_ENV "production"
ENV NPM_CONFIG_PREFIX=/home/node/.npm-global
ENV PATH=$PATH:/home/node/.npm-global/bin
USER node

WORKDIR /usr/src/app
COPY package.json .
RUN npm install -g npm@10.2.4
RUN npm install --omit=dev
COPY . .
CMD "node" "index.js"
