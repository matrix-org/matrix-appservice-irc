# Builder
FROM node:10-slim as builder

RUN apt-get update \
 && apt-get install -y git python build-essential libicu-dev

RUN git clone https://github.com/matrix-org/freebindfree.git \
 && cd freebindfree \
 && make

COPY ./package.json ./package.json
RUN npm install

# App
FROM node:10-slim

RUN apt-get update \
 && apt-get install -y sipcalc iproute2 --no-install-recommends \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir app

WORKDIR /app

COPY --from=builder /node_modules /app/node_modules
COPY --from=builder /freebindfree/libfreebindfree.so /app/libfreebindfree.so

COPY app.js /app/
COPY lib /app/lib
COPY docker /app/docker

ENV LD_PRELOAD /app/libfreebindfree.so

ENTRYPOINT ["/app/docker/start.sh"]
