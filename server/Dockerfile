FROM mhart/alpine-node:20
WORKDIR /app

COPY package-docker.json ./package.json

RUN yarn install

FROM mhart/alpine-node:slim-20
WORKDIR /app

COPY --from=0 /app .
COPY ./dist .

EXPOSE 80
CMD [ "node", "index.js" ]

