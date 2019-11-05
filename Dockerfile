# Freebind build
# node:12-slim uses debian:stretch-slim as a base, so it's safe to build on here.
FROM debian:stretch-slim as freebind 

RUN apt-get update \
 && apt-get install -y git build-essential

RUN git clone https://github.com/matrix-org/freebindfree.git
RUN cd freebindfree && make

# Typescript build
FROM node:12-slim as builder

WORKDIR /build

RUN apt-get update && apt-get install -y git python3 libicu-dev build-essential

COPY . /build/

RUN npm ci
RUN npm run build

# App
FROM node:12-slim

RUN apt-get update && apt-get install -y sipcalc iproute2 openssl --no-install-recommends
RUN rm -rf /var/lib/apt/lists/*
RUN mkdir app

WORKDIR /app
RUN mkdir ./data

COPY --from=freebind /freebindfree/libfreebindfree.so /app/libfreebindfree.so
COPY --from=builder /build/node_modules /app/node_modules
COPY --from=builder /build/lib /app/lib

COPY app.js /app/
COPY docker /app/docker

ENV LD_PRELOAD /app/libfreebindfree.so

ENTRYPOINT ["/app/docker/start.sh"]
