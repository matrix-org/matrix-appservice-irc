# Freebind build
# node:14-slim uses debian:stretch-slim as a base, so it's safe to build on here.
FROM debian:stretch-slim as freebind 

RUN apt-get update \
 && apt-get install -y git build-essential

RUN git clone https://github.com/matrix-org/freebindfree.git
RUN cd freebindfree && make

# Typescript build
FROM node:14-slim as builder

WORKDIR /build

COPY src/ /build/src/ 
COPY .eslintrc *json /build/

RUN npm ci
RUN npm run build

# App
FROM node:14-slim

RUN apt-get update && apt-get install -y sipcalc iproute2 openssl --no-install-recommends
RUN rm -rf /var/lib/apt/lists/*
RUN mkdir app

WORKDIR /app
RUN mkdir ./data

COPY --from=freebind /freebindfree/libfreebindfree.so /app/libfreebindfree.so
COPY --from=builder /build/node_modules /app/node_modules
COPY --from=builder /build/package.json /app/package.json
COPY --from=builder /build/lib /app/lib

COPY app.js config.schema.yml /app/
COPY docker /app/docker

ENV LD_PRELOAD /app/libfreebindfree.so

ENTRYPOINT ["/app/docker/start.sh"]
